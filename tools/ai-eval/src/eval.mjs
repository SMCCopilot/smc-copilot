#!/usr/bin/env node
// pnpm ai:eval: evaluate the narrative pipeline against frozen fixtures (A05 section 14).
//
//   pnpm ai:eval                                         offline harness check (free, no network)
//   node --env-file=.env.local tools/ai-eval/src/eval.mjs --live --provider anthropic --judge openai --n 100 [--yes] [--max-usd 3]
//                                                        a real model, judged by a different vendor. Prints the cost
//                                                        estimate first and does nothing until you pass --yes.
//   add  --report docs/ai-eval-report.md                 write the report
//
// Build first (`pnpm build`): the tool imports the compiled packages.
import { writeFileSync } from 'node:fs';
import {
  AnthropicAdapter,
  GeminiAdapter,
  LlmRouter,
  NARRATIVE_PROMPT_VERSION,
  OpenAiAdapter,
  PriceTable,
} from '@smc/ai';
import { makeFixtures } from './fixtures.mjs';
import { offlineAdapter, renderReport, runNarrativeSuite, summarize, verdict } from './lib.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const MODEL = {
  anthropic: ['ANTHROPIC_MODEL_FAST', 'ANTHROPIC_MODEL_STRONG'],
  openai: ['OPENAI_MODEL_FAST', 'OPENAI_MODEL_STRONG'],
  gemini: ['GEMINI_MODEL_FAST', 'GEMINI_MODEL_STRONG'],
};
const DEFAULT_MODEL = { anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5'] };

function providerState(id, env) {
  const [fastK, strongK] = MODEL[id];
  const fast = env[fastK] || DEFAULT_MODEL[id]?.[0];
  const strong = env[strongK] || DEFAULT_MODEL[id]?.[1] || fast;
  return {
    id,
    enabled: true,
    apiKey: env[KEY[id]],
    priority: 1,
    dataClasses: ['D0', 'D2'],
    models: { fast: fast || strong, strong: strong || fast },
  };
}

function liveRouter(id, env, prices) {
  const f = (url, init) => fetch(url, init);
  const st = providerState(id, env);
  if (!st.apiKey) throw new Error(`${KEY[id]} is not set`);
  if (!st.models.strong) throw new Error(`set ${MODEL[id][1]} to the model id you want to test`);
  const adapters = {
    anthropic: new AnthropicAdapter(f),
    openai: new OpenAiAdapter(f),
    gemini: new GeminiAdapter(f),
  };
  return {
    router: new LlmRouter({ source: { providers: async () => [st] }, adapters, prices }),
    model: st.models.strong,
  };
}

const JUDGE_SYSTEM = `You check a short market commentary against the facts it was written from. Answer with one JSON object: {"faithful": boolean, "unsupported_claims": string[]}. faithful is true only if every claim in the commentary is supported by FACTS, the commentary invents no level, zone, setup, event or statistic, and it gives no instruction to trade and no certainty. Numbers in the commentary were substituted by software and are correct.`;

function makeJudge(router) {
  return async (facts, content) => {
    const text = [
      content.headline,
      content.bias_summary,
      ...content.scenarios.map((s) => s.if_then),
      ...content.risks_and_unknowns,
    ].join('\n');
    const r = await router.call(
      'J8_EVAL_JUDGE',
      {
        system: JUDGE_SYSTEM,
        user: `FACTS:\n${JSON.stringify({ htfBias: facts.htfBias, levels: facts.levels, zones: facts.zones, setups: facts.setups, warnings: facts.warnings, dataQuality: facts.dataQuality })}\n\nCOMMENTARY:\n${text}`,
        maxTokens: 300,
        json: true,
      },
      { dataClass: 'D0' },
    );
    try {
      const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
      return { faithful: j.faithful === true, costUsd: r.costUsd };
    } catch {
      return { faithful: false, costUsd: r.costUsd };
    }
  };
}

export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  const n = Number(args.n ?? 100);
  const fixtures = makeFixtures(n);
  const prices = PriceTable.parse(env.AI_PRICES_JSON);
  const when = new Date().toISOString();
  let router;
  let provider = 'offline stand-in';
  let model = '-';
  let judge = null;
  let judgeName = null;

  if (args.live) {
    provider = String(args.provider ?? 'anthropic');
    judgeName = args.judge ? String(args.judge) : null;
    if (judgeName === provider)
      throw new Error('the judge must be a different vendor from the model under test');
    const sut = liveRouter(provider, env, prices);
    router = sut.router;
    model = sut.model;
    const perNarr = (2500 * prices.priceOf(model).in + 500 * prices.priceOf(model).out) / 1e6;
    let est = perNarr * n;
    if (judgeName) {
      const j = liveRouter(judgeName, env, prices);
      judge = makeJudge(j.router);
      est += ((1500 * prices.priceOf(j.model).in + 150 * prices.priceOf(j.model).out) / 1e6) * n;
    }
    const known = prices.known(model)
      ? ''
      : ' (model has no configured price: using the conservative fallback rate, so the real cost is likely lower)';
    console.log(
      `Live run: ${n} narratives on ${provider}/${model}${judgeName ? `, judged by ${judgeName}` : ''}.`,
    );
    console.log(
      `Estimated cost: about $${est.toFixed(2)}${known}. Cap: $${Number(args['max-usd'] ?? 3).toFixed(2)}.`,
    );
    if (!args.yes) {
      console.log('Nothing was sent. Re-run with --yes to spend it.');
      return { dryRun: true, estimateUsd: est };
    }
  } else {
    router = new LlmRouter({
      source: {
        providers: async () => [
          {
            id: 'anthropic',
            enabled: true,
            apiKey: 'offline',
            priority: 1,
            dataClasses: ['D0'],
            models: { fast: 'offline', strong: 'offline' },
          },
        ],
      },
      adapters: { anthropic: offlineAdapter() },
      // The stand-in is free: price it at zero so the report does not show an invented cost.
      prices: new PriceTable({ offline: { in: 0, out: 0 } }),
      sleep: async () => {},
    });
  }

  const { rows } = await runNarrativeSuite({
    router,
    fixtures,
    judge,
    maxUsd: Number(args['max-usd'] ?? Number.POSITIVE_INFINITY),
  });
  const summary = summarize(rows);
  const v = verdict(summary, { live: Boolean(args.live) });
  const report = renderReport({
    title: args.live
      ? `AI narrative evaluation (${provider})`
      : 'AI narrative evaluation: harness check',
    mode: args.live ? 'live' : 'offline',
    provider,
    model,
    judge: judgeName,
    summary,
    verdict: v,
    promptVersion: NARRATIVE_PROMPT_VERSION,
    when,
  });
  console.log(report);
  if (args.report) writeFileSync(String(args.report), report);
  return { summary, verdict: v, report };
}

if (
  import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` ||
  process.argv[1]?.endsWith('eval.mjs')
) {
  main(process.argv.slice(2))
    .then((r) => {
      if (r?.verdict && !r.verdict.passed) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    });
}
