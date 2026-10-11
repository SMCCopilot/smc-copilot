// Evaluation helpers: an offline "model" for checking the harness, the metrics, and the report.
import { createHash } from 'node:crypto';
import {
  checkLexicon,
  formatPrice,
  generateNarrative,
  historyLine,
  templateNarrative,
} from '@smc/ai';

export const THRESHOLDS = {
  bannedReleased: 0,
  strayNumbersReleased: 0,
  refIntegrity: 1,
  faithful: 0.95,
  schemaFirstPass: 0.99,
};

const hash = (s) => Number.parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

/** Rebuilds the facts the prompt carried, so the offline model can answer from the template. */
function factsFromPrompt(user) {
  const json = user.slice(user.indexOf('FACTS:\n') + 7).split('\n\nYour previous answer')[0];
  const f = JSON.parse(json);
  return {
    ...f,
    asOf: Date.parse(f.asOf),
    instrumentId: f.instrument,
    strategyVersionId: 'x',
    setups: f.setups.map((s) => ({ ...s, stats: s.stats ? {} : null })),
  };
}

/**
 * A stand-in provider for checking the harness itself: it answers with the deterministic template, and corrupts a share of
 * first attempts (numbers, banned wording, unknown references) and a few answers on every attempt. It proves the
 * pipeline rejects bad output; it says nothing about any real model.
 */
export function offlineAdapter() {
  return {
    id: 'anthropic',
    async call({ req }) {
      const facts = factsFromPrompt(req.user);
      const retry = req.user.includes('Your previous answer was rejected');
      const mode = hash(req.user.split('\n\nYour previous answer')[0]) % 20;
      const out = templateNarrative(facts);
      let bad = null;
      if (mode <= 1 && !retry)
        bad = () => {
          out.headline = 'Price is sitting at 64020 now';
        };
      else if (mode <= 3 && !retry)
        bad = () => {
          out.bias_summary = 'You should buy now, this is guaranteed.';
        };
      else if (mode === 4 && !retry)
        bad = () => {
          out.bias_summary = 'See {{L:NOPE99}} for context.';
        };
      else if (mode === 5)
        bad = () => {
          out.headline = 'Target 65,500 is certain';
        };
      bad?.();
      return {
        text: JSON.stringify(out),
        usage: { tokensIn: 2400, tokensOut: 450, cachedIn: 0, cacheWrite: 0 },
      };
    },
  };
}

/** Every number in released text must come from the facts (formatted at the instrument's precision). */
export function numbersFromFacts(facts, precision) {
  const set = new Set();
  for (const l of facts.levels) set.add(formatPrice(l.price, precision));
  for (const z of facts.zones) {
    set.add(formatPrice(z.top, precision));
    set.add(formatPrice(z.bottom, precision));
  }
  return set;
}

const NUM = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2,}|\b\d{4,}\b/g;

export function releasedText(content) {
  return [
    content.headline,
    content.bias_summary,
    ...content.scenarios.map((s) => s.if_then),
    ...content.risks_and_unknowns,
    ...content.history.map((h) => h.text),
  ].join('\n');
}

/** Deterministic checks on one released narrative. */
export function checkReleased(content, facts, precision) {
  const allowed = numbersFromFacts(facts, precision);
  // Prose the model wrote (after substitution). History sentences are server-built and carry their own numbers.
  const prose = [
    content.headline,
    content.bias_summary,
    ...content.scenarios.map((s) => s.if_then),
    ...content.risks_and_unknowns,
  ].join(' ');
  const stray = [...prose.matchAll(NUM)].map((m) => m[0]).filter((n) => !allowed.has(n));
  const ids = new Set([
    ...facts.levels.map((l) => l.id),
    ...facts.zones.map((z) => z.id),
    ...facts.setups.map((s) => s.id),
    ...(facts.htfBias.lastBreak ? [facts.htfBias.lastBreak.id] : []),
  ]);
  const refs = [
    ...content.refs_used,
    ...content.scenarios.flatMap((s) => [s.invalidation_ref, ...s.key_refs]),
  ];
  const setupOk = content.scenarios.every((s) =>
    facts.setups.some((x) => x.id === s.setupId && x.invalidation === s.invalidation_ref),
  );
  const historyOk = content.history.every((h) => {
    const s = facts.setups.find((x) => x.id === h.setupId);
    return s && h.text === historyLine(s.stats);
  });
  return {
    banned: checkLexicon(prose).length,
    stray: stray.length,
    strayDetail: stray.slice(0, 3),
    badRefs: refs.filter((r) => !ids.has(r)).length,
    setupOk,
    historyOk,
    unresolvedPlaceholders: /{{|}}/.test(prose),
  };
}

