import type { MarketFacts } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../src/errors.js';
import { factsHash } from '../src/guard.js';
import { generateNarrative, historyLine, templateNarrative } from '../src/narrative.js';
import { FACTS, GOOD_NARRATIVE, makeRouter, scripted, state } from './helpers.js';

const bad = (patch: (o: Record<string, unknown>) => void): string => {
  const o = JSON.parse(GOOD_NARRATIVE) as Record<string, unknown>;
  patch(o);
  return JSON.stringify(o);
};

describe('narrative generation', () => {
  it('substitutes placeholders and builds the history sentence on the server', async () => {
    const a = scripted('anthropic', [GOOD_NARRATIVE]);
    const { router, records } = makeRouter([state('anthropic')], [a]);
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.source).toBe('LLM');
    expect(r.content.bias_summary).toContain('64,020.00');
    expect(r.content.scenarios[0]?.if_then).toContain('64,040.00 to 64,110.00');
    expect(r.content.history).toEqual([
      {
        setupId: 'S19',
        text: 'There is not enough history yet to quote a base rate for this kind of setup.',
      },
    ]);
    expect(records[0]?.dataClass).toBe('D0');
  });

  it('a number the model invented triggers one repair retry, then succeeds', async () => {
    const a = scripted('anthropic', [
      bad((o) => (o.headline = 'Price is at 64020')),
      GOOD_NARRATIVE,
    ]);
    const { router, outcomes } = makeRouter([state('anthropic')], [a]);
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.source).toBe('LLM');
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]?.req.user).toContain('rejected');
    expect(outcomes.map((x) => x[1])).toEqual(['SCHEMA_RETRY']);
  });

  it('two bad answers fall back to the template and mark the call rejected', async () => {
    const a = scripted('anthropic', [
      bad((o) => (o.headline = 'You should buy now')),
      '{"nonsense":true}',
    ]);
    const { router, outcomes } = makeRouter([state('anthropic')], [a]);
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.source).toBe('TEMPLATE');
    expect(r.fallbackReason).toBe('GUARDRAIL_REJECTED');
    expect(outcomes.map((x) => x[1])).toEqual(['SCHEMA_RETRY', 'GUARDRAIL_REJECTED']);
    expect(r.content.headline.length).toBeGreaterThan(0);
  });

  it.each([
    [
      'unknown setup id',
      (o: Record<string, unknown>) => {
        for (const x of o.scenarios as { setupId: string }[]) x.setupId = 'S99';
      },
    ],
    [
      'moved invalidation',
      (o: Record<string, unknown>) => {
        for (const x of o.scenarios as { invalidation_ref: string }[]) x.invalidation_ref = 'L7';
      },
    ],
    ['unknown placeholder', (o: Record<string, unknown>) => (o.bias_summary = 'see {{L:NOPE}}')],
    [
      'missing alternate',
      (o: Record<string, unknown>) => (o.scenarios = (o.scenarios as unknown[]).slice(0, 1)),
    ],
    [
      'no risk note despite missing stats',
      (o: Record<string, unknown>) => (o.risks_and_unknowns = []),
    ],
    [
      'model wrote a history line',
      (o: Record<string, unknown>) => (o.history_line = 'It wins 80% of the time'),
    ],
    ['unknown refs_used', (o: Record<string, unknown>) => (o.refs_used = ['ZZ'])],
  ])('rejects: %s', async (_n, patch) => {
    const a = scripted('anthropic', [bad(patch)]);
    const { router } = makeRouter([state('anthropic')], [a]);
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.source).toBe('TEMPLATE');
  });

  it('with the provider down or disabled the template is delivered and nothing throws', async () => {
    const down = makeRouter(
      [state('anthropic')],
      [scripted('anthropic', [new LlmError('SERVER', 'x', 500)])],
    );
    const r1 = await generateNarrative(down.router, FACTS, 2);
    expect(r1.source).toBe('TEMPLATE');
    expect(r1.fallbackReason).toBe('UNAVAILABLE');
    const off = makeRouter(
      [state('anthropic', { enabled: false })],
      [scripted('anthropic', ['x'])],
    );
    expect((await generateNarrative(off.router, FACTS, 2)).source).toBe('TEMPLATE');
  });

  it('falls to the next enabled provider and still validates its output', async () => {
    const a = scripted('anthropic', [new LlmError('SERVER', 'x', 500)]);
    const o = scripted('openai', [GOOD_NARRATIVE]);
    const { router } = makeRouter(
      [state('anthropic', { priority: 1 }), state('openai', { priority: 2 })],
      [a, o],
    );
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.source).toBe('LLM');
    expect(r.calls[0]?.provider).toBe('openai');
  });
});

describe('template and history line', () => {
  it('the template passes every check the model output must pass', async () => {
    const a = scripted('anthropic', ['{"bad":1}']);
    const { router } = makeRouter([state('anthropic')], [a]);
    const r = await generateNarrative(router, FACTS, 2);
    expect(r.content.scenarios).toHaveLength(2);
    expect(JSON.stringify(r.content)).not.toContain('{{');
  });

  it('template handles empty and degraded facts', () => {
    const empty: MarketFacts = {
      ...FACTS,
      setups: [],
      levels: [],
      zones: [],
      dataQuality: 'STALE',
      warnings: ['FEED_STALE'],
    };
    const t = templateNarrative(empty);
    expect(t.scenarios).toEqual([]);
    expect(t.risks_and_unknowns.length).toBeGreaterThan(0);
    expect(t.bias_summary).toContain('No setup is active');
  });

  it('history line quotes a statistic only when one exists (n >= 30 is enforced by the contract)', () => {
    expect(historyLine(null)).toContain('not enough history');
    const line = historyLine({
      n: 112,
      rate: 0.41,
      ci95: [0.32, 0.5],
      source: 'BACKTEST',
      window: { from: '2025-10', to: '2026-10' },
      disclaimerKey: 'HISTORICAL_NOT_FORECAST',
    });
    expect(line).toContain('41%');
    expect(line).toContain('32 to 50%');
    expect(line).toContain('112 cases');
    expect(line).toContain('not a forecast');
  });

  it('the facts hash is stable and changes with the facts', () => {
    expect(factsHash(FACTS)).toBe(factsHash(JSON.parse(JSON.stringify(FACTS))));
    expect(factsHash(FACTS)).not.toBe(factsHash({ ...FACTS, asOf: FACTS.asOf + 1 }));
  });
});
