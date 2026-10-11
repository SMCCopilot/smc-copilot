#!/usr/bin/env node
// pnpm voice:eval: score speech recognition plus glossary correction on the 200-phrase set (A05 section 14.4).
//
//   pnpm voice:eval                                  text-only check of correction and the command grammar (free, offline)
//   pnpm voice:eval --print-script                   the 200 phrases to read aloud, numbered
//   pnpm voice:eval --results results.json          score a real engine; results.json is
//                                                    [{"id": 1, "hypothesis": "what the engine wrote", "latencyMs": 900}, ...]
//                                                    (the engine's output replaces the simulated "heard" text)
//   add  --report docs/voice-eval-report.md          write the report
//
// Build first (pnpm build): it imports the compiled contracts.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildGlossary,
  correctTranscript,
  forbiddenByVoice,
  parseVoiceCommand,
} from '@smc/contracts';
import { PHRASES } from './phrases.mjs';

export const GATES = {
  commandAccuracy: 0.95,
  forbiddenCaught: 1,
  jargonAccuracy: 0.9,
  falseCommandOnQuestions: 0,
  wer: 0.12,
  p95LatencyMs: 2500,
};

const GLOSSARY = buildGlossary(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK']);

const words = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Word error rate: edit distance over words divided by the reference length. */
export function wer(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
  }
  return d[r.length][h.length] / r.length;
}

const sameArg = (cmd, want) => {
  if (want === undefined) return true;
  if (!cmd) return false;
  const got = cmd.tf ?? cmd.ordinal ?? cmd.watch ?? cmd.resume ?? cmd.muted;
  return got === want;
};

/** Does the corrected transcript satisfy this phrase's expectation? */
export function check(phrase, heard) {
  const fixed = correctTranscript(heard, GLOSSARY).text;
  const cmd = parseVoiceCommand(fixed);
  const forb = forbiddenByVoice(heard) ?? forbiddenByVoice(fixed);
  const e = phrase.expect;
  if (e.forbidden) return { ok: forb === e.forbidden, fixed, cmd, forb };
  if (forb) return { ok: false, fixed, cmd, forb };
  if ('command' in e && e.command === null) return { ok: cmd === null, fixed, cmd, forb };
  if (e.command) return { ok: cmd?.command === e.command && sameArg(cmd, e.arg), fixed, cmd, forb };
  if (e.contains) return { ok: fixed.includes(e.contains), fixed, cmd, forb };
  if (e.text) return { ok: fixed.toLowerCase().includes(e.text.toLowerCase()), fixed, cmd, forb };
  return { ok: true, fixed, cmd, forb };
}

export function score(results) {
  const by = (c) => results.filter((r) => r.phrase.category === c);
  const rate = (rows) =>
    rows.length === 0 ? 1 : rows.filter((r) => r.res.ok).length / rows.length;
  const cmds = by('command');
  const questions = by('question');
  const lat = results
    .map((r) => r.latencyMs)
    .filter((x) => typeof x === 'number')
    .sort((a, b) => a - b);
  const wers = results
    .filter((r) => typeof r.hypothesis === 'string')
    .map((r) => wer(r.phrase.say, r.hypothesis));
  return {
    n: results.length,
    commandAccuracy: rate(cmds),
    forbiddenCaught: rate(by('forbidden')),
    jargonAccuracy: rate([...by('jargon'), ...by('symbol')]),
    falseCommandOnQuestions: questions.filter((r) => r.res.cmd !== null).length,
    wer: wers.length === 0 ? null : wers.reduce((a, b) => a + b, 0) / wers.length,
    p95LatencyMs:
      lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)],
    failures: results
      .filter((r) => !r.res.ok)
      .map((r) => ({ id: r.phrase.id, say: r.phrase.say, heard: r.heard, fixed: r.res.fixed })),
  };
}

