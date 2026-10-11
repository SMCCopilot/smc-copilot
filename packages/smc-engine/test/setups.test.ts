import { MarketFactsSchema, type TradePlan, TradePlanSchema } from '@smc/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildFacts,
  createEngine,
  type EngineEvent,
  type EngineState,
  step,
} from '../src/index.js';
import { candle, config, INSTRUMENT, run } from './helpers.js';
import { WORKED_BASE_OPEN_MS, WORKED_ROWS } from './worked-example.js';

const T0 = WORKED_BASE_OPEN_MS;
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const STEP = { spread: 5, tickSize: 0.1 };

/** The A04 section 15.5 parameters: internal L=R=2, ATR fixed at 100, FVG minimum 0.25 ATR. */
const workedCfg = (patch: (c: Record<string, unknown>) => void = () => {}) =>
  config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.atr as { fixed?: number }).fixed = 100;
    (c.fvg as { minSizeAtrMult: number }).minSizeAtrMult = 0.25;
    patch(c);
  });
const worked = (
  cfg = workedCfg(),
  extra: {
    flags?: Record<number, number>;
    stepOpts?: typeof STEP & { dataQuality?: 'OK' | 'STALE' };
  } = {},
) => run(WORKED_ROWS, cfg, { start: T0, stepOpts: STEP, ...extra });
const of = (events: EngineEvent[], type: EngineEvent['type'], template?: string) =>
  events.filter((e) => e.type === type && (template === undefined || e.data.template === template));

describe('T1 sweep-CHoCH-retest on the A04 worked example', () => {
  const events = worked();
  const candidate = of(events, 'SETUP_CANDIDATE', 'T1')[0] as EngineEvent;
  const armed = of(events, 'SETUP_ARMED', 'T1')[0] as EngineEvent;
  const planEvent = events.find(
    (e) => e.type === 'PLAN_READY' && e.data.setupKey === armed.data.setupKey,
  ) as EngineEvent;
  const plan = planEvent.data.plan as unknown as TradePlan;

  it('creates the candidate at 08:00 with sweep, CHoCH, OB and FVG components', () => {
    expect(hhmm(candidate.time)).toBe('08:00');
    expect(candidate.data).toMatchObject({ direction: 'LONG', entryTf: '15m' });
    const kinds = (candidate.data.components as { kind: string }[]).map((c) => c.kind);
    expect(kinds).toEqual(['CHOCH', 'SWEEP', 'POOL', 'OB', 'FVG', 'RANGE']);
  });

  it('arms it and emits the plan at 08:00 (same candle)', () => {
    expect(hhmm(armed.time)).toBe('08:00');
    expect(armed.data.grade).toBe('A');
    expect(armed.data.reasonCodes).toEqual([]);
    expect(hhmm(planEvent.time)).toBe('08:00');
  });

  it('computes the plan numbers of section 15.5', () => {
    expect(plan.entry).toMatchObject({
      top: 64110,
      bottom: 64040,
      refPrice: 64075,
      refBasis: 'OB_50',
    });
    expect(plan.stop.price).toBe(63945); // sweepExtreme 63960 - 0.1 ATR - spread 5
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ price: 64450, label: 'TP1' });
    expect(plan.targets[0]?.rr).toBeCloseTo(2.88, 2);
    expect(plan.invalidation.level).toBe(63960);
    expect(plan.scenarios.alternate.kind).toBe('SWEEP_NOT_REVERSAL');
    expect(plan.scenarios.alternate.condition).toMatchObject({ type: 'CLOSE_BELOW', level: 64040 });
    expect(plan.statsReason).toBe('INSUFFICIENT_HISTORY');
    expect(plan.stats).toBeNull();
    expect(plan.confidence).toBe('LOW');
  });

  it('satisfies the TradePlan contract', () => {
    expect(() => TradePlanSchema.parse(plan)).not.toThrow();
  });

  it('scores 78.74 with the shipped hypothesis weights (HTF bias unknown, so 0.4 alignment)', () => {
    expect(armed.data.score).toBeCloseTo(78.74, 2);
    expect(armed.data.features).toMatchObject({
      htfAlignment: 8,
      sweepPresent: 15,
      fvgConfluence: 5,
      obFreshness: 10,
      killzone: 10,
      zoneSize: 5,
    });
    expect((armed.data.features as Record<string, number>).displacementStrength).toBeCloseTo(13, 5);
    expect((armed.data.features as Record<string, number>).rrQuality).toBeCloseTo(9.62, 2);
  });

  it('is triggered at 09:15 (touched the POI, then an internal break up) and resolved at 09:30', () => {
    expect(hhmm(of(events, 'SETUP_TRIGGERED')[0]?.time as number)).toBe('09:15');
    const resolved = of(events, 'SETUP_RESOLVED').find(
      (e) => e.data.setupKey === armed.data.setupKey,
    ) as EngineEvent;
    expect(hhmm(resolved.time)).toBe('09:30');
    expect(resolved.data).toMatchObject({
      outcome: 'TP1_FIRST',
      filled: true,
      fillPrice: 64075.1, // one tick of adverse slippage
      ambiguousIntrabar: false,
      rulesVersion: 'shadow-v1',
    });
    // gross (64450 - 64075.1) / 130.1 = 2.882; fees 5 bps per side = 0.494 R; net 2.388
    expect(resolved.data.feesR).toBeCloseTo(0.494, 3);
    expect(resolved.data.realizedR).toBeCloseTo(2.388, 3);
    expect(resolved.data.mfeR).toBeCloseTo(3.035, 3);
    expect(resolved.data.maeR).toBeCloseTo(0.078, 3);
  });
});

