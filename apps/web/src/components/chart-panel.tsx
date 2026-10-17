'use client';
import { CandlestickChart } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { ApiError } from '../lib/errors';
import { useAnalysis, useCandles } from '../lib/market';
import { buildOverlays, LAYER_LABEL, LAYERS, structureMarks, visible } from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';

// Chart code loads only when needed, so the first load stays small.
const ChartFull = dynamic(() => import('./chart-full'), { ssr: false });
const ChartRuler = dynamic(() => import('./chart-ruler'), { ssr: false });

const NO_RAW =
  'Raw prices unavailable for this venue; use your own chart and share your screen to explain.';

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
  const rawMode = wantRaw && !restricted;
  const precision = instrument?.pricePrecision ?? 2;

  const setup = pickSetup(analysis.data, ui.setupId, ui.dismissed);
  const overlays = useMemo(
    () => (analysis.data ? visible(buildOverlays(analysis.data, setup), ui.layers) : []),
    [analysis.data, setup, ui.layers],
  );
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
  } else if (rawMode) {
    body = candles.data ? (
      <ChartFull candles={candles.data} overlays={overlays} marks={marks} precision={precision} />
    ) : (
      <Message text={candles.isError ? 'Could not load candles.' : 'Loading candles…'} />
    );
  } else {
    body = <ChartRuler overlays={overlays} marks={marks} precision={precision} />;
  }

  return (
    <section aria-label="Chart" className="flex min-h-0 flex-[6] flex-col border-b border-line">
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
        {analysis.data && analysis.data.dataQuality !== 'OK' && (
          <span className="ml-auto text-xs text-warn-text">
            Data {analysis.data.dataQuality.toLowerCase()}
          </span>
        )}
      </div>
      {instrument && !rawMode && (
        <p role="status" className="border-b border-line bg-s2 px-3 py-1.5 text-xs text-warn-text">
          {NO_RAW}
        </p>
      )}
      <div className="min-h-0 flex-1">{body}</div>
      {rawMode && (
        <p className="border-t border-line px-3 py-0.5 text-right text-[11px] text-muted">
          Charts by{' '}
          <a
            className="underline"
            href="https://www.tradingview.com/lightweight-charts/"
            target="_blank"
            rel="noreferrer"
          >
            TradingView Lightweight Charts™
          </a>
        </p>
      )}
    </section>
  );
}
