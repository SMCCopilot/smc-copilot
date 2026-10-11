// Fair value gaps and order blocks (A04 section 5): detection at candle close and lifecycle updates.
import { eventId, type ScaleCtx } from './scale.js';
import type {
  CandleLite,
  Dir,
  EngineEvent,
  EngineEventType,
  EventData,
  Fvg,
  OrderBlock,
  Scale,
} from './types.js';

const MAX_FVGS = 40;
const MAX_OBS = 24;

/** A structure break on this candle plus where its leg began. */
export interface BreakInfo {
  type: 'BOS_UP' | 'BOS_DOWN' | 'CHOCH_UP' | 'CHOCH_DOWN';
  scale: Scale;
  eventId: string;
  legOriginIndex: number;
}

export interface ZoneOut {
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  events: EngineEvent[];
}

export function stepZones(
  ctx: ScaleCtx,
  fvgsIn: readonly Fvg[],
  obsIn: readonly OrderBlock[],
  breaks: readonly BreakInfo[],
): ZoneOut {
  const events: EngineEvent[] = [];
  const bar = ctx.window[ctx.n - ctx.base] as CandleLite;
  const at = (i: number): CandleLite | undefined => ctx.window[i - ctx.base];
  const closeTime = bar.t + ctx.tfMs;
  const atr = ctx.atr;
  const emit = (type: EngineEventType, anchor: number, data: EventData): void => {
    events.push({
      id: eventId(ctx, type, null, anchor),
      type,
      tf: ctx.tf,
      scale: null,
      time: closeTime,
      anchorOpenTime: anchor,
      data,
    });
  };

  // 1. Lifecycle of zones that existed before this candle.
  const fvgs: Fvg[] = [];
  for (const z of fvgsIn) {
    let f = z;
    const bull = f.dir === 'BULL';
    const age = ctx.n - f.barIndex;
    if (age > ctx.cfg.ob.maxAgeBars) {
      emit('FVG_EXPIRED', f.createdAt - ctx.tfMs, { zoneId: f.id });
      continue;
    }
    const enters = bull ? bar.l <= f.top : bar.h >= f.bottom;
    const reachesCe = bull ? bar.l <= f.ce : bar.h >= f.ce;
    const closesThrough = bull ? bar.c < f.bottom : bar.c > f.top;
    const note = (type: EngineEventType): void =>
      emit(type, f.createdAt - ctx.tfMs, { zoneId: f.id, causeOpenTime: bar.t, dir: f.dir });

    if (f.status === 'OPEN' && enters) {
      f = { ...f, status: 'TESTED' };
      note('FVG_TESTED');
    }
    if (f.status === 'TESTED') {
      const filled = ctx.cfg.fvg.mitigation === 'TOUCH' ? reachesCe : closesThrough;
      if (filled) {
        f = { ...f, status: 'FILLED' };
        note('FVG_FILLED');
      }
    }
    if (f.status === 'FILLED' && !f.closedThrough && closesThrough) {
      f = { ...f, closedThrough: true };
    } else if (f.status === 'FILLED' && f.closedThrough) {
      const retests = bull ? bar.h >= f.bottom : bar.l <= f.top;
      const heldBelow = bull ? bar.c <= f.bottom : bar.c >= f.top;
      if (retests && heldBelow) {
        f = { ...f, status: 'INVERTED' };
        note('FVG_INVERTED');
      }
    }
    fvgs.push(f);
  }

  const obs: OrderBlock[] = [];
  for (const o of obsIn) {
    let b = o;
    const bull = b.dir === 'BULL';
    if (ctx.n - b.createdAtIndex > ctx.cfg.ob.maxAgeBars) {
      emit('OB_EXPIRED', b.barOpen, { zoneId: b.id });
      continue;
    }
    if (bull ? bar.c < b.bottom : bar.c > b.top) {
      emit('OB_MITIGATED', b.barOpen, { zoneId: b.id, causeOpenTime: bar.t, dir: b.dir });
      continue;
    }
    const overlaps = bull ? bar.l <= b.top : bar.h >= b.bottom;
    if (overlaps && !b.inside) {
      b = { ...b, status: 'TESTED', touches: b.touches + 1, inside: true };
      emit('OB_TESTED', b.barOpen, {
        zoneId: b.id,
        touches: b.touches,
        causeOpenTime: bar.t,
        dir: b.dir,
      });
    } else if (!overlaps && b.inside) {
      b = { ...b, inside: false };
    }
    obs.push(b);
  }

  // 2. New FVG formed by the last three candles.
  const c0 = at(ctx.n - 2);
  const c1 = at(ctx.n - 1);
  if (c0 && c1) {
    const dir: Dir | null = bar.l > c0.h ? 'BULL' : bar.h < c0.l ? 'BEAR' : null;
    if (dir) {
      const top = dir === 'BULL' ? bar.l : c0.l;
      const bottom = dir === 'BULL' ? c0.h : bar.h;
      const size = top - bottom;
      if (size >= ctx.cfg.fvg.minSizeAtrMult * atr) {
        const type: EngineEventType = dir === 'BULL' ? 'FVG_BULL' : 'FVG_BEAR';
        const id = eventId(ctx, type, null, c1.t);
        const displacement =
          atr > 0 && Math.abs(c1.c - c1.o) >= ctx.cfg.displacement.bodyAtrMult * atr;
        const sizeAtr = atr > 0 ? size / atr : 0;
        fvgs.push({
          id,
          dir,
          top,
          bottom,
          ce: (top + bottom) / 2,
          barIndex: ctx.n,
          createdAt: closeTime,
          status: 'OPEN',
          closedThrough: false,
          displacement,
          sizeAtr,
        });
        emit(type, c1.t, {
          zoneId: id,
          top,
          bottom,
          ce: (top + bottom) / 2,
          displacement,
          sizeAtr,
        });
      }
    }
  }

  // 3. New order blocks from structure breaks on this candle.
  // External breaks first so a block both scales found keeps the more significant tag.
  const ordered = [...breaks].sort((a, b) =>
    a.scale === b.scale ? 0 : a.scale === 'external' ? -1 : 1,
  );
  for (const brk of ordered) {
    const dir: Dir = brk.type.endsWith('UP') ? 'BULL' : 'BEAR';
    const origin = Math.max(brk.legOriginIndex, ctx.base);
    let dispIdx = -1;
    let dispRatio = 0;
    for (let i = origin + 1; i <= ctx.n; i++) {
      const b = at(i);
      if (!b || atr <= 0) continue;
      const ratio = Math.abs(b.c - b.o) / atr;
      if (ratio >= ctx.cfg.displacement.bodyAtrMult) {
        dispIdx = i;
        dispRatio = ratio;
        break;
      }
    }
    const hasFvgInLeg = fvgs.some((f) => f.dir === dir && f.barIndex > origin);
    if (ctx.cfg.ob.requireDisplacement && dispIdx < 0 && !hasFvgInLeg) continue;
    const limit = dispIdx >= 0 ? dispIdx - 1 : ctx.n;
    let ob: CandleLite | undefined;
    let obIdx = -1;
    for (let i = limit; i >= origin; i--) {
      const b = at(i);
      if (b && (dir === 'BULL' ? b.c < b.o : b.c > b.o)) {
        ob = b;
        obIdx = i;
        break;
      }
    }
    if (!ob) continue;
    const wick = ctx.cfg.ob.zoneBasis === 'WICK';
    const top = wick ? ob.h : Math.max(ob.o, ob.c);
    const bottom = wick ? ob.l : Math.min(ob.o, ob.c);
    if (obs.some((o) => o.dir === dir && o.barOpen === ob.t)) continue;
    const type: EngineEventType = dir === 'BULL' ? 'OB_BULL' : 'OB_BEAR';
    const id = eventId(ctx, type, brk.scale, ob.t, `|${bar.t}`);
    const sizeAtr = atr > 0 ? (top - bottom) / atr : 0;
    obs.push({
      id,
      dir,
      top,
      bottom,
      barIndex: obIdx,
      barOpen: ob.t,
      createdAtIndex: ctx.n,
      createdAt: closeTime,
      status: 'FRESH',
      touches: 0,
      inside: false,
      displacementRatio: dispRatio,
      hasFvgInLeg,
      sizeAtr,
      scale: brk.scale,
      breakEventId: brk.eventId,
    });
    emit(type, ob.t, {
      zoneId: id,
      top,
      bottom,
      sizeAtr,
      displacementRatio: dispRatio,
      hasFvgInLeg,
      breakEventId: brk.eventId,
      breakScale: brk.scale,
    });
  }

  return { fvgs: fvgs.slice(-MAX_FVGS), orderBlocks: obs.slice(-MAX_OBS), events };
}
