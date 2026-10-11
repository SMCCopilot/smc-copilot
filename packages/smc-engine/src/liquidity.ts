// Liquidity pools and sweeps (A04 section 6): equal highs/lows, previous day/week levels, sweep vs run.
import { eventId, type ScaleCtx } from './scale.js';
import {
  dayStartOf,
  inSession,
  monthStartOf,
  sessionInstanceStart,
  weekStartOf,
} from './sessions.js';
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
const MAX_MEMBERS = 20;
const HOUR_MS = 3_600_000;

export const emptyPeriod = (): PeriodState => ({
  dayStart: -1,
  dayHigh: 0,
  dayLow: 0,
  weekStart: -1,
  weekHigh: 0,
  weekLow: 0,
  monthStart: -1,
  dayOpen: 0,
  weekOpen: 0,
  monthOpen: 0,
  sessions: {},
});
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
      // A wick past the level by the minimum, or any close beyond it (a possible run).
      const pierced = buy
        ? (bar.h >= pool.level + min && bar.h > pool.level) || bar.c > pool.level
        : (bar.l <= pool.level - min && bar.l < pool.level) || bar.c < pool.level;
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
    const next = [...pools.filter((p) => p.id !== pool.id), pool];
    // Over the cap, drop the oldest equal-level pool first so churn cannot evict day/week/session levels.
    while (next.length > MAX_POOLS) {
      const i = next.findIndex((p) => p.kind === 'EQH' || p.kind === 'EQL');
      next.splice(i >= 0 && i < next.length - 1 ? i : 0, 1);
    }
    pools = next;
    emit('POOL_NEW', pool.members[0] ?? bar.t, `|${pool.id}|s${pool.strength}`, {
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
        members: [...existing.members, sw.barOpenTime].slice(-MAX_MEMBERS),
      });
      continue;
    }
    const pooled = (t: number): boolean =>
      pools.some((p) => p.kind === kind && p.members.includes(t));
    const mate = retained.find(
      (o) =>
        o.kind === sw.kind &&
        o.barOpenTime !== sw.barOpenTime &&
        !pooled(o.barOpenTime) &&
        Math.abs(o.level - sw.level) <= tol,
    );
    if (!mate) continue;
    const first = mate.barOpenTime < sw.barOpenTime ? mate : sw;
    addPool({
      id: eventId(ctx, 'POOL_NEW', null, first.barOpenTime, `|${kind}|${closeTime}`),
      kind,
      side: sw.kind === 'HIGH' ? 'BUY' : 'SELL',
      level: kind === 'EQH' ? Math.max(mate.level, sw.level) : Math.min(mate.level, sw.level),
      strength: 2,
      createdAt: closeTime,
      members: [mate.barOpenTime, sw.barOpenTime].sort((a, b) => a - b),
    });
  }

  // 3. Previous day / week levels and open prices, created when the UTC period rolls over.
  let period = periodIn;
  const dayStart = dayStartOf(bar.t);
  const weekStart = weekStartOf(bar.t);
  const monthStart = monthStartOf(bar.t);
  const sideFor = (level: number, buy: boolean): 'BUY' | 'SELL' =>
    level > bar.c ? 'BUY' : level < bar.c ? 'SELL' : buy ? 'BUY' : 'SELL';
  const replace = (pool: LiquidityPool): void => {
    pools = pools.filter((p) => !(p.kind === pool.kind && p.label === pool.label));
    addPool(pool);
  };
  const mk = (kind: PoolKind, level: number, anchor: number, label?: string): void => {
    const buy = kind === 'PDH' || kind === 'PWH' || kind === 'SESH';
    replace({
      id: eventId(ctx, 'POOL_NEW', null, anchor, `|${kind}${label ? `:${label}` : ''}`),
      kind,
      side: sideFor(level, buy),
      level,
      strength: 1,
      createdAt: closeTime,
      members: [anchor],
      ...(label ? { label } : {}),
    });
  };
  if (period.dayStart < 0) {
    period = {
      ...period,
      dayStart,
      dayHigh: bar.h,
      dayLow: bar.l,
      weekStart,
      weekHigh: bar.h,
      weekLow: bar.l,
      monthStart,
      dayOpen: bar.o,
      weekOpen: bar.o,
      monthOpen: bar.o,
    };
  } else {
    const rollDay = dayStart > period.dayStart;
    const rollWeek = weekStart > period.weekStart;
    const rollMonth = monthStart > period.monthStart;
    period = {
      ...period,
      dayStart: rollDay ? dayStart : period.dayStart,
      dayHigh: rollDay ? bar.h : Math.max(period.dayHigh, bar.h),
      dayLow: rollDay ? bar.l : Math.min(period.dayLow, bar.l),
      dayOpen: rollDay ? bar.o : period.dayOpen,
      weekStart: rollWeek ? weekStart : period.weekStart,
      weekHigh: rollWeek ? bar.h : Math.max(period.weekHigh, bar.h),
      weekLow: rollWeek ? bar.l : Math.min(period.weekLow, bar.l),
      weekOpen: rollWeek ? bar.o : period.weekOpen,
      monthStart: rollMonth ? monthStart : period.monthStart,
      monthOpen: rollMonth ? bar.o : period.monthOpen,
    };
  }
  // The previous day/week level is known the moment the last candle of the period closes (not a period later).
  if (closeTime === dayStartOf(closeTime)) {
    mk('PDH', period.dayHigh, period.dayStart);
    mk('PDL', period.dayLow, period.dayStart);
  }
  if (closeTime === weekStartOf(closeTime)) {
    mk('PWH', period.weekHigh, period.weekStart);
    mk('PWL', period.weekLow, period.weekStart);
  }

  // 4. Session highs/lows become pools when the session ends (intraday timeframes only).
  if (ctx.tfMs <= HOUR_MS) {
    const running: PeriodState['sessions'] = { ...period.sessions };
    const finish = (id: string, cur: { start: number; high: number; low: number }): void => {
      mk('SESH', cur.high, cur.start, id);
      mk('SESL', cur.low, cur.start, id);
    };
    for (const sd of ctx.cfg.sessions) {
      const cur = running[sd.id];
      if (inSession(bar.t, sd)) {
        const start = sessionInstanceStart(bar.t, sd);
        if (cur && cur.start === start) {
          running[sd.id] = {
            start,
            high: Math.max(cur.high, bar.h),
            low: Math.min(cur.low, bar.l),
          };
        } else {
          if (cur) finish(sd.id, cur);
          running[sd.id] = { start, high: bar.h, low: bar.l };
        }
      } else if (cur) {
        finish(sd.id, cur);
        delete running[sd.id];
      }
    }
    period = { ...period, sessions: running };
  }
  return { pools, pending, period, events };
}
