// Liquidity pools and sweeps (A04 section 6): equal highs/lows, previous day/week levels, sweep vs run.
import { eventId, type ScaleCtx } from './scale.js';
import type {
  CandleLite,
  EngineEvent,
  EngineEventType,
  EventData,
  LiquidityPool,
  PendingSweep,
  PeriodState,
  PoolKind,
  Swing,
} from './types.js';

const MAX_POOLS = 40;
const DAY_MS = 86_400_000;

export const emptyPeriod = (): PeriodState => ({
  dayStart: -1,
  dayHigh: 0,
  dayLow: 0,
  weekStart: -1,
  weekHigh: 0,
  weekLow: 0,
});

/** UTC day starts at 00:00; the week starts Monday 00:00 UTC (epoch day 0 was a Thursday). */
export const dayStartOf = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;
export const weekStartOf = (t: number): number => {
  const days = Math.floor(t / DAY_MS);
  return (days - ((days + 3) % 7)) * DAY_MS;
};

export interface LiquidityOut {
  pools: LiquidityPool[];
  pending: PendingSweep[];
  period: PeriodState;
  events: EngineEvent[];
}

export function stepLiquidity(
  ctx: ScaleCtx,
  poolsIn: readonly LiquidityPool[],
  pendingIn: readonly PendingSweep[],
  periodIn: PeriodState,
  newSwings: readonly Swing[],
  retained: readonly Swing[],
): LiquidityOut {
  const events: EngineEvent[] = [];
  const bar = ctx.window[ctx.n - ctx.base] as CandleLite;
  const closeTime = bar.t + ctx.tfMs;
  const atr = ctx.atr;
  const liq = ctx.cfg.liquidity;
  const emit = (type: EngineEventType, anchor: number, extra: string, data: EventData): void => {
    events.push({
      id: eventId(ctx, type, null, anchor, extra),
      type,
      tf: ctx.tf,
      scale: null,
      time: closeTime,
      anchorOpenTime: anchor,
      data,
    });
  };

  // 1. Sweeps and runs on pools that existed before this candle.
  let pools = [...poolsIn];
  const pending: PendingSweep[] = [];
  const dropped = new Set<string>();
  const tracked = new Map(pendingIn.map((p) => [p.poolId, p]));

  for (const pool of poolsIn) {
    const buy = pool.side === 'BUY';
    const min = liq.sweepMinAtrMult * atr;
    let pend = tracked.get(pool.id);
    if (!pend) {
      const pierced = buy
        ? bar.h >= pool.level + min && bar.h > pool.level
        : bar.l <= pool.level - min && bar.l < pool.level;
      if (!pierced) continue;
      pend = {
        poolId: pool.id,
        fromIndex: ctx.n,
        fromOpenTime: bar.t,
        extreme: buy ? bar.h : bar.l,
      };
    } else {
      pend = {
        ...pend,
        extreme: buy ? Math.max(pend.extreme, bar.h) : Math.min(pend.extreme, bar.l),
      };
    }
    const backInside = buy ? bar.c <= pool.level : bar.c >= pool.level;
    const data: EventData = {
      poolId: pool.id,
      poolKind: pool.kind,
      side: pool.side,
      level: pool.level,
      strength: pool.strength,
      sweepExtreme: pend.extreme,
      wickOpenTime: pend.fromOpenTime,
    };
    if (backInside) {
      emit('LIQ_SWEEP', pend.fromOpenTime, `|${pool.id}`, data);
      dropped.add(pool.id);
    } else if (ctx.n - pend.fromIndex + 1 >= liq.sweepConfirmBars) {
      emit('LIQ_RUN', pend.fromOpenTime, `|${pool.id}`, data);
      dropped.add(pool.id);
    } else {
      pending.push(pend);
    }
  }
  pools = pools.filter((p) => !dropped.has(p.id));

  const addPool = (pool: LiquidityPool): void => {
    pools = [...pools.filter((p) => p.id !== pool.id), pool].slice(-MAX_POOLS);
    emit('POOL_NEW', pool.members[0] ?? bar.t, `|${pool.id}`, {
      poolId: pool.id,
      kind: pool.kind,
      side: pool.side,
      level: pool.level,
      strength: pool.strength,
    });
  };

  // 2. Equal highs/lows from swings confirmed on this candle.
  const tol = liq.equalTolAtrMult * atr;
  const seen = new Set<string>();
  for (const sw of newSwings) {
    const key = `${sw.kind}:${sw.barOpenTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind: PoolKind = sw.kind === 'HIGH' ? 'EQH' : 'EQL';
    const existing = pools.find((p) => p.kind === kind && Math.abs(p.level - sw.level) <= tol);
    if (existing) {
      if (existing.members.includes(sw.barOpenTime)) continue;
      const level =
        kind === 'EQH' ? Math.max(existing.level, sw.level) : Math.min(existing.level, sw.level);
      addPool({
        ...existing,
        level,
        strength: existing.strength + 1,
        members: [...existing.members, sw.barOpenTime],
      });
      continue;
    }
    const mate = retained.find(
      (o) =>
        o.kind === sw.kind &&
        o.barOpenTime !== sw.barOpenTime &&
        Math.abs(o.level - sw.level) <= tol,
    );
    if (!mate) continue;
    const first = mate.barOpenTime < sw.barOpenTime ? mate : sw;
    addPool({
      id: eventId(ctx, 'POOL_NEW', null, first.barOpenTime, `|${kind}`),
      kind,
      side: sw.kind === 'HIGH' ? 'BUY' : 'SELL',
      level: kind === 'EQH' ? Math.max(mate.level, sw.level) : Math.min(mate.level, sw.level),
      strength: 2,
      createdAt: closeTime,
      members: [mate.barOpenTime, sw.barOpenTime].sort((a, b) => a - b),
    });
  }

  // 3. Previous day / week levels, created when the UTC period rolls over.
  let period = periodIn;
  const dayStart = dayStartOf(bar.t);
  const weekStart = weekStartOf(bar.t);
  if (period.dayStart < 0) {
    period = {
      dayStart,
      dayHigh: bar.h,
      dayLow: bar.l,
      weekStart,
      weekHigh: bar.h,
      weekLow: bar.l,
    };
  } else {
    const rollDay = dayStart > period.dayStart;
    const rollWeek = weekStart > period.weekStart;
    const mk = (kind: PoolKind, level: number, anchor: number): void => {
      const buy = kind === 'PDH' || kind === 'PWH';
      pools = pools.filter((p) => p.kind !== kind);
      addPool({
        id: eventId(ctx, 'POOL_NEW', null, anchor, `|${kind}`),
        kind,
        side: level > bar.c ? 'BUY' : level < bar.c ? 'SELL' : buy ? 'BUY' : 'SELL',
        level,
        strength: 1,
        createdAt: closeTime,
        members: [anchor],
      });
    };
    if (rollDay) {
      mk('PDH', period.dayHigh, period.dayStart);
      mk('PDL', period.dayLow, period.dayStart);
    }
    if (rollWeek) {
      mk('PWH', period.weekHigh, period.weekStart);
      mk('PWL', period.weekLow, period.weekStart);
    }
    period = {
      dayStart: rollDay ? dayStart : period.dayStart,
      dayHigh: rollDay ? bar.h : Math.max(period.dayHigh, bar.h),
      dayLow: rollDay ? bar.l : Math.min(period.dayLow, bar.l),
      weekStart: rollWeek ? weekStart : period.weekStart,
      weekHigh: rollWeek ? bar.h : Math.max(period.weekHigh, bar.h),
      weekLow: rollWeek ? bar.l : Math.min(period.weekLow, bar.l),
    };
  }
  return { pools, pending, period, events };
}