export function verdict(s, live) {
  const checks = [
    [
      `command accuracy at least ${GATES.commandAccuracy * 100}% after correction`,
      s.commandAccuracy >= GATES.commandAccuracy,
    ],
    ['every forbidden request caught', s.forbiddenCaught >= GATES.forbiddenCaught],
    [
      `jargon and symbol accuracy at least ${GATES.jargonAccuracy * 100}%`,
      s.jargonAccuracy >= GATES.jargonAccuracy,
    ],
    [
      'no question mistaken for a command',
      s.falseCommandOnQuestions === GATES.falseCommandOnQuestions,
    ],
  ];
  if (live) {
    checks.push([
      `word error rate at most ${GATES.wer * 100}% (clean speech)`,
      s.wer !== null && s.wer <= GATES.wer,
    ]);
    checks.push([
      `release-to-transcript p95 under ${GATES.p95LatencyMs} ms`,
      s.p95LatencyMs !== null && s.p95LatencyMs <= GATES.p95LatencyMs,
    ]);
  }
  return { checks, passed: checks.every(([, ok]) => ok) };
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function render(s, v, live) {
  return [
    live
      ? '# Voice evaluation: speech engine plus correction'
      : '# Voice evaluation: correction and grammar check',
    '',
    live
      ? 'Real engine output scored against what was read aloud.'
      : '> **Text-only check, not an engine result.** The "heard" text is a typical engine rendering written by hand. It shows that the glossary correction and the command grammar handle common mishearings; it says nothing about a real engine. Read the script aloud and run with `--results` for that.',
    '',
    `Phrases: ${s.n}`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Command accuracy | ${pct(s.commandAccuracy)} |`,
    `| Forbidden requests caught | ${pct(s.forbiddenCaught)} |`,
    `| Jargon and symbol accuracy | ${pct(s.jargonAccuracy)} |`,
    `| Questions mistaken for commands | ${s.falseCommandOnQuestions} |`,
    `| Word error rate | ${pct(s.wer)} |`,
    `| Release-to-transcript p95 | ${s.p95LatencyMs === null ? 'n/a' : `${s.p95LatencyMs} ms`} |`,
    '',
    '## Gates',
    '',
    ...v.checks.map(([name, ok]) => `- [${ok ? 'x' : ' '}] ${name}`),
    '',
    `**Result: ${v.passed ? 'PASS' : 'FAIL'}**`,
    '',
    ...(s.failures.length > 0
      ? [
          '## Misses',
          '',
          ...s.failures
            .slice(0, 30)
            .map((f) => `- #${f.id} said "${f.say}", heard "${f.heard}", corrected "${f.fixed}"`),
          '',
        ]
      : []),
  ].join('\n');
}

export function main(argv) {
  const args = Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a, i, all) => {
        const idx = argv.indexOf(a);
        const next = argv[idx + 1];
        return [a.slice(2), next && !next.startsWith('--') ? next : true];
      }),
  );
  if (args['print-script']) {
    const text = PHRASES.map((p) => `${String(p.id).padStart(3, ' ')}. ${p.say}`).join('\n');
    console.log(text);
    return { script: text };
  }
  const live = Boolean(args.results);
  const got = live
    ? new Map(JSON.parse(readFileSync(String(args.results), 'utf8')).map((r) => [r.id, r]))
    : null;
  const results = PHRASES.map((phrase) => {
    const r = got?.get(phrase.id);
    const heard = r ? String(r.hypothesis) : phrase.heard;
    return {
      phrase,
      heard,
      hypothesis: r ? heard : undefined,
      latencyMs: r?.latencyMs,
      res: check(phrase, heard),
    };
  });
  const s = score(results);
  const v = verdict(s, live);
  const report = render(s, v, live);
  console.log(report);
  if (args.report) writeFileSync(String(args.report), report);
  return { s, v, report };
}

if (process.argv[1]?.endsWith('eval.mjs')) {
  try {
    const r = main(process.argv.slice(2));
    if (r.v && !r.v.passed) process.exitCode = 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
