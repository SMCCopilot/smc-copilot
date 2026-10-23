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
  formatPrice,
  relevantForTf,
  structureMarks,
  visible,
} from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import { useChangeMarket } from '../lib/room';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';
import { GuideMenu, LayersMenu, Popover } from './chart-menus';
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
    const candlePrice = (closed ?? priceCandles?.at(-1))?.c;
    if (candlePrice !== undefined) return candlePrice;
    const dailyOpen = analysis.data?.context?.openLevels?.find((l) => l.kind === 'OPEN_D')?.price;
    if (dailyOpen !== undefined) return dailyOpen;
    const rangeEq = analysis.data?.structure?.range?.eq;
    if (rangeEq !== undefined) return rangeEq;
    return analysis.data?.structure?.swings?.at(-1)?.price;
  }, [priceCandles, analysis.data]);

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

  const lastCandle =
    priceCandles && priceCandles.length > 0 ? priceCandles[priceCandles.length - 1] : null;
  const firstCandle = priceCandles && priceCandles.length > 0 ? priceCandles[0] : null;
  const currentPrice = lastCandle?.c ?? refPrice;
  const priceChange =
    lastCandle && firstCandle && firstCandle.o > 0
      ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100
      : lastCandle && lastCandle.o > 0
        ? ((lastCandle.c - lastCandle.o) / lastCandle.o) * 100
        : null;

  const lastUpdatedIso = lastCandle?.openTime ?? analysis.data?.asOf;
  const lastUpdatedText = lastUpdatedIso
    ? `${new Date(lastUpdatedIso).toLocaleTimeString('en-US', {
        timeZone: 'UTC',
        hour12: false,
      })} UTC`
    : null;

  const quoteCurrency = instrument?.canonical ? instrument.canonical.split('/')[1] : 'USDT';
  const title = instrument ? chartTitle(instrument, sel.tf) : '';
  const barMs = TIMEFRAME_MS[sel.tf];
  let body: React.ReactNode;
  if (!instrument) body = <Message text="Loading markets…" />;
  else if (directMode && direct.candles && direct.candles.length > 0) {
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
        drawingsKey={sel.instrumentId ?? 'default'}
      />
    );
  } else if (canDirect && pref.on && direct.state === 'LOADING') {
    body = <Message text="Loading prices from Binance…" />;
  } else if (serverRaw) {
    if (candles.data && candles.data.length > 0) {
      body = (
        <ChartFull
          key={`${sel.instrumentId}:${sel.tf}`}
          candles={candles.data}
          overlays={overlays}
          marks={marks}
          precision={precision}
          title={title}
          barMs={barMs}
          fitSignal={fit}
          drawingsKey={sel.instrumentId ?? 'default'}
        />
      );
    } else if (candles.isPending) {
      body = <Message text="Loading live candles…" />;
    } else {
      body = (
        <ChartRuler
          overlays={overlays}
          marks={marks}
          precision={precision}
          refPrice={refPrice}
          currency={quoteCurrency}
        />
      );
    }
  } else {
    body = (
      <ChartRuler
        overlays={overlays}
        marks={marks}
        precision={precision}
        refPrice={refPrice}
        currency={quoteCurrency}
      />
    );
  }

  const priceNote =
    canDirect && pref.on && direct.state === 'BLOCKED'
      ? 'Binance does not serve prices to your location, so only the levels are shown. You can still share your own chart.'
      : canDirect && pref.on && direct.state === 'ERROR'
        ? 'Could not connect directly to Binance public endpoints from this network. Showing SMC structure and levels.'
        : instrument && !rawMode && !canDirect
          ? 'Live candles for this market are restricted to internal analysis only; showing verified SMC levels.'
          : null;

  const sourceText = serverRaw
    ? 'Live'
    : directMode
      ? 'Live · Binance'
      : canDirect
        ? 'Prices off'
        : 'Levels only';
  const sourceOk = rawMode && (analysis.data?.dataQuality ?? 'OK') === 'OK';

  return (
    <section aria-label="Chart" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-1.5">
        <label className="sr-only" htmlFor="market">
          Chart market
        </label>
        <select
          id="market"
          title="The market: the coin pair, its type (Perp = perpetual futures, Spot = the coin itself) and the exchange the prices come from"
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

        {currentPrice !== undefined && (
          <div className="flex items-baseline gap-1.5 border-l border-line/60 pl-2">
            <span className="num text-sm font-bold tracking-tight text-fg">
              {formatPrice(currentPrice, precision)}
            </span>
            <span className="text-[11px] font-medium text-muted">{quoteCurrency}</span>
            {priceChange !== null && (
              <span
                className={`num rounded px-1.5 text-[11px] font-medium ${priceChange >= 0 ? 'bg-bull/10 text-bull-text' : 'bg-bear/10 text-bear-text'}`}
              >
                {priceChange >= 0 ? '+' : ''}
                {priceChange.toFixed(2)}%
              </span>
            )}
          </div>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-2">
          <LayersMenu hidden={rawMode ? focused.hidden : 0} />
          <Popover
            label="Where the prices come from"
            name={`Price source: ${sourceText}`}
            button={
              <>
                <span
                  className={`size-2 rounded-full ${sourceOk ? 'bg-bull' : 'bg-warn'}`}
                  aria-hidden
                />
                {sourceText}
              </>
            }
          >
            {(close) => (
              <>
                <p className="font-medium text-fg">Where the prices come from</p>
                {serverRaw ? (
                  <p className="mt-1 text-muted">
                    Candles come from our servers' verified market feed.
                  </p>
                ) : directMode ? (
                  <p className="mt-1 text-muted">
                    Live candles come straight from Binance to your browser, the same as opening
                    Binance's own chart. They do not pass through our servers, and Binance can see
                    your internet address as on any Binance page.
                  </p>
                ) : canDirect ? (
                  <p className="mt-1 text-muted">
                    Live prices are off, so only the analysis levels are shown. Turn them on to see
                    candles.
                  </p>
                ) : (
                  <p className="mt-1 text-muted">
                    Live candles for this market are not available to us, so only the analysis
                    levels are shown. You can share your own chart to have it explained.
                  </p>
                )}
                {analysis.data?.dataQuality && analysis.data.dataQuality !== 'OK' && (
                  <p className="mt-1 text-warn-text">
                    Data quality: {analysis.data.dataQuality.toLowerCase()}.
                  </p>
                )}
                {lastUpdatedText && (
                  <p className="mt-1 text-muted">Last candle: {lastUpdatedText}</p>
                )}
                {canDirect && (
                  <button
                    type="button"
                    onClick={() => {
                      pref.set(!pref.on);
                      close();
                    }}
                    className="mt-2 rounded-ctl border border-line px-2.5 py-1 hover:bg-s3"
                  >
                    {pref.on ? 'Turn off live prices' : 'Turn on live prices'}
                  </button>
                )}
              </>
            )}
          </Popover>
          {rawMode && (
            <button
              type="button"
              aria-label="Fit chart to the latest candles"
              title="Jump to the latest candles"
              onClick={() => setFit((n) => n + 1)}
              className="grid size-8 place-items-center rounded-ctl border border-line text-muted hover:bg-s3"
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </button>
          )}
          <GuideMenu />
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
      {priceNote && (
        <p role="status" className="border-b border-line bg-s2 px-3 py-1.5 text-xs text-warn-text">
          {priceNote}
        </p>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
