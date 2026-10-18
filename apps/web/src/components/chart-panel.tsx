'use client';
import { TIMEFRAME_MS, type Timeframe } from '@smc/contracts';
import { CandlestickChart, Maximize2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { ApiError } from '../lib/errors';
import { useLivePricePref, useLivePrices } from '../lib/live-prices';
import { useAnalysis, useCandles } from '../lib/market';
import { chartTitle, marketName } from '../lib/market-label';
import {
  buildOverlays,
  focusOverlays,
  LAYER_HINT,
  LAYER_LABEL,
  LAYERS,
  relevantForTf,
  structureMarks,
  visible,
} from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import { useChangeMarket } from '../lib/room';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';
import { ShareButton, SharePanel } from './share-panel';

// Chart code loads only when needed, so the first load stays small.
const ChartFull = dynamic(() => import('./chart-full'), { ssr: false });
const ChartRuler = dynamic(() => import('./chart-ruler'), { ssr: false });

const TF_BAR: { tf: Timeframe; label: string }[] = [
  { tf: '1m', label: '1m' },
  { tf: '5m', label: '5m' },
  { tf: '15m', label: '15m' },
  { tf: '1h', label: '1h' },
  { tf: '4h', label: '4h' },
  { tf: '1d', label: '1D' },
];

function Message({ text, tone }: { text: string; tone?: 'warn' }) {
  return (
    <div className="grid size-full place-items-center p-4 text-center text-muted">
      <div>
        <CandlestickChart className="mx-auto mb-2 size-8" aria-hidden />
        <p className={tone === 'warn' ? 'text-warn-text' : undefined}>{text}</p>
      </div>
    </div>
  );
}

export function ChartPanel() {
  const sel = useSelection();
  const ui = useUi();
  const inst = useInstruments();
  const setMarket = useChangeMarket();
  const [fit, setFit] = useState(0);
  const [menu, setMenu] = useState(false);
  const instrument = inst.data?.items.find((i) => i.id === sel.instrumentId);
  const analysis = useAnalysis(sel.instrumentId, sel.tf);
  const wantRaw = instrument?.rawDataAllowed === true;
  const candles = useCandles(sel.instrumentId, sel.tf, wantRaw);
  const restricted =
    candles.error instanceof ApiError && candles.error.code === 'FEED_LICENSE_RESTRICTED';
  const serverRaw = wantRaw && !restricted;
  // Our servers show prices only where the venue's terms are on record. Where they are not, prices can still come
  // straight from Binance to this browser (our servers do not relay them), and the user can switch that off.
  const canDirect = instrument?.venue === 'BINANCE' && !serverRaw;
  const pref = useLivePricePref();
  const direct = useLivePrices(
    instrument?.canonical,
    instrument?.marketType,
    sel.tf,
    canDirect && pref.on,
  );
  const directMode = canDirect && pref.on && direct.candles !== null;
  const rawMode = serverRaw || directMode;
  const precision = instrument?.pricePrecision ?? 2;

  const setup = pickSetup(analysis.data, ui.setupId, ui.dismissed);
  const allOverlays = useMemo(
    () =>
      analysis.data
        ? relevantForTf(visible(buildOverlays(analysis.data, setup), ui.layers), sel.tf)
        : [],
    [analysis.data, setup, ui.layers, sel.tf],
  );
  // With real candles, keep the levels nearest the last closed price (stable within a bar, so the picture does not jump).
  const priceCandles = directMode ? direct.candles : serverRaw ? (candles.data ?? null) : null;
  const refPrice = useMemo(() => {
    const closed = priceCandles?.filter((c) => c.status === 'CLOSED').at(-1);
    return (closed ?? priceCandles?.at(-1))?.c;
  }, [priceCandles]);
  const focused = useMemo(
    () =>
      refPrice === undefined
        ? { shown: allOverlays, hidden: 0 }
        : focusOverlays(allOverlays, 8, refPrice),
    [allOverlays, refPrice],
  );
  const overlays = refPrice === undefined ? allOverlays : focused.shown;
  const marks = useMemo(
    () => (analysis.data && ui.layers.structure ? structureMarks(analysis.data) : null),
    [analysis.data, ui.layers.structure],
  );

  const title = instrument ? chartTitle(instrument, sel.tf) : '';
  const barMs = TIMEFRAME_MS[sel.tf];
  let body: React.ReactNode;
  if (!instrument) body = <Message text="Loading markets…" />;
  else if (analysis.isPending) body = <Message text="Loading analysis…" />;
  else if (analysis.isError) {
    body = (
      <Message
        text={
          analysis.error instanceof ApiError ? analysis.error.message : 'Could not load analysis.'
        }
        tone="warn"
      />
    );
  } else if (directMode && direct.candles) {
    body = (
      <ChartFull
        key={`${sel.instrumentId}:${sel.tf}:direct`}
        candles={direct.candles}
        overlays={overlays}
        marks={marks}
        precision={precision}
        title={title}
        barMs={barMs}
        fitSignal={fit}
      />
    );
  } else if (canDirect && pref.on && direct.state === 'LOADING') {
    body = <Message text="Loading prices…" />;
  } else if (serverRaw) {
    body = candles.data ? (
      <ChartFull
        key={`${sel.instrumentId}:${sel.tf}`}
        candles={candles.data}
        overlays={overlays}
        marks={marks}
        precision={precision}
        title={title}
        barMs={barMs}
        fitSignal={fit}
      />
    ) : (
      <Message text={candles.isError ? 'Could not load candles.' : 'Loading candles…'} />
    );
  } else {
    body = <ChartRuler overlays={overlays} marks={marks} precision={precision} />;
  }

  const priceNote =
    canDirect && pref.on && direct.state === 'BLOCKED'
      ? 'Binance does not serve prices to your location, so only the levels are shown. You can still share your own chart.'
      : canDirect && pref.on && direct.state === 'ERROR'
        ? 'Could not load prices from Binance. Retrying…'
        : instrument && !rawMode && !canDirect
          ? 'Prices are not available for this market, so only the levels are shown. Share your own chart to have it explained.'
          : null;

  return (
    <section
      aria-label="Chart"
      className="flex min-h-[280px] flex-[7] flex-col border-b border-line"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <label className="sr-only" htmlFor="market">
          Chart market
        </label>
        <select
          id="market"
          value={sel.instrumentId ?? ''}
          disabled={!inst.data?.items.length}
          onChange={(e) => setMarket({ instrumentId: e.target.value })}
          className="num max-w-56 rounded-ctl border border-line bg-s3 px-2 py-1 text-sm font-medium"
        >
          {inst.data?.items.map((i) => (
            <option key={i.id} value={i.id}>
              {marketName(i)}
            </option>
          ))}
        </select>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control of toggle buttons, not a form group */}
        <div role="group" aria-label="Timeframe" className="flex rounded-ctl border border-line">
          {TF_BAR.map(({ tf, label }) => (
            <button
              key={tf}
              type="button"
              aria-pressed={sel.tf === tf}
              onClick={() => setMarket({ tf })}
              className={`px-2 py-1 text-xs first:rounded-l-ctl last:rounded-r-ctl ${sel.tf === tf ? 'accent-soft font-semibold text-accent-text' : 'text-muted hover:bg-s3'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="relative ml-auto flex items-center gap-2">
          {rawMode && (
            <button
              type="button"
              aria-label="Fit chart to the latest candles"
              title="Fit chart to the latest candles"
              onClick={() => setFit((n) => n + 1)}
              className="grid size-7 place-items-center rounded-ctl border border-line text-muted hover:bg-s3"
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </button>
          )}
          {canDirect && (
            <button
              type="button"
              aria-expanded={menu}
              onClick={() => setMenu((o) => !o)}
              className="flex items-center gap-1.5 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-s3"
            >
              <span
                className={`size-2 rounded-full ${pref.on && direct.state === 'LIVE' ? 'bg-bull' : 'bg-warn'}`}
                aria-hidden
              />
              {pref.on ? 'Binance prices' : 'Prices off'}
            </button>
          )}
          {menu && canDirect && (
            <div
              role="dialog"
              aria-label="Price source"
              className="absolute right-0 top-9 z-20 w-72 rounded-card border border-line bg-s1 p-3 text-xs shadow-lg"
            >
              <p className="font-medium text-fg">Where the prices come from</p>
              <p className="mt-1 text-muted">
                Live candles come straight from Binance to your browser, the same as opening
                Binance's own chart. They do not pass through our servers, and Binance can see your
                address as on any Binance page.
              </p>
              <button
                type="button"
                onClick={() => {
                  pref.set(!pref.on);
                  setMenu(false);
                }}
                className="mt-2 rounded-ctl border border-line px-2.5 py-1 hover:bg-s3"
              >
                {pref.on ? 'Turn prices off' : 'Turn prices on'}
              </button>
            </div>
          )}
          <ShareButton />
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form group */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1"
        role="group"
        aria-label="Chart layers"
      >
        {LAYERS.map((l) => (
          <button
            key={l}
            type="button"
            title={LAYER_HINT[l]}
            aria-pressed={ui.layers[l]}
            onClick={() => ui.toggleLayer(l)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${ui.layers[l] ? 'accent-soft border-transparent text-accent-text' : 'border-line text-muted hover:bg-s3'}`}
          >
            {LAYER_LABEL[l]}
          </button>
        ))}
        {rawMode && focused.hidden > 0 && (
          <span className="ml-auto text-[11px] text-muted">
            Showing the {focused.shown.length} levels nearest the price
          </span>
        )}
      </div>
      <SharePanel />
      {instrument?.devRawPrices && (
        <p
          role="status"
          className="border-b border-line bg-s2 px-3 py-1 text-xs font-medium text-warn-text"
        >
          DEV: raw prices enabled (local development only)
        </p>
      )}
      {priceNote && (
        <p role="status" className="border-b border-line bg-s2 px-3 py-1.5 text-xs text-warn-text">
          {priceNote}
        </p>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
