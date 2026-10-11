// Swings (A04 section 3) and close-based structure (section 4) for one timeframe and one swing scale.
import type { StrategyConfig, Timeframe } from '@smc/contracts';
import { sha1 } from './sha1.js';
import type {
  CandleLite,
  EngineEvent,
  EngineEventType,
  EventData,
  ProtectedLevel,
  Scale,
  ScaleState,
  Swing,
} from './types.js';

const MAX_SWINGS = 64;

export interface ScaleCtx {
  instrumentId: string;
  tf: Timeframe;
  tfMs: number;
  cfg: StrategyConfig;
  /** Window including the candle being processed (last element). */
  window: readonly CandleLite[];
  base: number;
  /** Absolute index of the candle being processed. */
  n: number;
  prevClose: number | null;
  atr: number;
}

export const emptyScale = (): ScaleState => ({ swings: [], trend: 'UNDEFINED', protected: null });

export function eventId(
  ctx: ScaleCtx,
  type: EngineEventType,
  scale: Scale | null,
  anchor: number,
): string {
  return sha1(
    `${ctx.instrumentId}|${ctx.tf}|${type}:${scale ?? 'zone'}|${anchor}|${ctx.cfg.strategyVersionId}`,
  );
}

function barAt(ctx: ScaleCtx, i: number): CandleLite | undefined {
  return ctx.window[i - ctx.base];
}

/** Extreme of highs or lows over [from, to], clamped to the retained window. Earliest bar wins ties. */
function spanExtreme(
  ctx: ScaleCtx,
  from: number,
  to: number,
  kind: 'HIGH' | 'LOW',
): { level: number; index: number } {
  let best: { level: number; index: number } | null = null;
  for (let i = Math.max(from, ctx.base); i <= to; i++) {
    const b = barAt(ctx, i);
    if (!b) continue;
    const v = kind === 'HIGH' ? b.h : b.l;
    if (best === null || (kind === 'HIGH' ? v > best.level : v < best.level)) {
      best = { level: v, index: i };
    }
  }
  if (best === null) {
    const b = barAt(ctx, ctx.n) as CandleLite;
    return { level: kind === 'HIGH' ? b.h : b.l, index: ctx.n };
  }
  return best;
}

function isPivot(ctx: ScaleCtx, i: number, L: number, R: number, kind: 'HIGH' | 'LOW'): boolean {
  const mid = barAt(ctx, i);
  if (!mid || i - L < ctx.base) return false;
  const v = kind === 'HIGH' ? mid.h : mid.l;
  for (let j = i - L; j < i; j++) {
    const b = barAt(ctx, j) as CandleLite;
    if (kind === 'HIGH' ? b.h >= v : b.l <= v) return false; // left side strictly beyond
  }
  for (let j = i + 1; j <= i + R; j++) {
    const b = barAt(ctx, j) as CandleLite;
    if (kind === 'HIGH' ? b.h > v : b.l < v) return false; // right side may tie: earlier bar wins
  }
  return true;
}

function lowestOrHighestConfirmed(
  swings: readonly Swing[],
  kind: 'HIGH' | 'LOW',
  afterIndex: number,
  uptoIndex: number,
): Swing | null {
  let best: Swing | null = null;
  for (const s of swings) {
    if (s.kind !== kind || s.barIndex <= afterIndex || s.barIndex > uptoIndex) continue;
    if (best === null || (kind === 'HIGH' ? s.level > best.level : s.level < best.level)) best = s;
  }
  return best;
}

interface Out {
  state: ScaleState;
  events: EngineEvent[];
}

/**
 * Event order inside one candle: structure breaks (using only swings known before this candle), then
 * swings this candle confirms, then trend initialisation / provisional-level upgrades.
 */
