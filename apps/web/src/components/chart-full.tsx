'use client';
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
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
import { useEffect, useRef } from 'react';
import type { CandleRow } from '../lib/market';
import { labelOf, lineStyle, type Palette, readPalette, zoneStyle } from '../lib/overlay-style';
import { formatPrice, type Overlay, type StructureMark } from '../lib/overlays';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Draws zones and levels in the chart's own price coordinates, so they stay locked to the candles. */
class OverlayPrimitive implements ISeriesPrimitive<Time> {
  items: Overlay[] = [];
  palette: Palette = readPalette();
  precision = 2;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private request: (() => void) | null = null;

  attached(p: SeriesAttachedParameter<Time>): void {
    this.series = p.series as ISeriesApi<'Candlestick'>;
    this.request = p.requestUpdate;
  }
  detached(): void {
    this.series = null;
    this.request = null;
  }
  update(items: Overlay[], palette: Palette, precision: number): void {
    this.items = items;
    this.palette = palette;
    this.precision = precision;
    this.request?.();
  }
  updateAllViews(): void {}
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
              ctx.font = '11px Inter, system-ui, sans-serif';
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'right';
              const labels: { y: number; text: string; color: string }[] = [];
              for (const o of self.items) {
                if (o.kind === 'zone') {
                  const y1 = s.priceToCoordinate(o.top);
                  const y2 = s.priceToCoordinate(o.bottom);
                  if (y1 === null || y2 === null) continue;
                  const st = zoneStyle(o.tone, self.palette);
                  const top = Math.min(y1, y2);
                  const h = Math.max(1, Math.abs(y2 - y1));
                  ctx.fillStyle = st.fill;
                  ctx.fillRect(0, top, mediaSize.width, h);
                  if (st.stroke) {
                    ctx.strokeStyle = st.stroke;
                    ctx.setLineDash(o.tone === 'ob' ? [] : [3, 3]);
                    ctx.lineWidth = 1;
                    ctx.strokeRect(0.5, top + 0.5, mediaSize.width - 1, Math.max(0, h - 1));
                  }
                  labels.push({
                    y: top + Math.min(h / 2, 9),
                    text: labelOf(o, st.glyph, ''),
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
                  ctx.moveTo(0, y);
                  ctx.lineTo(mediaSize.width, y);
                  ctx.stroke();
                  labels.push({
                    y: y - 7,
                    text: labelOf(o, st.glyph, formatPrice(o.price, self.precision)),
                    color: st.color,
                  });
                }
              }
              ctx.setLineDash([]);
              // Labels never overlap: walk from the top and push each one down to a free row.
              labels.sort((a, b) => a.y - b.y);
              let floor = Number.NEGATIVE_INFINITY;
              for (const l of labels) {
                const y = Math.max(l.y, floor);
                floor = y + 14;
                const w = ctx.measureText(l.text).width;
                ctx.fillStyle = self.palette.surface;
                ctx.globalAlpha = 0.8;
                ctx.fillRect(mediaSize.width - 70 - w - 3, y - 7, w + 6, 14);
                ctx.globalAlpha = 1;
                ctx.fillStyle = l.color;
                ctx.fillText(l.text, mediaSize.width - 70, y);
              }
            });
          },
        }),
      },
    ];
  }
}

const lineColor = () =>
  getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
const chartStyle = (p: Palette) => ({
  layout: { background: { color: 'transparent' }, textColor: p.muted, attributionLogo: true },
  grid: { vertLines: { color: lineColor() }, horzLines: { color: lineColor() } },
});

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

export default function ChartFull({
  candles,
  overlays,
  marks,
  precision,
}: {
  candles: CandleRow[];
  overlays: Overlay[];
  marks: StructureMark[] | null;
  precision: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const prim = useRef<OverlayPrimitive>(new OverlayPrimitive());
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const framed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per mount; the data effects below update it
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const p = readPalette();
    const c = createChart(el, {
      autoSize: true,
      ...chartStyle(p),
      rightPriceScale: { borderColor: lineColor() },
      timeScale: { borderColor: lineColor(), timeVisible: true },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: p.bull,
      downColor: p.bear,
      wickUpColor: p.bull,
      wickDownColor: p.bear,
      borderVisible: false,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    });
    s.attachPrimitive(prim.current);
    markers.current = createSeriesMarkers(s, []);
    chart.current = c;
    series.current = s;
    // Re-read the tokens when the theme changes.
    const mo = new MutationObserver(() => {
      const q = readPalette();
      c.applyOptions({
        ...chartStyle(q),
        rightPriceScale: { borderColor: lineColor() },
        timeScale: { borderColor: lineColor() },
      });
      s.applyOptions({
        upColor: q.bull,
        downColor: q.bear,
        wickUpColor: q.bull,
        wickDownColor: q.bear,
      });
      prim.current.update(prim.current.items, q, prim.current.precision);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mo.disconnect();
      c.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
    s.setData(
      candles.map((k) => ({ time: sec(k.openTime), open: k.o, high: k.h, low: k.l, close: k.c })),
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
    prim.current.update(overlays, readPalette(), precision);
  }, [overlays, precision]);

  useEffect(() => {
    const p = readPalette();
    const m: SeriesMarker<Time>[] = (marks ?? [])
      // Internal swings are dots by the hundred; keep the external swings and every break.
      .filter((x) => x.kind === 'BREAK' || x.scale === 'external')
      .map((x) => ({
        time: sec(x.time),
        position: (x.kind === 'LOW' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
        shape:
          x.kind === 'BREAK'
            ? ('square' as const)
            : x.scale === 'external'
              ? ('circle' as const)
              : ('circle' as const),
        color: x.scale === 'external' ? p.text : p.muted,
        size: x.scale === 'external' ? 1 : 0.5,
        text:
          x.kind === 'BREAK'
            ? x.label
            : x.scale === 'external'
              ? x.kind === 'HIGH'
                ? 'SH'
                : 'SL'
              : '',
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    markers.current?.setMarkers(m);
  }, [marks]);

  return <div ref={box} className="size-full" />;
}
