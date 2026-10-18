import { type OcrContext, OcrContextSchema } from '@smc/contracts';
import type { OcrEngineInfo, OcrLine } from './types.js';

/**
 * Turns recognised lines into the text-only `OcrContext` the server accepts (A02 section 3.2). Heuristics are
 * deliberately conservative: only text that looks like a symbol, timeframe, venue or price is kept, and free text is
 * dropped on the device. The server re-derives everything anyway; this keeps the payload small and free of noise.
 */

const VENUES = new Set([
  'BINANCE',
  'BYBIT',
  'COINBASE',
  'KRAKEN',
  'OKX',
  'BITGET',
  'BITSTAMP',
  'KUCOIN',
  'BITFINEX',
  'GATE',
  'MEXC',
  'HTX',
  'DERIBIT',
  'PHEMEX',
]);
const QUOTES = ['USDT', 'USDC', 'USD', 'BUSD', 'EUR', 'BTC', 'ETH', 'PERP'];

const SYMBOL_RE = /^(?:[A-Z]{2,12}:)?[A-Z0-9]{2,14}(?:[/-][A-Z0-9]{2,8})?(?:\.P)?$/;
const TF_RE = /^(\d{1,4})\s?(m|min|h|hr|d|w)?$/i;
const NUMBER_RE = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^[-+]?\d+(?:\.\d+)?$/;
const OHLC_RE = /([OHLC])\s*:?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

/** Coin names a chart legend may print instead of the ticker ("Bitcoin / USDT"). */
const NAMES: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL' };
/** A base and a quote written together, apart or with a slash, inside a longer line of legend text. */
const PAIR_RE = /\b(?:[A-Z]{2,12}:)?([A-Za-z]{2,10})\s?[/-]?\s?(USDT|USDC|BUSD|USD|EUR)(\.P)?\b/i;
const TF_AFTER_RE = /^[\s·•|\-–]+(\d{1,3}\s?[mhdw]|\d{1,3}|[DW])(?![\w.])/i;
const VALID_MINUTES = new Set([1, 3, 5, 15, 30, 45, 60, 120, 180, 240]);
const validTf = (t: string): boolean =>
  /[a-z]$/i.test(t.trim()) || VALID_MINUTES.has(Number(t.trim()));

const looksLikeSymbol = (t: string): boolean => {
  const u = t.toUpperCase();
  if (!SYMBOL_RE.test(u) || /^\d+$/.test(u)) return false;
  const core = u
    .replace(/^[A-Z]+:/, '')
    .replace(/\.P$/, '')
    .replace(/[/-]/g, '');
  return (
    QUOTES.some((q) => core.endsWith(q) && core.length > q.length) ||
    u.includes(':') ||
    u.endsWith('.P')
  );
};

export interface ClassifyOptions {
  roi: { w: number; h: number };
  /** Fraction of the ROI width on the right where price-axis labels sit. */
  axisFraction?: number;
}

type Kind = 'SYMBOL' | 'TIMEFRAME' | 'VENUE' | 'LAST_PRICE' | 'AXIS_LABEL' | 'OHLC_LEGEND';
interface Item {
  kind: Kind;
  text: string;
  conf: number;
  box: readonly [number, number, number, number];
}

/** Splits `BTCUSDT.P · 15 · Binance` style header lines at their separators. */
function parts(line: OcrLine): OcrLine[] {
  const segs = line.text
    .split(/\s*[·•|]\s*|,\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length <= 1) return [line];
  const [x1, y1, x2, y2] = line.box;
  const width = (x2 - x1) / segs.length;
  return segs.map((text, i) => ({
    text,
    conf: line.conf,
    box: [x1 + i * width, y1, x1 + (i + 1) * width, y2] as const,
  }));
}

/** Header legend fraction of the frame height: where TradingView-style charts print symbol, timeframe and OHLC. */
const HEADER_FRACTION = 0.25;

/**
 * Finds a symbol, its timeframe and the venue inside one long legend line such as
 * "Bitcoin/USDT - 1D - OKX  O81,489.5 H82,072.4 L81,398.8 C81,689.0", which the separator split alone misses.
 */
function scanLegend(raw: OcrLine, o: ClassifyOptions): Item[] {
  if (raw.box[1] > o.roi.h * HEADER_FRACTION) return [];
  const m = PAIR_RE.exec(raw.text);
  if (!m?.[1] || !m[2]) return [];
  // A line that is only the symbol is handled by the whole-line rules, which keep the text as printed.
  if (raw.text.trim().toUpperCase() === m[0].toUpperCase()) return [];
  const base = NAMES[m[1].toLowerCase()] ?? m[1].toUpperCase();
  const out: Item[] = [];
  const conf = Math.min(1, Math.max(0, raw.conf));
  const box = raw.box;
  out.push({ kind: 'SYMBOL', text: `${base}${m[2].toUpperCase()}${m[3] ? '.P' : ''}`, conf, box });
  const after = raw.text.slice(m.index + m[0].length);
  const tf = TF_AFTER_RE.exec(after)?.[1];
  if (tf && validTf(tf)) out.push({ kind: 'TIMEFRAME', text: tf.replace(/\s/g, ''), conf, box });
  for (const w of raw.text.split(/[^A-Za-z]+/)) {
    if (VENUES.has(w.toUpperCase())) {
      out.push({ kind: 'VENUE', text: w, conf, box });
      break;
    }
  }
  const ohlc = [...raw.text.matchAll(OHLC_RE)];
  const close = ohlc.find((x) => x[1] === 'C');
  if (close?.[2]) out.push({ kind: 'LAST_PRICE', text: close[2], conf, box });
  return out;
}