export async function runNarrativeSuite({
  router,
  fixtures,
  precision = 2,
  judge = null,
  maxUsd = Number.POSITIVE_INFINITY,
}) {
  const rows = [];
  let spent = 0;
  for (const facts of fixtures) {
    if (spent >= maxUsd) break;
    const r = await generateNarrative(router, facts, precision);
    const cost = r.calls.reduce((s, c) => s + c.costUsd, 0);
    spent += cost;
    const checks = checkReleased(r.content, facts, precision);
    let faithful = null;
    if (judge && r.source === 'LLM') {
      const j = await judge(facts, r.content);
      faithful = j.faithful;
      spent += j.costUsd ?? 0;
    }
    rows.push({
      source: r.source,
      firstPass: r.source === 'LLM' && r.calls.length === 1,
      retried: r.source === 'LLM' && r.calls.length > 1,
      fallbackReason: r.fallbackReason ?? null,
      checks,
      faithful,
      cost,
    });
  }
  return { rows, spent };
}

export function summarize(rows) {
  const n = rows.length;
  const llm = rows.filter((r) => r.source === 'LLM');
  const judged = rows.filter((r) => r.faithful !== null);
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const bannedReleased = sum((r) => (r.checks.banned > 0 ? 1 : 0));
  const strayReleased = sum((r) => (r.checks.stray > 0 ? 1 : 0));
  const badRef = sum((r) =>
    r.checks.badRefs > 0 || !r.checks.setupOk || r.checks.unresolvedPlaceholders ? 1 : 0,
  );
  return {
    n,
    llmReleased: llm.length,
    templateFallback: n - llm.length,
    schemaFirstPassRate: n === 0 ? 0 : sum((r) => (r.firstPass ? 1 : 0)) / n,
    retriedRate: n === 0 ? 0 : sum((r) => (r.retried ? 1 : 0)) / n,
    bannedReleased,
    strayNumbersReleased: strayReleased,
    refIntegrityRate: n === 0 ? 1 : 1 - badRef / n,
    historyIntegrityRate: n === 0 ? 1 : sum((r) => (r.checks.historyOk ? 1 : 0)) / n,
    judged: judged.length,
    faithfulRate:
      judged.length === 0 ? null : judged.filter((r) => r.faithful).length / judged.length,
    costUsd: sum((r) => r.cost),
  };
}

export function verdict(s, { live }) {
  const checks = [
    ['0 banned language released', s.bannedReleased === THRESHOLDS.bannedReleased],
    ['0 stray price literals released', s.strayNumbersReleased === THRESHOLDS.strayNumbersReleased],
    ['100% reference integrity (after retry)', s.refIntegrityRate >= THRESHOLDS.refIntegrity],
    ['100% history sentences are server-built', s.historyIntegrityRate >= 1],
  ];
  if (live) {
    checks.push([
      'at least 99% schema-valid on the first attempt',
      s.schemaFirstPassRate >= THRESHOLDS.schemaFirstPass,
    ]);
    checks.push([
      'at least 95% judged faithful',
      s.faithfulRate !== null && s.faithfulRate >= THRESHOLDS.faithful,
    ]);
  }
  return { checks, passed: checks.every(([, ok]) => ok) };
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function renderReport({
  title,
  mode,
  provider,
  model,
  judge,
  summary,
  verdict: v,
  promptVersion,
  when,
}) {
  const lines = [
    `# ${title}`,
    '',
    mode === 'offline'
      ? '> **Harness check, not a model result.** The answers below come from a deterministic stand-in that is made to misbehave on purpose, to show that the guardrails catch it. Run with `--live` for a real model.'
      : `> Live run. Provider under test: **${provider}**, model **${model}**, judge: **${judge ?? 'none'}**.`,
    '',
    `Prompt version: ${promptVersion}. Fixtures: ${summary.n}. Run: ${when}.`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Narratives released from the model | ${summary.llmReleased} |`,
    `| Replaced by the template (two bad answers or provider down) | ${summary.templateFallback} |`,
    `| Valid on the first attempt | ${pct(summary.schemaFirstPassRate)} |`,
    `| Needed one repair retry | ${pct(summary.retriedRate)} |`,
    `| Banned language released | ${summary.bannedReleased} |`,
    `| Stray price literals released | ${summary.strayNumbersReleased} |`,
    `| Reference integrity | ${pct(summary.refIntegrityRate)} |`,
    `| History sentences server-built | ${pct(summary.historyIntegrityRate)} |`,
    `| Judged faithful | ${pct(summary.faithfulRate)} (${summary.judged} judged) |`,
    `| Cost | $${summary.costUsd.toFixed(4)} |`,
    '',
    '## Gates',
    '',
    ...v.checks.map(([name, ok]) => `- [${ok ? 'x' : ' '}] ${name}`),
    '',
    `**Result: ${v.passed ? 'PASS' : 'FAIL'}**`,
    '',
  ];
  return lines.join('\n');
}
