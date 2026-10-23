'use client';
import {
  type CandleType,
  type Chart,
  type DataLoader,
  dispose,
  init,
  type KLineData,
  type Period,
} from 'klinecharts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { layerState, registerSmc, SMC_LAYER } from '../lib/kline-smc';
import { klineStyles } from '../lib/kline-theme';
import type { CandleRow } from '../lib/market';
import { readPalette } from '../lib/overlay-style';
import { formatPrice, type Overlay, type StructureMark } from '../lib/overlays';
import { ChartTools, loadDrawings } from './chart-tools';

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
  /** Where the user's own drawings are remembered (one set per market, whatever the timeframe). */
  drawingsKey?: string;
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const toBar = (k: CandleRow): KLineData => ({
  timestamp: new Date(k.openTime).getTime(),
  open: k.o,
  high: k.h,
  low: k.l,
  close: k.c,
  volume: k.v,
});

function periodOf(barMs: number): Period {
  const min = Math.round(barMs / 60_000);
  if (min >= 1440) return { type: 'day', span: Math.round(min / 1440) };
  if (min >= 60) return { type: 'hour', span: Math.round(min / 60) };
  return { type: 'minute', span: Math.max(1, min) };
}

/** "closes in 3h 12m": counts down to the end of the current candle (candles open on whole multiples of their length, UTC). */
function countdown(barMs: number, now = Date.now()): string {
  const left = Math.max(0, (Math.floor(now / barMs) + 1) * barMs - now);
  const s = Math.floor(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function ChartFull({
  candles,
  overlays,
  marks,
  precision,
  title,
  barMs,
  fitSignal = 0,
  drawingsKey = 'default',
}: ChartFullProps) {
  const box = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<Chart | null>(null);
  const data = useRef<KLineData[]>([]);
  const push = useRef<((d: KLineData) => void) | null>(null);
  const style = useRef<CandleType>('candle_solid');
  const live = useRef({ barMs, precision });
  live.current = { barMs, precision };
  data.current = candles.map(toBar);

  const frame = useCallback((c: Chart) => {
    // Show the latest ~110 candles filling the pane, with room on the right for the labels.
    const size = c.getSize('candle_pane', 'main');
    const width = size?.width ?? 0;
    if (width > 0) c.setBarSpace(Math.max(3, Math.min(24, (width - 70) / 110)));
    c.scrollToRealTime();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per mount; the effects below keep it current
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    registerSmc();
    const border = css('--border');
    const c = init(el, {
      timezone: 'UTC',
      locale: 'en-US',
      styles: klineStyles(readPalette(), border),
      formatter: {
        formatExtendText: ({ type }) =>
          type === 'last_price' ? countdown(live.current.barMs) : '',
      },
    });
    if (!c) return;
    // The library puts its keyboard focus on tabindex 1, which skips the page's tab order; keep it in normal order.
    for (const n of el.querySelectorAll('[tabindex]')) n.setAttribute('tabindex', '0');
    const loader: DataLoader = {
      getBars: ({ type, callback }) => {
        callback(type === 'init' ? data.current : [], { backward: false, forward: false });
        if (type === 'init') requestAnimationFrame(() => frame(c));
      },
      subscribeBar: ({ callback }) => {
        push.current = callback;
      },
      unsubscribeBar: () => {
        push.current = null;
      },
    };
    c.setDataLoader(loader);
    c.setSymbol({ ticker: title, pricePrecision: precision, volumePrecision: 2 });
    c.setPeriod(periodOf(barMs));
    c.setOffsetRightDistance(70);
    c.setStyles({
      candle: {
        tooltip: {
          legend: {
            template: (d) => {
              const k = d.current;
              if (!k) return [];
              const up = k.close >= k.open;
              const p = readPalette();
              const col = up ? p.bull : p.bear;
              const f = (n: number) => formatPrice(n, live.current.precision);
              const pct = k.open ? ((k.close - k.open) / k.open) * 100 : 0;
              return [
                { title: 'O ', value: { text: f(k.open), color: col } },
                { title: 'H ', value: { text: f(k.high), color: col } },
                { title: 'L ', value: { text: f(k.low), color: col } },
                { title: 'C ', value: { text: f(k.close), color: col } },
                {
                  title: '',
                  value: { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: col },
                },
                {
                  title: 'Vol ',
                  value: {
                    text: (k.volume ?? 0).toLocaleString('en-US', { maximumFractionDigits: 1 }),
                    color: p.muted,
                  },
                },
              ];
            },
          },
        },
      },
    });
    c.createIndicator({ name: SMC_LAYER, paneId: 'candle_pane' }, true);
    const vol = c.createIndicator({ name: 'VOL', calcParams: [] });
    if (vol) c.setPaneOptions({ id: vol, height: 80, minHeight: 40 });
    loadDrawings(c, drawingsKey);
    setChart(c);

    // Re-read the colour tokens when the theme changes.
    const mo = new MutationObserver(() => {
      c.setStyles(klineStyles(readPalette(), css('--border'), style.current));
      layerState.palette = readPalette();
      c.overrideIndicator({ name: SMC_LAYER, extendData: Date.now() });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mo.disconnect();
      push.current = null;
      setChart(null);
      dispose(el);
    };
  }, []);

  // Candles: the first batch goes in through the loader; after that only new or changed bars are pushed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `candles` is the trigger; the converted copy lives in a ref
  useEffect(() => {
    if (!chart) return;
    layerState.bars = data.current.map((k) => k.timestamp);
    const have = chart.getDataList();
    const list = data.current;
    if (have.length === 0 || list.length === 0) {
      chart.overrideIndicator({ name: SMC_LAYER, extendData: Date.now() });
      return;
    }
    const last = have[have.length - 1] as KLineData;
    const firstNew = list[0] as KLineData;
    if (firstNew.timestamp < (have[0] as KLineData).timestamp || list.length < have.length - 1) {
      chart.resetData();
      return;
    }
    for (const k of list) {
      if (k.timestamp >= last.timestamp) push.current?.(k);
    }
    chart.overrideIndicator({ name: SMC_LAYER, extendData: Date.now() });
  }, [candles, chart]);

  useEffect(() => {
    if (!chart) return;
    layerState.items = overlays;
    layerState.precision = precision;
    layerState.palette = readPalette();
    chart.overrideIndicator({ name: SMC_LAYER, extendData: Date.now() });
  }, [overlays, precision, chart]);

  useEffect(() => {
    if (!chart) return;
    layerState.marks = marks ?? [];
    chart.overrideIndicator({ name: SMC_LAYER, extendData: Date.now() });
  }, [marks, chart]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signal itself is the trigger
  useEffect(() => {
    if (chart && fitSignal > 0) frame(chart);
  }, [fitSignal]);

  return (
    <div className="flex size-full min-h-0">
      <ChartTools
        chart={chart}
        drawingsKey={drawingsKey}
        onStyle={(t) => {
          style.current = t;
          chart?.setStyles({ candle: { type: t } });
        }}
      />
      <div ref={box} className="min-w-0 flex-1" />
    </div>
  );
}