export function classifyLines(lines: readonly OcrLine[], o: ClassifyOptions): Item[] {
  const axisX = o.roi.w * (1 - (o.axisFraction ?? 0.12));
  const out: Item[] = [];
  const seen = new Set<string>();
  const add = (item: Item) => {
    const key = `${item.kind}|${item.text}`;
    if (item.kind !== 'AXIS_LABEL' && seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const raw of lines) {
    if (raw.conf >= 0.3) for (const item of scanLegend(raw, o)) add(item);
    for (const l of parts(raw)) {
      const text = l.text.trim().slice(0, 120);
      if (!text || l.conf < 0.3) continue;
      const base = { text, conf: Math.min(1, Math.max(0, l.conf)), box: l.box };
      const inHeader = l.box[1] <= o.roi.h * HEADER_FRACTION;
      const ohlc = [...text.matchAll(OHLC_RE)];
      if (ohlc.length >= 2 && inHeader) {
        add({ ...base, kind: 'OHLC_LEGEND' });
        const close = ohlc.find((m) => m[1] === 'C');
        if (close?.[2]) add({ ...base, kind: 'LAST_PRICE', text: close[2] });
        continue;
      }
      const upper = text.toUpperCase();
      if (VENUES.has(upper)) add({ ...base, kind: 'VENUE', text });
      else if (looksLikeSymbol(text)) add({ ...base, kind: 'SYMBOL', text });
      else if (
        TF_RE.test(text) &&
        text.length <= 5 &&
        validTf(text) &&
        inHeader &&
        l.box[0] < o.roi.w * 0.6
      )
        add({ ...base, kind: 'TIMEFRAME', text });
      else if (NUMBER_RE.test(text) && l.box[0] >= axisX)
        add({ ...base, kind: 'AXIS_LABEL', text });
    }
  }
  return out;
}

export interface BuildOptions extends ClassifyOptions {
  capturedAt: number;
  engine: OcrEngineInfo;
  ms: number;
  /** True when the page itself said it is TradingView (title text seen). */
  tradingView?: boolean;
}

const num = (t: string): number | null => {
  const v = Number(t.replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
};

export class OcrContextError extends Error {}

/** Builds and validates the payload. Throws if it would not pass the server's strict schema. */
export function buildOcrContext(lines: readonly OcrLine[], o: BuildOptions): OcrContext {
  const items = classifyLines(lines, o).slice(0, 64);
  // The header legend wins over look-alikes lower down (watchlists, volume legends): confidence minus a position cost.
  const rank = (i: Item) => i.conf - (i.box[1] / Math.max(1, o.roi.h)) * 0.4;
  const best = (k: Kind): Item | undefined =>
    items.filter((i) => i.kind === k).sort((a, b) => rank(b) - rank(a))[0];
  const sym = best('SYMBOL');
  const tf = best('TIMEFRAME');
  const venue = best('VENUE');
  const last = best('LAST_PRICE');
  const axis = items
    .filter((i) => i.kind === 'AXIS_LABEL')
    .map((i) => num(i.text))
    .filter((v): v is number => v !== null)
    .slice(0, 64);
  const symbolUpper = sym?.text.toUpperCase() ?? '';
  const ctx = {
    capturedAt: Math.max(0, Math.floor(o.capturedAt)),
    roi: { w: Math.max(1, o.roi.w), h: Math.max(1, o.roi.h) },
    texts: items.map((i) => ({
      kind: i.kind,
      text: i.text,
      conf: i.conf,
      box: [...i.box] as [number, number, number, number],
    })),
    derived: {
      ...(sym ? { symbolText: sym.text } : {}),
      ...(tf ? { tfText: tf.text } : {}),
      ...(venue ? { venueText: venue.text } : {}),
      ...(sym ? { isPerp: /\.P$|PERP/.test(symbolUpper) } : {}),
      ...(last && num(last.text) !== null ? { lastPrice: num(last.text) as number } : {}),
      ...(axis.length > 0 ? { axisPrices: axis } : {}),
      platform: o.tradingView ? ('TRADINGVIEW' as const) : ('UNKNOWN' as const),
    },
    engine: {
      name: o.engine.name,
      version: o.engine.version.slice(0, 32),
      backend: o.engine.backend,
      ms: Math.max(0, o.ms),
    },
  };
  const parsed = OcrContextSchema.safeParse(ctx);
  if (!parsed.success)
    throw new OcrContextError('the recognised text does not form a valid context');
  return parsed.data;
}
