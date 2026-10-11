#!/usr/bin/env node
// pnpm ai:session-hour: measure what one hour of a session costs with a real provider (B05 week 13, day 4).
//
//   node --env-file=.env.local tools/ai-eval/src/session-hour.mjs --provider anthropic [--narratives 12] [--chats 25] [--yes] [--max-usd 1]
//
// Replays 12 narratives and 25 chat turns against recorded fixtures. It prints an estimate first and sends nothing until
// you pass --yes. The result is compared with the plan's estimate for the recommended stack (A05 section 3).
import { writeFileSync } from 'node:fs';
import {
  AnthropicAdapter,
  answerChat,
  GeminiAdapter,
  generateNarrative,
  LlmRouter,
  OpenAiAdapter,
  PriceTable,
} from '@smc/ai';
import { makeFixtures } from './fixtures.mjs';

const PLAN_ESTIMATE_PER_HOUR_USD = { low: 0.196, high: 0.253 }; // A05 section 3, stack S2r (list prices, thinking 1.0x to 1.5x)

const QUESTIONS = [
  'What is the bias on this chart right now?',
  'What does the current setup mean?',
  'Where would this idea be invalidated?',
  'What is a fair value gap?',
  'Explain what an order block is.',
  'What is liquidity and why does price seek it?',
  'Why is this setup graded the way it is?',
  'What does the engine say about the higher timeframe?',
  'What is the difference between a BOS and a CHoCH?',
  'Which zone is the point of interest here?',
  'What happened at the sweep?',
  'What are the risks in this analysis?',
  'Is the data fresh at the moment?',
  'What is the alternate scenario?',
  'How does the killzone affect this?',
  'What is premium and discount?',
  'What should I look at on the lower timeframe?',
  'Explain the current plan in simple words.',
  'What would weaken the current bias?',
  'What is equal highs liquidity?',
  'Summarise the current analysis briefly.',
  'What does the target represent?',
  'How was the invalidation chosen?',
  'What is a mitigation block?',
  'Walk me through the scenarios again.',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const MODELS = {
  anthropic: [
    'ANTHROPIC_MODEL_FAST',
    'ANTHROPIC_MODEL_STRONG',
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
  ],
  openai: ['OPENAI_MODEL_FAST', 'OPENAI_MODEL_STRONG'],
  gemini: ['GEMINI_MODEL_FAST', 'GEMINI_MODEL_STRONG'],
};

export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const provider = String(args.provider ?? 'anthropic');
  if (!KEY[provider]) throw new Error('unknown provider');
  if (!env[KEY[provider]]) throw new Error(`${KEY[provider]} is not set`);
  const [fk, sk, fd, sd] = MODELS[provider];
  const fast = env[fk] || fd;
  const strong = env[sk] || sd || fast;
  if (!fast && !strong) throw new Error(`set ${sk} to the model id you want to measure`);
  const prices = PriceTable.parse(env.AI_PRICES_JSON);
  const nNarr = Number(args.narratives ?? 12);
  const nChat = Number(args.chats ?? 25);
  const price = (m, i, o) => (i * prices.priceOf(m).in + o * prices.priceOf(m).out) / 1e6;
  const estimate =
    nNarr * price(strong ?? fast, 2500, 500) + nChat * price(strong ?? fast, 2200, 350);
  console.log(
    `Session-hour replay on ${provider} (${fast ?? '-'} / ${strong ?? '-'}): ${nNarr} narratives and ${nChat} chat turns.`,
  );
  console.log(
    `Estimated cost: about $${estimate.toFixed(3)}${prices.known(strong ?? fast) ? '' : ' (no configured price for the model: conservative fallback rate used)'}. Cap: $${Number(args['max-usd'] ?? 1).toFixed(2)}.`,
  );
  if (!args.yes) {
    console.log('Nothing was sent. Re-run with --yes to spend it.');
    return { dryRun: true, estimateUsd: estimate };
  }

  const f = (url, init) => fetch(url, init);
  const state = {
    id: provider,
    enabled: true,
    apiKey: env[KEY[provider]],
    priority: 1,
    dataClasses: ['D0', 'D2'],
    models: { fast: fast ?? strong, strong: strong ?? fast },
  };
  const byJob = new Map();
  const router = new LlmRouter({
    source: { providers: async () => [state] },
    adapters: {
      anthropic: new AnthropicAdapter(f),
      openai: new OpenAiAdapter(f),
      gemini: new GeminiAdapter(f),
    },
    prices,
    onCall: (r) => {
      const j = byJob.get(r.job) ?? { calls: 0, cost: 0, latency: [] };
      j.calls++;
      j.cost += r.costUsd;
      j.latency.push(r.latencyMs);
      byJob.set(r.job, j);
    },
  });
  const cap = Number(args['max-usd'] ?? 1);
  const total = () => [...byJob.values()].reduce((s, j) => s + j.cost, 0);
  const facts = makeFixtures(Math.max(nNarr, 12));
  for (const fx of facts.slice(0, nNarr)) {
    if (total() >= cap) break;
    await generateNarrative(router, fx, 2);
  }
  for (let i = 0; i < nChat; i++) {
    if (total() >= cap) break;
    await answerChat(router, {
      text: QUESTIONS[i % QUESTIONS.length],
      inputMode: 'text',
      history: [],
      facts: facts[i % facts.length],
      precision: 2,
      soft: false,
    });
  }
  const cost = total();
  const rows = [...byJob].map(
    ([job, j]) =>
      `| ${job} | ${j.calls} | $${j.cost.toFixed(4)} | ${[...j.latency].sort((a, b) => a - b)[Math.floor(j.latency.length * 0.95)] ?? '-'} ms |`,
  );
  const ratioLow = cost / PLAN_ESTIMATE_PER_HOUR_USD.high;
  const ratioHigh = cost / PLAN_ESTIMATE_PER_HOUR_USD.low;
  const report = [
    `# Measured cost of one session-hour (${provider})`,
    '',
    `Models: ${fast} / ${strong}. Workload: ${nNarr} narratives, ${nChat} chat turns (no sharing of narratives, so this is the conservative case).`,
    '',
    '| Job | Calls | Cost | p95 latency |',
    '|---|---|---|---|',
    ...rows,
    '',
    `**Total: $${cost.toFixed(4)} per session-hour.** The plan estimated $${PLAN_ESTIMATE_PER_HOUR_USD.low} to $${PLAN_ESTIMATE_PER_HOUR_USD.high} for the recommended stack at list prices (${ratioLow.toFixed(2)}x to ${ratioHigh.toFixed(2)}x of it). The acceptance bar is within 1.5x of the estimate.`,
    '',
  ].join('\n');
  console.log(report);
  if (args.report) writeFileSync(String(args.report), report);
  return { cost, report };
}

if (process.argv[1]?.endsWith('session-hour.mjs')) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  });
}
