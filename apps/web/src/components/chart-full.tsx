'use client';
import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import type { CandleRow } from '../lib/market';
import { lineStyle, type Palette, readPalette, withAlpha, zoneStyle } from '../lib/overlay-style';
import { formatPrice, type Overlay, type StructureMark, snapToBar } from '../lib/overlays';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

/**
 * Draws zones and levels in the chart's own coordinates. A zone or level that has a formation time starts at that
 * candle and runs to the right edge (as on any SMC chart); the rest span the whole width. Labels sit at the right edge,
 * kept apart from each other.
 */
class OverlayPrimitive implements ISeriesPrimitive<Time> {
  items: Overlay[] = [];
  palette: Palette = readPalette();
  precision = 2;
  /** Open times (seconds) of the candles on the chart, ascending. */
  bars: number[] = [];
  private series: ISeriesApi<'Candlestick'> | null = null;
  private chart: IChartApi | null = null;
  private request: (() => void) | null = null;

  attached(p: SeriesAttachedParameter<Time>): void {
    this.series = p.series as ISeriesApi<'Candlestick'>;
    this.chart = p.chart;
    this.request = p.requestUpdate;
  }
  detached(): void {
    this.series = null;
    this.chart = null;
    this.request = null;
  }
  update(items: Overlay[], palette: Palette, precision: number, bars: number[]): void {
    this.items = items;
    this.palette = palette;
    this.precision = precision;
    this.bars = bars;
    this.request?.();
  }
  updateAllViews(): void {}

  /** x of the candle a formation time falls on; 0 when it is older than the chart, null when unknown. */
  private xOf(from: string | undefined): number | null {
    if (!from || !this.chart || this.bars.length === 0) return 0;
    const bar = snapToBar(this.bars, Math.floor(new Date(from).getTime() / 1000));
    if (bar === null) return 0;
    const x = this.chart.timeScale().timeToCoordinate(bar as UTCTimestamp);
    return x === null ? 0 : Math.max(0, x);
  }

  paneViews() {
    const self = this;
    return [
      {
        zOrder: () => 'bottom' as const,
        renderer: () => ({
          draw(target: Target) {
            // biome-ignore lint/correctness/useHookAtTopLevel: lightweight-charts API name, not a React hook
            target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
              const s = self.series;
              if (!s) return;
              const right = mediaSize.width;
              ctx.font = '11px Inter, system-ui, sans-serif';
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'right';
              const labels: { y: number; text: string; color: string }[] = [];
              for (const o of self.items) {
                const x0 = self.xOf(o.from);
                if (x0 === null) continue;
                if (o.kind === 'zone') {
                  const y1 = s.priceToCoordinate(o.top);
                  const y2 = s.priceToCoordinate(o.bottom);
                  if (y1 === null || y2 === null) continue;
                  const st = zoneStyle(o.tone, self.palette);
                  const top = Math.min(y1, y2);
                  const h = Math.max(1, Math.abs(y2 - y1));
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
                  labels.push({
                    y: top + Math.min(h / 2, 9),
                    text: o.label,
                    color: self.palette.text,
                  });
                } else {
                  const y = s.priceToCoordinate(o.price);
                  if (y === null) continue;
                  const st = lineStyle(o.tone, self.palette, o.up);
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
                    text: `${o.label} ${formatPrice(o.price, self.precision)}`,
                    color: st.color,
                  });
                }
              }
              // Labels never overlap: spread them down from the top, then draw on a soft plate so they stay legible.
              const ys = labels.map((l) => l.y);
              const spread = ((): number[] => {
                const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
                const out = new Array<number>(ys.length);
                let floor = Number.NEGATIVE_INFINITY;
                for (const o of idx) {
                  const y = Math.max(o.y, floor);
                  out[o.i] = y;
                  floor = y + 14;
                }
                return out;
              })();
              labels.forEach((l, i) => {
                const y = spread[i] as number;
                const w = ctx.measureText(l.text).width;
                ctx.fillStyle = withAlpha(self.palette.surface, 0.78);
                ctx.fillRect(right - w - 10, y - 7, w + 8, 14);
                ctx.fillStyle = l.color;
                ctx.fillText(l.text, right - 6, y);
              });
            });
          },
        }),
      },
    ];
  }
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chartStyle = (p: Palette) => ({
  layout: {
    background: { color: 'transparent' },
    textColor: p.muted,
    attributionLogo: true,
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 11,
  },
  grid: {
    vertLines: { color: withAlpha(css('--border') || '#888888', 0.35) },
    horzLines: { color: withAlpha(css('--border') || '#888888', 0.35) },
  },
  crosshair: { mode: CrosshairMode.Normal },
});

