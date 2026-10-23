import { type KLineData, registerIndicator, registerOverlay } from 'klinecharts';
import { lineStyle, type Palette, withAlpha, zoneStyle } from './overlay-style';
import { formatPrice, type Overlay, type StructureMark, snapToBar } from './overlays';

/** Name of the layer that carries the analysis (zones, levels, structure marks) on the price pane. */
export const SMC_LAYER = 'SMC_LAYER';
/** Name of the rectangle drawing tool (the library has no rectangle of its own). */
export const RECT_TOOL = 'smcRect';

export interface SmcLayerState {
  items: Overlay[];
  marks: StructureMark[];
  palette: Palette;
  precision: number;
  /** Open times (ms) of the candles on the chart, ascending. */
  bars: number[];
}

export const layerState: SmcLayerState = {
  items: [],
  marks: [],
  palette: {
    accent: '#3b82f6',
    bull: '#16a34a',
    bear: '#dc2626',
    warn: '#d97706',
    muted: '#888',
    text: '#111',
    surface: '#fff',
  },
  precision: 2,
  bars: [],
};

const FONT = '11px Inter, system-ui, sans-serif';

/** Moves labels apart vertically so none overlap, keeping their order. */
function spread(ys: number[], gap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let floor = Number.NEGATIVE_INFINITY;
  for (const o of order) {
    const y = Math.max(o.y, floor);
    out[o.i] = y;
    floor = y + gap;
  }
  return out;
}

/** The candle (by open time, ms) at or just before `ts`; null when there is none. */
function barAt(list: KLineData[], ts: number): KLineData | null {
  let lo = 0;
  let hi = list.length - 1;
  let found: KLineData | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = list[mid] as KLineData;
    if (k.timestamp <= ts) {
      found = k;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

let registered = false;

/** Registers the analysis layer and the rectangle tool once per page. */
export function registerSmc(): void {
  if (registered) return;
  registered = true;

  registerIndicator<Record<string, never>>({
    name: SMC_LAYER,
    shortName: '',
    series: 'price',
    calcParams: [],
    figures: [],
    calc: (data) => data.map(() => ({})),
    draw: ({ ctx, chart, bounding, xAxis, yAxis }) => {
      const s = layerState;
      const right = bounding.width;
      const list = chart.getDataList();
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';

      const xOf = (from: string | undefined): number => {
        if (!from || s.bars.length === 0) return 0;
        const bar = snapToBar(s.bars, new Date(from).getTime());
        if (bar === null) return 0;
        return Math.max(0, xAxis.convertTimestampToPixel(bar));
      };

      const labels: { y: number; text: string; color: string }[] = [];
      for (const o of s.items) {
        const x0 = xOf(o.from);
        if (x0 >= right) continue;
        if (o.kind === 'zone') {
          const y1 = yAxis.convertToPixel(o.top);
          const y2 = yAxis.convertToPixel(o.bottom);
          const top = Math.min(y1, y2);
          const h = Math.max(1, Math.abs(y2 - y1));
          if (top > bounding.height || top + h < 0) continue;
          const st = zoneStyle(o.tone, s.palette);
          ctx.fillStyle = st.fill;
          ctx.fillRect(x0, top, right - x0, h);
          if (st.stroke) {
            ctx.strokeStyle = st.stroke;
            ctx.lineWidth = 1;
            ctx.setLineDash(o.tone === 'ob' ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(x0, top + 0.5);
            ctx.lineTo(right, top + 0.5);
            ctx.moveTo(x0, top + h - 0.5);
            ctx.lineTo(right, top + h - 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          labels.push({ y: top + Math.min(h / 2, 9), text: o.label, color: s.palette.text });
        } else {
          const y = yAxis.convertToPixel(o.price);
          if (y < 0 || y > bounding.height) continue;
          const st = lineStyle(o.tone, s.palette, o.up);
          ctx.strokeStyle = st.color;
          ctx.lineWidth = st.width;
          ctx.setLineDash(st.dash);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          labels.push({
            y: y - 7,
            text: `${o.label} ${formatPrice(o.price, s.precision)}`,
            color: st.color,
          });
        }
      }

      // Structure breaks and the main swing points, placed on the candle they belong to.
      for (const m of s.marks) {
        const k = barAt(list, new Date(m.time).getTime());
        if (!k) continue;
        const x = xAxis.convertTimestampToPixel(k.timestamp);
        if (x < 0 || x > right) continue;
        const above = m.kind !== 'LOW';
        const y = above ? yAxis.convertToPixel(k.high) - 9 : yAxis.convertToPixel(k.low) + 9;
        if (m.kind === 'BREAK') {
          const text = m.label.replace(' UP', ' ↑').replace(' DOWN', ' ↓');
          const up = /UP/.test(m.label);
          const color = up ? s.palette.bull : s.palette.bear;
          ctx.textAlign = 'center';
          const w = ctx.measureText(text).width + 8;
          ctx.fillStyle = withAlpha(s.palette.surface, 0.85);
          ctx.fillRect(x - w / 2, y - 8, w, 16);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - w / 2 + 0.5, y - 7.5, w - 1, 15);
          ctx.fillStyle = color;
          ctx.fillText(text, x, y);
          ctx.textAlign = 'right';
        } else {
          ctx.fillStyle = s.palette.muted;
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Labels at the right edge: never on top of each other, on a soft plate so they stay legible.
      const ys = spread(
        labels.map((l) => l.y),
        14,
      );
      labels.forEach((l, i) => {
        const y = ys[i] as number;
        const w = ctx.measureText(l.text).width;
        ctx.fillStyle = withAlpha(s.palette.surface, 0.78);
        ctx.fillRect(right - w - 10, y - 7, w + 8, 14);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, right - 6, y);
      });
      ctx.restore();
      return true;
    },
  });

  registerOverlay({
    name: RECT_TOOL,
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => {
      const [a, b] = coordinates;
      if (!a || !b) return [];
      return [
        {
          type: 'rect',
          attrs: {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
          },
        },
      ];
    },
  });
}
