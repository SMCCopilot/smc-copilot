'use client';
import type { CandleType, Chart, OverlayCreate } from 'klinecharts';
import {
  Activity,
  AlignJustify,
  Magnet,
  Minus,
  MoveUpRight,
  Pencil,
  Rows2,
  Square,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { RECT_TOOL } from '../lib/kline-smc';

const TOOLS: { name: string; label: string; Icon: typeof Minus }[] = [
  { name: 'segment', label: 'Trend line', Icon: TrendingUp },
  { name: 'horizontalStraightLine', label: 'Horizontal line', Icon: Minus },
  { name: 'rayLine', label: 'Ray', Icon: MoveUpRight },
  { name: 'parallelStraightLine', label: 'Parallel channel', Icon: Rows2 },
  { name: 'fibonacciLine', label: 'Fibonacci retracement', Icon: AlignJustify },
  { name: RECT_TOOL, label: 'Rectangle', Icon: Square },
  { name: 'brush', label: 'Freehand', Icon: Pencil },
];

const INDICATORS: { name: string; label: string; onPrice: boolean }[] = [
  { name: 'VOL', label: 'Volume', onPrice: false },
  { name: 'MA', label: 'Moving averages (MA)', onPrice: true },
  { name: 'EMA', label: 'Exponential averages (EMA)', onPrice: true },
  { name: 'BOLL', label: 'Bollinger bands', onPrice: true },
  { name: 'RSI', label: 'RSI (momentum)', onPrice: false },
  { name: 'MACD', label: 'MACD (trend)', onPrice: false },
];

const STYLES: { type: CandleType; label: string }[] = [
  { type: 'candle_solid', label: 'Candles' },
  { type: 'candle_stroke', label: 'Hollow' },
  { type: 'ohlc', label: 'Bars' },
  { type: 'area', label: 'Line' },
];

const keyOf = (k: string) => `smc-drawings:${k}`;

function save(chart: Chart, key: string): void {
  try {
    const items = chart
      .getOverlays()
      .map((o) => ({ name: o.name, points: o.points, mode: o.mode, lock: o.lock }));
    localStorage.setItem(keyOf(key), JSON.stringify(items));
  } catch {
    /* storage may be blocked: drawings then last for the visit only */
  }
}

function track(chart: Chart, key: string): Partial<OverlayCreate> {
  const done = () => {
    save(chart, key);
    return false;
  };
  return { onDrawEnd: done, onPressedMoveEnd: done, onRemoved: done };
}

/** Puts back the drawings the user made earlier on this market. */
export function loadDrawings(chart: Chart, key: string): void {
  try {
    const raw = localStorage.getItem(keyOf(key));
    if (!raw) return;
    const items = JSON.parse(raw) as {
      name: string;
      points: OverlayCreate['points'];
      mode?: string;
    }[];
    for (const o of items) {
      chart.createOverlay({
        name: o.name,
        points: o.points,
        ...track(chart, key),
      } as OverlayCreate);
    }
  } catch {
    /* an unreadable saved set is ignored */
  }
}

const btn =
  'grid size-8 shrink-0 place-items-center rounded-ctl text-muted hover:bg-s3 hover:text-fg aria-pressed:bg-s3 aria-pressed:text-accent-text';

export function ChartTools({
  chart,
  drawingsKey,
  onStyle,
}: {
  chart: Chart | null;
  drawingsKey: string;
  onStyle: (t: CandleType) => void;
}) {
  const [magnet, setMagnet] = useState(false);
  const [menu, setMenu] = useState(false);
  const [on, setOn] = useState<string[]>(['VOL']);
  const [style, setStyle] = useState<CandleType>('candle_solid');

  // The chart starts with volume only; re-read what is on it whenever the chart (re)mounts.
  useEffect(() => {
    if (chart)
      setOn(
        INDICATORS.filter((i) => chart.getIndicators({ name: i.name }).length > 0).map(
          (i) => i.name,
        ),
      );
  }, [chart]);

  const draw = (name: string) => {
    if (!chart) return;
    chart.createOverlay({
      name,
      mode: magnet ? 'weak_magnet' : 'normal',
      ...track(chart, drawingsKey),
    } as OverlayCreate);
  };

  const toggle = (name: string, onPrice: boolean) => {
    if (!chart) return;
    if (chart.getIndicators({ name }).length > 0) chart.removeIndicator({ name });
    else if (onPrice) chart.createIndicator({ name, paneId: 'candle_pane' }, true);
    else {
      const pane = chart.createIndicator(name === 'VOL' ? { name, calcParams: [] } : name);
      if (pane && name !== 'VOL') chart.setPaneOptions({ id: pane, height: 110, minHeight: 50 });
      else if (pane) chart.setPaneOptions({ id: pane, height: 80, minHeight: 40 });
    }
    setOn(
      INDICATORS.filter((i) => chart.getIndicators({ name: i.name }).length > 0).map((i) => i.name),
    );
  };

  return (
    <div className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-s1 py-1.5">
      <button
        type="button"
        aria-label="Indicators and chart style"
        title="Indicators and chart style"
        aria-expanded={menu}
        onClick={() => setMenu((o) => !o)}
        className={btn}
      >
        <Activity className="size-4" aria-hidden />
      </button>
      <span className="my-1 h-px w-5 bg-line" aria-hidden />
      {TOOLS.map(({ name, label, Icon }) => (
        <button
          key={name}
          type="button"
          aria-label={label}
          title={label}
          disabled={!chart}
          onClick={() => draw(name)}
          className={btn}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
      <span className="my-1 h-px w-5 bg-line" aria-hidden />
      <button
        type="button"
        aria-label="Snap drawings to candle highs and lows"
        title="Snap drawings to candle highs and lows"
        aria-pressed={magnet}
        onClick={() => setMagnet((m) => !m)}
        className={btn}
      >
        <Magnet className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Remove all my drawings"
        title="Remove all my drawings"
        disabled={!chart}
        onClick={() => {
          if (!chart) return;
          chart.removeOverlay();
          save(chart, drawingsKey);
        }}
        className={btn}
      >
        <Trash2 className="size-4" aria-hidden />
      </button>

      {menu && (
        <div
          role="dialog"
          aria-label="Indicators and chart style"
          className="absolute left-11 top-1 z-30 w-60 rounded-card border border-line bg-s1 p-3 text-xs shadow-lg"
        >
          <p className="font-medium text-fg">Chart style</p>
          <div className="mt-1.5 flex rounded-ctl border border-line">
            {STYLES.map((s) => (
              <button
                key={s.type}
                type="button"
                aria-pressed={style === s.type}
                onClick={() => {
                  setStyle(s.type);
                  onStyle(s.type);
                }}
                className={`flex-1 px-1.5 py-1 first:rounded-l-ctl last:rounded-r-ctl ${style === s.type ? 'accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-s3'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-3 font-medium text-fg">Indicators</p>
          <ul className="mt-1.5 space-y-1">
            {INDICATORS.map((i) => (
              <li key={i.name}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on.includes(i.name)}
                    onChange={() => toggle(i.name, i.onPrice)}
                  />
                  {i.label}
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-muted">
            Draw with the tools on the left. Your drawings stay on this market, in this browser.
          </p>
        </div>
      )}
    </div>
  );
}