describe('hard filters reject with the right code', () => {
  const rejected = (events: EngineEvent[]) =>
    of(events, 'SETUP_REJECTED', 'T1')[0]?.data.reasonCodes as string[] | undefined;

  it.each([
    [
      'STOP_TOO_TIGHT',
      workedCfg((c) => ((c.risk as { minStopAtrMult: number }).minStopAtrMult = 2)),
      {},
    ],
    [
      'STOP_TOO_WIDE',
      workedCfg((c) => ((c.risk as { maxStopAtrMult: number }).maxStopAtrMult = 1)),
      {},
    ],
    ['RR_TOO_LOW', workedCfg((c) => ((c.risk as { minRR: number }).minRR = 5)), {}],
  ])('%s', (code, cfg, extra) => {
    const reasons = rejected(worked(cfg, extra));
    expect(reasons).toContain(code);
    expect(of(worked(cfg, extra), 'SETUP_ARMED', 'T1')).toHaveLength(0);
    expect(
      of(worked(cfg, extra), 'PLAN_READY').filter(
        (e) =>
          e.data.setupKey === of(worked(cfg, extra), 'SETUP_CANDIDATE', 'T1')[0]?.data.setupKey,
      ),
    ).toHaveLength(0);
  });

  it('SPREAD_WIDE when the assumed spread exceeds the ATR fraction', () => {
    const events = worked(workedCfg(), { stepOpts: { spread: 50, tickSize: 0.1 } });
    expect(rejected(events)).toContain('SPREAD_WIDE');
  });

  it('DATA_STALE when the feed is not OK (no new setups while stale)', () => {
    const events = worked(workedCfg(), { stepOpts: { ...STEP, dataQuality: 'STALE' } });
    expect(rejected(events)).toContain('DATA_STALE');
  });

  it('DATA_SUSPECT when the sweep candle is flagged SPIKE_SUSPECT', () => {
    expect(rejected(worked(workedCfg(), { flags: { 16: 1 } }))).toContain('DATA_SUSPECT');
  });

  it('DATA_SUSPECT when the break candle carries a cross-check divergence', () => {
    expect(rejected(worked(workedCfg(), { flags: { 18: 2 } }))).toContain('DATA_SUSPECT');
  });

  it('records every failing code, not only the first', () => {
    const cfg = workedCfg((c) => {
      (c.risk as { minStopAtrMult: number; minRR: number }).minStopAtrMult = 2;
      (c.risk as { minRR: number }).minRR = 5;
    });
    const reasons = rejected(worked(cfg)) as string[];
    expect(reasons).toEqual(expect.arrayContaining(['STOP_TOO_TIGHT', 'RR_TOO_LOW']));
  });

  it('a rejected setup has a candidate and a rejection but no plan and no outcome', () => {
    const cfg = workedCfg((c) => ((c.risk as { minRR: number }).minRR = 5));
    const events = worked(cfg);
    const key = of(events, 'SETUP_CANDIDATE', 'T1')[0]?.data.setupKey;
    const mine = events.filter((e) => e.data.setupKey === key).map((e) => e.type);
    expect(mine).toEqual(['SETUP_CANDIDATE', 'SETUP_REJECTED']);
  });
});

