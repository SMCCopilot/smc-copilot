// Shadow outcomes (A04 section 13.2): a deterministic, pessimistic fill-and-resolve model run on every ARMED
// setup, whether or not any user traded it. Pure and incremental: one candle at a time, same code in live and replay.
import { round3 } from './ids.js';
import type { CandleLite, SetupRecord } from './types.js';

export const OUTCOME_RULES_VERSION = 'shadow-v1';

export type OutcomeKind =
  | 'TP1_FIRST'
  | 'SL_FIRST'
  | 'INVALIDATED_BEFORE_FILL'
  | 'EXPIRED_OPEN'
  | 'NO_FILL';

export interface ShadowOutcome {
  outcome: OutcomeKind;
  filled: boolean;
  fillTime: number | null;
  fillPrice: number | null;
  resolutionTime: number;
  /** Net R (after round-trip fees) when TP1 was reached first. */
  rTp1: number | null;
  /** Round-trip taker fees in R. */
  feesR: number | null;
  /** Net R at the exit (TP1 or stop); null when there was no fill or the trade was still open at expiry. */
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  /** Entry-timeframe bars from setup creation to resolution. */
  barsToResolution: number;
  /** One candle touched both the stop and TP1 (stop first was assumed), or TP1 traded on the fill candle. */
  ambiguousIntrabar: boolean;
  rulesVersion: string;
}

export interface Transition {
  to: 'TRIGGERED' | 'EXPIRED' | 'INVALIDATED';
  reasons: string[];
}

export interface Limits {
  /** Bars allowed to reach the fill. */
  expiryBars: number;
  /** Bars allowed between fill and resolution. */
  resolveBars: number;
}

export interface StepResult {
  /** The updated record, or null when the setup is finished. */
  setup: SetupRecord | null;
  transitions: Transition[];
  outcome: ShadowOutcome | null;
}

/** Advance a live setup by one closed entry-timeframe candle. `breakInDirection` = an internal break in the setup's direction closed on this candle. */
export function resolveStep(
  input: SetupRecord,
  bar: CandleLite,
  index: number,
  closeTime: number,
  limits: Limits,
  breakInDirection: boolean,
): StepResult {
  const long = input.direction === 'LONG';
  const s = long ? 1 : -1;
  const tp1 = (input.targets[0] as SetupRecord['targets'][number]).price;
  const transitions: Transition[] = [];
  let st: SetupRecord = { ...input };

  const finish = (
    outcome: OutcomeKind,
    exit: number | null,
    transition: Transition | null,
    ambiguous: boolean,
  ): StepResult => {
    if (transition) transitions.push(transition);
    const fill = st.fill;
    let realized: number | null = null;
    let rTp1: number | null = null;
    let feesR: number | null = null;
    let mfe: number | null = null;
    let mae: number | null = null;
    if (fill) {
      const risk = s * (fill.price - st.stop);
      if (risk > 0) {
        mfe = Math.max(0, long ? (st.hi - fill.price) / risk : (fill.price - st.lo) / risk);
        mae = Math.max(0, long ? (fill.price - st.lo) / risk : (st.hi - fill.price) / risk);
        if (exit !== null) {
          feesR = ((st.feeBps / 10_000) * (fill.price + exit)) / risk;
          realized = (s * (exit - fill.price)) / risk - feesR;
          if (outcome === 'TP1_FIRST') rTp1 = realized;
        }
      }
    }
    return {
      setup: null,
      transitions,
      outcome: {
        outcome,
        filled: fill !== null,
        fillTime: fill?.time ?? null,
        fillPrice: fill?.price ?? null,
        resolutionTime: closeTime,
        rTp1: rTp1 === null ? null : round3(rTp1),
        feesR: feesR === null ? null : round3(feesR),
        realizedR: realized === null ? null : round3(realized),
        mfeR: mfe === null ? null : round3(mfe),
        maeR: mae === null ? null : round3(mae),
        barsToResolution: index - st.createdIndex,
        ambiguousIntrabar: ambiguous || st.ambiguous,
        rulesVersion: OUTCOME_RULES_VERSION,
      },
    };
  };

  // Touching the point of interest, then a break in our direction: the confirmation that makes it TRIGGERED.
  if (!st.touched && (long ? bar.l <= st.poi.top : bar.h >= st.poi.bottom)) st.touched = true;
  if (st.touched && st.state === 'ARMED' && breakInDirection) {
    st = { ...st, state: 'TRIGGERED' };
    transitions.push({ to: 'TRIGGERED', reasons: [] });
  }

  let fillCandle = false;
  if (!st.fill) {
    if (long ? bar.l <= st.poi.ref : bar.h >= st.poi.ref) {
      // A limit order fills when price trades through it; pay one tick of adverse slippage (no price improvement).
      st = {
        ...st,
        fill: { time: bar.t, price: st.poi.ref + s * st.slippage, index },
        hi: bar.h,
        lo: bar.l,
      };
      fillCandle = true;
    } else if (long ? bar.c < st.invalidation : bar.c > st.invalidation) {
      return finish(
        'INVALIDATED_BEFORE_FILL',
        null,
        { to: 'INVALIDATED', reasons: ['INVALIDATION_BREACHED'] },
        false,
      );
    } else if (long ? bar.h >= tp1 : bar.l <= tp1) {
      // The target traded without us: the idea has run away without a fill.
      return finish('NO_FILL', null, { to: 'EXPIRED', reasons: ['TARGET_REACHED_FIRST'] }, false);
    } else if (index - st.createdIndex >= limits.expiryBars) {
      return finish('NO_FILL', null, { to: 'EXPIRED', reasons: ['SETUP_EXPIRED'] }, false);
    } else {
      return { setup: st, transitions, outcome: null };
    }
  }

  const fill = st.fill as NonNullable<SetupRecord['fill']>;
  if (!fillCandle) st = { ...st, hi: Math.max(st.hi, bar.h), lo: Math.min(st.lo, bar.l) };
  const stopHit = long ? bar.l <= st.stop : bar.h >= st.stop;
  const tpTouched = long ? bar.h >= tp1 : bar.l <= tp1;

  if (stopHit) {
    // Pessimistic: if one candle touched both the stop and the target, the stop came first. A gap through
    // the stop fills at the open (worse than the stop), then one tick of slippage.
    const base = long ? Math.min(st.stop, bar.o) : Math.max(st.stop, bar.o);
    return finish('SL_FIRST', base - s * st.slippage, null, tpTouched);
  }
  if (fillCandle && tpTouched) {
    // Fill and target on one candle: the order of the two is unknown, so no credit is taken this candle.
    st = { ...st, ambiguous: true };
  } else if (tpTouched) {
    return finish('TP1_FIRST', tp1, null, false);
  }
  if (index - fill.index >= limits.resolveBars) {
    return finish('EXPIRED_OPEN', null, { to: 'EXPIRED', reasons: ['SETUP_EXPIRED'] }, false);
  }
  return { setup: st, transitions, outcome: null };
}
