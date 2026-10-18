'use client';
import { CandlestickChart } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { ApiError } from '../lib/errors';
import { useLivePricePref, useLivePrices } from '../lib/live-prices';
import { useAnalysis, useCandles } from '../lib/market';
import {
  buildOverlays,
  focusOverlays,
  LAYER_LABEL,
  LAYERS,
  relevantForTf,
  structureMarks,
  visible,
} from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';
import { ShareButton, SharePanel } from './share-panel';

// Chart code loads only when needed, so the first load stays small.
const ChartFull = dynamic(() => import('./chart-full'), { ssr: false });
const ChartRuler = dynamic(() => import('./chart-ruler'), { ssr: false });

const NO_RAW =
  'Raw prices unavailable for this venue; use your own chart and share your screen to explain.';
const BLOCKED =
  'Binance does not serve live prices to your location, so only the analysis levels are shown. You can still share your own chart.';

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
  const instrument = inst.data?.items.find((i) => i.id === sel.instrumentId);
  const analysis = useAnalysis(sel.instrumentId, sel.tf);
  const wantRaw = instrument?.rawDataAllowed === true;
  const candles = useCandles(sel.instrumentId, sel.tf, wantRaw);
  const restricted =
    candles.error instanceof ApiError && candles.error.code === 'FEED_LICENSE_RESTRICTED';
  const serverRaw = wantRaw && !restricted;
  // Our servers show prices only where the venue's terms are on record. Where they are not, the user can still choose
  // to see live prices that Binance sends straight to this browser (our servers do not relay them).
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
        : focusOverlays(allOverlays, 14, refPrice),
    [allOverlays, refPrice],
  );
  const overlays = refPrice === undefined ? allOverlays : focused.shown;
  const marks = useMemo(
    () => (analysis.data && ui.layers.structure ? structureMarks(analysis.data) : null),
    [analysis.data, ui.layers.structure],
  );

  let body: React.ReactNode;
  if (!instrument) body = <Message text="Pick an instrument, then start a session." />;
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
      />
    );
  } else if (canDirect && pref.on && direct.state === 'LOADING') {
    body = <Message text="Loading live prices from Binance…" />;
  } else if (serverRaw) {
    body = candles.data ? (
      <ChartFull
        key={`${sel.instrumentId}:${sel.tf}`}
        candles={candles.data}
        overlays={overlays}
        marks={marks}
        precision={precision}
      />
    ) : (
      <Message text={candles.isError ? 'Could not load candles.' : 'Loading candles…'} />
    );
  } else {
    body = <ChartRuler overlays={overlays} marks={marks} precision={precision} />;
  }

  return (
    <section
      aria-label="Chart"
      className="flex min-h-[280px] flex-[7] flex-col border-b border-line"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form group */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5"
        role="group"
        aria-label="Chart layers"
      >
        {LAYERS.map((l) => (
          <button
            key={l}
            type="button"
            aria-pressed={ui.layers[l]}
            onClick={() => ui.toggleLayer(l)}
            className={`rounded-full border px-2.5 py-1 text-xs ${ui.layers[l] ? 'accent-soft border-transparent text-accent-text' : 'border-line text-muted hover:bg-s3'}`}
          >
            {LAYER_LABEL[l]}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {analysis.data && analysis.data.dataQuality !== 'OK' && (
            <span className="text-xs text-warn-text">
              Data {analysis.data.dataQuality.toLowerCase()}
            </span>
          )}
          <ShareButton />
        </span>
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
      {instrument && !rawMode && !canDirect && (
        <p role="status" className="border-b border-line bg-s2 px-3 py-1.5 text-xs text-warn-text">
          {NO_RAW}
        </p>
      )}
      {canDirect && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-s2 px-3 py-1.5 text-xs"
        >
          {pref.on && direct.state === 'BLOCKED' ? (
            <span className="text-warn-text">{BLOCKED}</span>
          ) : pref.on && direct.state === 'ERROR' ? (
            <span className="text-warn-text">
              Could not load live prices from Binance. Retrying…
            </span>
          ) : pref.on ? (
            <span className="text-muted">
              <span
                className={`mr-1.5 inline-block size-2 rounded-full ${direct.state === 'LIVE' ? 'bg-bull' : 'bg-warn'}`}
                aria-hidden
              />
              Live prices from Binance, direct to your browser.
            </span>
          ) : (
            <span className="text-muted">
              Live prices are off. Levels and zones still show; you can also share your own chart.
            </span>
          )}
          <button
            type="button"
            onClick={() => pref.set(!pref.on)}
            className="rounded-ctl border border-line px-2 py-0.5 hover:bg-s3"
          >
            {pref.on ? 'Turn off live prices' : 'Show live prices from Binance'}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
      {rawMode && (
        <p className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line px-3 py-0.5 text-[11px] text-muted">
          <span>
            {focused.hidden > 0
              ? `Showing the ${focused.shown.length} levels nearest the price; ${focused.hidden} more are not drawn.`
              : ''}
          </span>
          <span>
            Charts by{' '}
            <a
              className="underline"
              href="https://www.tradingview.com/lightweight-charts/"
              target="_blank"
              rel="noreferrer"
            >
              TradingView Lightweight Charts™
            </a>
          </span>
        </p>
      )}
    </section>
  );
}
