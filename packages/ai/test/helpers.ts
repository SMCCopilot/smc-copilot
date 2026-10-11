import type { MarketFacts } from '@smc/contracts';
import { LlmError } from '../src/errors.js';
import { PriceTable } from '../src/pricing.js';
import { LlmRouter, type RouterOptions } from '../src/router.js';
import type {
  CallRecord,
  LlmUsage,
  ProviderAdapter,
  ProviderCallArgs,
  ProviderCallResult,
  ProviderId,
  ProviderState,
} from '../src/types.js';

export const USAGE: LlmUsage = { tokensIn: 1000, tokensOut: 200, cachedIn: 0, cacheWrite: 0 };

export type Step = string | LlmError | ((a: ProviderCallArgs) => string | LlmError);

/** A provider that plays back a script: a string is a successful answer, an LlmError is a failure. */
export function scripted(
  id: ProviderId,
  steps: Step[],
): ProviderAdapter & { calls: ProviderCallArgs[] } {
  const calls: ProviderCallArgs[] = [];
  let i = 0;
  return {
    id,
    calls,
    async call(args: ProviderCallArgs): Promise<ProviderCallResult> {
      calls.push(args);
      const raw = steps[Math.min(i++, steps.length - 1)];
      const step = typeof raw === 'function' ? raw(args) : raw;
      if (step instanceof LlmError) throw step;
      return { text: step as string, usage: USAGE };
    },
  };
}

export const state = (id: ProviderId, over: Partial<ProviderState> = {}): ProviderState => ({
  id,
  enabled: true,
  apiKey: `key-${id}`,
  priority: 1,
  dataClasses: ['D0', 'D1', 'D2'],
  models: { fast: `${id}-fast`, strong: `${id}-strong` },
  ...over,
});

export function makeRouter(
  states: ProviderState[],
  adapters: ProviderAdapter[],
  over: Partial<RouterOptions> = {},
) {
  const records: CallRecord[] = [];
  const outcomes: [string, string][] = [];
  let now = 1_000_000;
  const router = new LlmRouter({
    source: { providers: async () => states },
    adapters: Object.fromEntries(adapters.map((a) => [a.id, a])),
    prices: new PriceTable({
      'anthropic-strong': { in: 3, out: 15 },
      'openai-strong': { in: 1, out: 5 },
    }),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    jitter: () => 0,
    onCall: (r) => {
      records.push(r);
    },
    onOutcome: (id, o) => {
      outcomes.push([id, o]);
    },
    ...over,
  });
  return { router, records, outcomes, advance: (ms: number) => (now += ms) };
}

export const FACTS: MarketFacts = {
  asOf: Date.UTC(2026, 9, 12, 8, 0, 0),
  instrumentId: 'BINANCE:PERP:BTCUSDT',
  strategyVersionId: 'sv1',
  dataQuality: 'OK',
  htfBias: { tf: '4h', trend: 'BULL', lastBreak: { id: 'E41', type: 'BOS_UP' } },
  levels: [
    { id: 'L7', label: 'Asian low (sell-side swept)', kind: 'EQL', price: 64020 },
    { id: 'L9', label: 'Sweep low', kind: 'SWING_LOW', price: 63960 },
    { id: 'L4', label: 'Previous day high', kind: 'PDH', price: 64450 },
  ],
  zones: [
    { id: 'Z3', label: 'Bullish order block, 15m', top: 64110, bottom: 64040, state: 'FRESH' },
  ],
  setups: [
    {
      id: 'S19',
      template: 'T1',
      direction: 'LONG',
      grade: 'A',
      state: 'ARMED',
      reasonCodes: [],
      poi: 'Z3',
      invalidation: 'L9',
      targets: ['L4'],
      stats: null,
    },
  ],
  warnings: [],
};

export const GOOD_NARRATIVE = JSON.stringify({
  headline: '4h bias bullish with an armed long idea',
  bias_summary:
    'The 4h structure is bullish. Price swept sell-side liquidity at {{L:L7}} and reacted from {{Z:Z3}}.',
  scenarios: [
    {
      setupId: 'S19',
      kind: 'PRIMARY',
      if_then:
        'If price holds {{Z:Z3}}, the long idea stays valid and the next liquidity is {{L:L4}}.',
      invalidation_ref: 'L9',
      key_refs: ['Z3', 'L4'],
    },
    {
      setupId: 'S19',
      kind: 'ALTERNATE',
      if_then: 'If price closes below {{L:L9}}, the idea is invalidated.',
      invalidation_ref: 'L9',
      key_refs: ['L9'],
    },
  ],
  risks_and_unknowns: ['There is not enough history to quote a base rate.'],
  history_line: null,
  refs_used: ['L7', 'Z3', 'L4', 'L9', 'S19'],
});