describe('higher-timeframe bias', () => {
  const withBias = (d: 'BULL' | 'BEAR', h: 'BULL' | 'BEAR'): EngineState => {
    const snap = (trend: 'BULL' | 'BEAR') => [
      {
        closeTime: 1,
        trend,
        protectedLevel: null,
        rangeLow: null,
        rangeHigh: null,
        lastBreakId: null,
        lastBreakType: null,
      },
    ];
    return { ...createEngine(INSTRUMENT), mtf: { '1d': snap(d), '4h': snap(h) } };
  };
  const runFrom = (start: EngineState) => {
    const cfg = workedCfg();
    let s = start;
    const out: EngineEvent[] = [];
    WORKED_ROWS.forEach((row, i) => {
      const r = step(s, candle('15m', T0 + i * 900_000, row), cfg, STEP);
      s = r.state;
      out.push(...r.events);
    });
    return out;
  };

  it('rejects a T2 continuation that runs against the HTF bias, but not T1 reversals', () => {
    const events = runFrom(withBias('BEAR', 'BEAR'));
    expect(of(events, 'SETUP_REJECTED', 'T2')[0]?.data.reasonCodes).toContain('HTF_COUNTER_BIAS');
    expect(of(events, 'SETUP_ARMED', 'T1')).toHaveLength(1);
  });

  it('scores aligned bias higher than unknown bias', () => {
    const aligned = of(runFrom(withBias('BULL', 'BULL')), 'SETUP_ARMED', 'T1')[0]?.data
      .score as number;
    const unknown = of(worked(), 'SETUP_ARMED', 'T1')[0]?.data.score as number;
    expect(aligned - unknown).toBeCloseTo(12, 5); // 20 x (1 - 0.4)
  });
});