interface Ohlc {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ChartFullProps {
  candles: CandleRow[];
  overlays: Overlay[];
  marks: StructureMark[] | null;
  precision: number;
  /** "BTC/USDT · Binance · 1D": shown top left like any chart's title. */
  title: string;
  /** Milliseconds one candle lasts, for the countdown to its close. */
  barMs: number;
  /** Increase to ask the chart to show the latest bars again (the Fit button). */
  fitSignal?: number;
}

export default function ChartFull({
  candles,
  overlays,
  marks,
  precision,
  title,
  barMs,
  fitSignal = 0,
}: ChartFullProps) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const prim = useRef<OverlayPrimitive>(new OverlayPrimitive());
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const framed = useRef(false);
  const [hover, setHover] = useState<Ohlc | null>(null);
  const lastBar = candles[candles.length - 1];

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per mount; the data effects below update it
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = readPalette();
    const c = createChart(el, {
      autoSize: true,
      ...chartStyle(p),
      rightPriceScale: {
        borderColor: css('--border'),
        scaleMargins: { top: 0.08, bottom: 0.2 },
      },
      timeScale: { borderColor: css('--border'), timeVisible: true, rightOffset: 6 },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: p.bull,
      downColor: p.bear,
      wickUpColor: p.bull,
      wickDownColor: p.bear,
      borderVisible: false,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    s.attachPrimitive(prim.current);
    markers.current = createSeriesMarkers(s, []);
    chart.current = c;
    series.current = s;
    volume.current = v;
    c.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(s) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const vol = param.seriesData.get(v) as { value: number } | undefined;
      setHover(d ? { o: d.open, h: d.high, l: d.low, c: d.close, v: vol?.value ?? 0 } : null);
    });
    // Re-read the tokens when the theme changes.
    const mo = new MutationObserver(() => {
      const q = readPalette();
      c.applyOptions({
        ...chartStyle(q),
        rightPriceScale: { borderColor: css('--border') },
        timeScale: { borderColor: css('--border') },
      });
      s.applyOptions({
        upColor: q.bull,
        downColor: q.bear,
        wickUpColor: q.bull,
        wickDownColor: q.bear,
      });
      prim.current.update(prim.current.items, q, prim.current.precision, prim.current.bars);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mo.disconnect();
      c.remove();
      chart.current = null;
      series.current = null;
      volume.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    const v = volume.current;
    if (!s || !v) return;
    s.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
    const p = readPalette();
    s.setData(
      candles.map((k) => ({ time: sec(k.openTime), open: k.o, high: k.h, low: k.l, close: k.c })),
    );
    v.setData(
      candles.map((k) => ({
        time: sec(k.openTime),
        value: k.v,
        color: withAlpha(k.c >= k.o ? p.bull : p.bear, 0.45),
      })),
    );
    prim.current.update(
      prim.current.items,
      prim.current.palette,
      precision,
      candles.map((k) => sec(k.openTime) as number),
    );
    // Frame the latest bars once per chart, so the candles fill the pane; later updates keep the user's scroll.
    if (!framed.current && candles.length > 0) {
      framed.current = true;
      const n = candles.length;
      // After the first layout pass, so the chart's own resize does not undo it.
      requestAnimationFrame(() => {
        const ts = chart.current?.timeScale();
        if (!ts) return;
        if (n <= 120) ts.fitContent();
        else ts.setVisibleLogicalRange({ from: n - 120, to: n + 6 });
      });
    }
  }, [candles, precision]);

  useEffect(() => {
    prim.current.update(overlays, readPalette(), precision, prim.current.bars);
  }, [overlays, precision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signal itself is the trigger
  useEffect(() => {
    if (fitSignal === 0) return;
    const ts = chart.current?.timeScale();
    const n = candles.length;
    if (ts && n > 0) ts.setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 6 });
    series.current?.priceScale().applyOptions({ autoScale: true });
  }, [fitSignal]);

  useEffect(() => {
    const p = readPalette();
    const m: SeriesMarker<Time>[] = (marks ?? [])
      // Structure breaks only (BOS / CHoCH) plus the external swing points: a few clear labels, not a dot per swing.
      .filter((x) => x.kind === 'BREAK' || x.scale === 'external')
      .map((x) => ({
        time: sec(x.time),
        position: (x.kind === 'LOW' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        shape: x.kind === 'BREAK' ? ('square' as const) : ('circle' as const),
        color: x.kind === 'BREAK' ? p.accent : p.muted,
        size: x.kind === 'BREAK' ? 1 : 0.4,
        text: x.kind === 'BREAK' ? x.label.replace(' UP', ' ↑').replace(' DOWN', ' ↓') : '',
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    markers.current?.setMarkers(m);
  }, [marks]);

  const shown: Ohlc | null =
    hover ??
    (lastBar ? { o: lastBar.o, h: lastBar.h, l: lastBar.l, c: lastBar.c, v: lastBar.v } : null);
  const up = shown ? shown.c >= shown.o : true;
  const change = shown?.o ? ((shown.c - shown.o) / shown.o) * 100 : 0;
  const col = up ? 'text-bull-text' : 'text-bear-text';
  const f = (n: number) => formatPrice(n, precision);

  return (
    <div className="relative size-full">
      <div ref={box} className="size-full" />
      <div className="pointer-events-none absolute left-2 top-1.5 z-10 max-w-[calc(100%-5rem)] text-xs">
        <p className="num font-semibold text-fg">{title}</p>
        {shown && (
          <p className="num mt-0.5 flex flex-wrap gap-x-2 text-muted">
            <span>
              O <span className={col}>{f(shown.o)}</span>
            </span>
            <span>
              H <span className={col}>{f(shown.h)}</span>
            </span>
            <span>
              L <span className={col}>{f(shown.l)}</span>
            </span>
            <span>
              C <span className={col}>{f(shown.c)}</span>
            </span>
            <span className={col}>
              {change >= 0 ? '+' : ''}
              {change.toFixed(2)}%
            </span>
            <span>Vol {shown.v.toLocaleString('en-US', { maximumFractionDigits: 1 })}</span>
            <Countdown barMs={barMs} />
          </p>
        )}
      </div>
    </div>
  );
}

/** "closes in 3h 12m": counts down to the end of the current candle (candles open on whole multiples of their length, UTC). */
function Countdown({ barMs }: { barMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, (Math.floor(now / barMs) + 1) * barMs - now);
  const s = Math.floor(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const text = h > 0 ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  return <span>closes in {text}</span>;
}