export function stepScale(
  ctx: ScaleCtx,
  scale: Scale,
  input: ScaleState,
  L: number,
  R: number,
): Out {
  const events: EngineEvent[] = [];
  const bar = barAt(ctx, ctx.n) as CandleLite;
  const closeTime = bar.t + ctx.tfMs;
  const emit = (type: EngineEventType, anchor: number, data: EventData): void => {
    events.push({
      id: eventId(ctx, type, scale, anchor),
      type,
      tf: ctx.tf,
      scale,
      time: closeTime,
      anchorOpenTime: anchor,
      data,
    });
  };

  let swings = input.swings;
  let trend = input.trend;
  let prot: ProtectedLevel | null = input.protected;
  const buf = ctx.cfg.break.bufferAtrMult * ctx.atr;
  const wick = !ctx.cfg.break.requireCloseBeyond;
  const upPrice = wick ? bar.h : bar.c;
  const downPrice = wick ? bar.l : bar.c;
  const body = Math.abs(bar.c - bar.o);
  const bodyAtr = ctx.atr > 0 ? body / ctx.atr : 0;
  const gap =
    ctx.prevClose !== null &&
    ctx.atr > 0 &&
    Math.abs(bar.o - ctx.prevClose) > ctx.cfg.break.gapAtrMult * ctx.atr;

  const breakData = (broken: Swing | null, crossed: number, extra: EventData): EventData => ({
    brokenSwingId: broken?.id ?? null,
    brokenLevel: broken?.level ?? (prot ? prot.level : null),
    breakOpenTime: bar.t,
    displacement: ctx.atr > 0 && bodyAtr >= ctx.cfg.displacement.bodyAtrMult,
    bodyAtr,
    multiBreak: crossed > 1,
    gapBreak: gap,
    ...extra,
  });

  const markBroken = (kind: 'HIGH' | 'LOW', price: number): Swing[] => {
    const crossed = swings.filter((s) =>
      kind === 'HIGH'
        ? !s.broken && s.kind === 'HIGH' && price > s.level + buf
        : !s.broken && s.kind === 'LOW' && price < s.level - buf,
    );
    if (crossed.length > 0) {
      swings = swings.map((s) => (crossed.includes(s) ? { ...s, broken: true } : s));
    }
    return crossed;
  };

  const latestUnbroken = (kind: 'HIGH' | 'LOW'): Swing | null => {
    for (let i = swings.length - 1; i >= 0; i--) {
      const s = swings[i] as Swing;
      if (s.kind === kind && !s.broken) return s;
    }
    return null;
  };

  // 1. Structure breaks.
  if (trend === 'BULL') {
    if (prot && downPrice < prot.level - buf) {
      const crossed = markBroken('LOW', downPrice);
      const brokenSwing = crossed.find((s) => s.barIndex === prot?.barIndex) ?? null;
      const data = breakData(brokenSwing, crossed.length, { protectedLevel: prot.level });
      const leg = spanExtreme(ctx, prot.barIndex, ctx.n, 'HIGH');
      emit('CHOCH_DOWN', bar.t, data);
      trend = 'BEAR';
      prot = {
        level: leg.level,
        barIndex: leg.index,
        provisional: false,
        spanFrom: leg.index,
        spanTo: ctx.n,
      };
    } else {
      const target = latestUnbroken('HIGH');
      if (target && upPrice > target.level + buf) {
        const crossed = markBroken('HIGH', upPrice);
        const low = lowestOrHighestConfirmed(swings, 'LOW', target.barIndex, ctx.n);
        if (low) {
          prot = {
            level: low.level,
            barIndex: low.barIndex,
            provisional: false,
            spanFrom: target.barIndex,
            spanTo: ctx.n,
          };
        } else {
          const raw = spanExtreme(ctx, target.barIndex, ctx.n, 'LOW');
          prot = {
            level: raw.level,
            barIndex: raw.index,
            provisional: true,
            spanFrom: target.barIndex,
            spanTo: ctx.n,
          };
        }
        emit(
          'BOS_UP',
          bar.t,
          breakData(target, crossed.length, {
            protectedLevel: prot.level,
            provisional: prot.provisional,
          }),
        );
      }
    }
  } else if (trend === 'BEAR') {
    if (prot && upPrice > prot.level + buf) {
      const crossed = markBroken('HIGH', upPrice);
      const brokenSwing = crossed.find((s) => s.barIndex === prot?.barIndex) ?? null;
      const data = breakData(brokenSwing, crossed.length, { protectedLevel: prot.level });
      const leg = spanExtreme(ctx, prot.barIndex, ctx.n, 'LOW');
      emit('CHOCH_UP', bar.t, data);
      trend = 'BULL';
      prot = {
        level: leg.level,
        barIndex: leg.index,
        provisional: false,
        spanFrom: leg.index,
        spanTo: ctx.n,
      };
    } else {
      const target = latestUnbroken('LOW');
      if (target && downPrice < target.level - buf) {
        const crossed = markBroken('LOW', downPrice);
        const high = lowestOrHighestConfirmed(swings, 'HIGH', target.barIndex, ctx.n);
        if (high) {
          prot = {
            level: high.level,
            barIndex: high.barIndex,
            provisional: false,
            spanFrom: target.barIndex,
            spanTo: ctx.n,
          };
        } else {
          const raw = spanExtreme(ctx, target.barIndex, ctx.n, 'HIGH');
          prot = {
            level: raw.level,
            barIndex: raw.index,
            provisional: true,
            spanFrom: target.barIndex,
            spanTo: ctx.n,
          };
        }
        emit(
          'BOS_DOWN',
          bar.t,
          breakData(target, crossed.length, {
            protectedLevel: prot.level,
            provisional: prot.provisional,
          }),
        );
      }
    }
  }

  // 2. Swings confirmed by this candle (pivot bar = n - R).
  const pivot = ctx.n - R;
  for (const kind of ['HIGH', 'LOW'] as const) {
    if (!isPivot(ctx, pivot, L, R, kind)) continue;
    const pb = barAt(ctx, pivot) as CandleLite;
    const type: EngineEventType = kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    const swing: Swing = {
      id: eventId(ctx, type, scale, pb.t),
      kind,
      level: kind === 'HIGH' ? pb.h : pb.l,
      barIndex: pivot,
      barOpenTime: pb.t,
      confirmedAt: closeTime,
      broken: false,
    };
    swings = [...swings, swing].slice(-MAX_SWINGS);
    emit(type, pb.t, { level: swing.level, barOpenTime: pb.t, confirmedAt: closeTime });

    // A provisional protected level becomes a confirmed swing once one forms inside its span.
    const wantsKind = trend === 'BULL' ? 'LOW' : trend === 'BEAR' ? 'HIGH' : null;
    if (prot?.provisional && wantsKind === kind && pivot >= prot.spanFrom && pivot <= prot.spanTo) {
      const best = lowestOrHighestConfirmed(swings, kind, prot.spanFrom, prot.spanTo);
      if (best) {
        const previous = prot.level;
        prot = { ...prot, level: best.level, barIndex: best.barIndex, provisional: false };
        emit('PROTECTED_UPDATED', pb.t, { from: previous, to: best.level, swingId: best.id });
      }
    }
  }

  // 3. First trend: HH+HL gives BULL, LH+LL gives BEAR.
  if (trend === 'UNDEFINED') {
    const highs = swings.filter((s) => s.kind === 'HIGH').slice(-2);
    const lows = swings.filter((s) => s.kind === 'LOW').slice(-2);
    if (highs.length === 2 && lows.length === 2) {
      const [h0, h1] = highs as [Swing, Swing];
      const [l0, l1] = lows as [Swing, Swing];
      const seed = (s: Swing): ProtectedLevel => ({
        level: s.level,
        barIndex: s.barIndex,
        provisional: false,
        spanFrom: s.barIndex,
        spanTo: s.barIndex,
      });
      if (h1.level > h0.level && l1.level > l0.level) {
        trend = 'BULL';
        prot = seed(l1);
      } else if (h1.level < h0.level && l1.level < l0.level) {
        trend = 'BEAR';
        prot = seed(h1);
      }
      if (trend !== 'UNDEFINED') {
        emit('TREND_INIT', bar.t, { trend, protectedLevel: (prot as ProtectedLevel).level });
      }
    }
  }

  return { state: { swings, trend, protected: prot }, events };
}