describe('setup properties over random data', () => {
  const K = 100_000;
  const walk = fc
    .array(fc.tuple(fc.integer({ min: -60, max: 60 }), fc.nat(40), fc.nat(40)), {
      minLength: 80,
      maxLength: 400,
    })
    .map((steps) => {
      let p = K;
      return steps.map(([d, up, down]): [number, number, number, number] => {
        const o = p;
        const c = Math.max(1000, o + d);
        p = c;
        return [o, Math.max(o, c) + up, Math.max(1, Math.min(o, c) - down), c];
      });
    });
  const cfg = config((c) => {
    (c.swings as { internal: { L: number; R: number } }).internal = { L: 2, R: 2 };
    (c.swings as { external: { L: number; R: number } }).external = { L: 5, R: 5 };
  });
  const go = (rows: [number, number, number, number][]) =>
    run(rows, cfg, { stepOpts: { tickSize: 1 } });

  it('every plan satisfies the contract and RR is derived from the levels', () => {
    fc.assert(
      fc.property(walk, (rows) => {
        for (const e of go(rows).filter((x) => x.type === 'PLAN_READY')) {
          const plan = TradePlanSchema.parse(e.data.plan);
          expect(plan.scenarios.alternate).toBeDefined();
          expect(plan.invalidation.level).toBeGreaterThan(0);
          const risk = Math.abs(plan.entry.refPrice - plan.stop.price);
          for (const t of plan.targets) {
            expect(t.rr).toBeCloseTo(Math.abs(t.price - plan.entry.refPrice) / risk, 9);
            expect(t.rr).toBeGreaterThanOrEqual(cfg.risk.minRR - 1e-9);
          }
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it('lifecycle events are legal: candidate first, terminal states last, one outcome per armed setup', () => {
    fc.assert(
      fc.property(walk, (rows) => {
        const bySetup = new Map<string, string[]>();
        for (const e of go(rows)) {
          const key = e.data.setupKey;
          if (typeof key === 'string') bySetup.set(key, [...(bySetup.get(key) ?? []), e.type]);
        }
        for (const seq of bySetup.values()) {
          expect(seq[0]).toBe('SETUP_CANDIDATE');
          if (seq[1] === 'SETUP_REJECTED') {
            expect(seq).toHaveLength(2);
            continue;
          }
          expect(seq.slice(1, 3)).toEqual(['SETUP_ARMED', 'PLAN_READY']);
          expect(seq.filter((t) => t === 'SETUP_RESOLVED').length).toBeLessThanOrEqual(1);
          const resolvedAt = seq.indexOf('SETUP_RESOLVED');
          if (resolvedAt >= 0) expect(resolvedAt).toBe(seq.length - 1);
          expect(seq.filter((t) => t === 'SETUP_TRIGGERED').length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it('armed setups respect the stop band and the enforced premium/discount side', () => {
    fc.assert(
      fc.property(walk, (rows) => {
        for (const e of go(rows).filter((x) => x.type === 'SETUP_ARMED')) {
          const pd = e.data.premiumDiscount as { zone: string } | null;
          if (e.data.template === 'T2' && pd) {
            expect(pd.zone).not.toBe(e.data.direction === 'LONG' ? 'PREMIUM' : 'DISCOUNT');
          }
          expect(e.data.reasonCodes).toEqual([]);
        }
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});

describe('setups in ChartFacts', () => {
  it('lists the armed setup and every id it mentions resolves to a level or zone', () => {
    const cfg = workedCfg();
    let s = createEngine(INSTRUMENT);
    WORKED_ROWS.slice(0, 20).forEach((row, i) => {
      s = step(s, candle('15m', T0 + i * 900_000, row), cfg, STEP).state;
    });
    const facts = buildFacts(s, cfg, { asOf: T0 + 20 * 900_000, dataQuality: 'OK' });
    expect(() => MarketFactsSchema.parse(facts)).not.toThrow();
    expect(facts.setups).toHaveLength(1);
    const setup = facts.setups[0] as (typeof facts.setups)[number];
    expect(setup).toMatchObject({
      template: 'T1',
      direction: 'LONG',
      grade: 'A',
      state: 'ARMED',
      stats: null,
    });
    const levels = new Map(facts.levels.map((l) => [l.id, l.price]));
    expect(levels.get(setup.invalidation)).toBe(63960);
    expect(setup.targets.map((id) => levels.get(id))).toEqual([64450]);
    const zone = facts.zones.find((z) => z.id === setup.poi);
    expect(zone).toMatchObject({ top: 64110, bottom: 64040 });
  });
});

describe('review fixes: delayed and skipped candidates', () => {
  const feedSkipping = (skip: number[]) => {
    const cfg = workedCfg();
    let s = createEngine(INSTRUMENT);
    const out: EngineEvent[] = [];
    WORKED_ROWS.forEach((row, i) => {
      if (skip.includes(i)) return;
      const r = step(s, candle('15m', T0 + i * 900_000, row), cfg, STEP);
      s = r.state;
      out.push(...r.events);
    });
    return out;
  };

  it('a missing entry candle delays the candidate instead of silently dropping it', () => {
    const events = feedSkipping([19]); // the candle right after the CHoCH never arrives
    const candidate = of(events, 'SETUP_CANDIDATE', 'T1')[0];
    expect(candidate).toBeDefined();
    expect(hhmm(candidate?.time as number)).toBe('08:15'); // decided on the next candle that does arrive
  });

  it('a break more than three bars old is skipped deliberately, with no crash and no phantom setup', () => {
    const events = feedSkipping([19, 20, 21, 22]);
    expect(of(events, 'SETUP_CANDIDATE', 'T1')).toHaveLength(0);
  });

  it('flags on any of the three FVG candles fail DATA_SUSPECT when the FVG is the POI', () => {
    // The OB is the POI in the worked example; flag the OB candle (idx 17) instead.
    const reasons = of(worked(workedCfg(), { flags: { 17: 1 } }), 'SETUP_REJECTED', 'T1')[0]?.data
      .reasonCodes;
    expect(reasons).toContain('DATA_SUSPECT');
  });

  it('the live set is capped without losing outcomes: the oldest setup is expired and resolved', () => {
    const cfg = workedCfg();
    const dummy = (i: number) => ({
      key: `old-${i}`,
      template: 'T2' as const,
      direction: 'LONG' as const,
      entryTf: '15m' as const,
      biasTf: '1d' as const,
      state: 'ARMED' as const,
      grade: 'B' as const,
      score: 60,
      createdAt: 0,
      createdIndex: 0,
      poi: { zoneId: 'z', kind: 'OB' as const, top: 2, bottom: 0.5, ref: 1 },
      stop: 0.1,
      invalidation: 0.01,
      targets: [{ id: 'TP1', price: 3e12, levelId: 'L', rr: 2, label: 'TP1' as const }],
      slippage: 0,
      halfSpread: 0,
      feeBps: 5,
      touched: false,
      fill: null,
      hi: 0,
      lo: 0,
      ambiguous: false,
      planHash: 'h',
    });
    const start: EngineState = {
      ...createEngine(INSTRUMENT),
      setups: Array.from({ length: 101 }, (_, i) => dummy(i)),
    };
    const r = step(start, candle('15m', T0, WORKED_ROWS[0] as never), cfg, STEP);
    const ev = r.events.filter((e) => e.data.setupKey === 'old-0');
    expect(ev.map((e) => e.type)).toEqual(['SETUP_EXPIRED', 'SETUP_RESOLVED']);
    expect(ev[1]?.data.outcome).toBe('NO_FILL');
    expect(r.state.setups).toHaveLength(100);
  });
});
