'use client';
import { TIMEFRAMES, type Timeframe } from '@smc/contracts';
import { MonitorUp, Sparkles, SquareX } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { explainShared, startShare, stopShare, useShare } from '../lib/explain';
import { emitEvent, useLive } from '../lib/live';
import { canShareScreen } from '../lib/ocr';
import { useInstruments } from '../lib/queries';
import { useSelection } from '../lib/sessions';

const MISMATCH =
  'The chart you shared does not match this market’s live data. Pick the right market from the list.';
const PRIVACY = 'Frames stay on this device. Only text is sent, unless you press Explain.';

/** Toolbar button that starts a Meet-style screen share (or stops it while sharing). */
export function ShareButton() {
  const share = useShare();
  const sel = useSelection();
  if (!canShareScreen()) return null;
  if (share.active) {
    return (
      <button
        type="button"
        onClick={() => void stopShare()}
        className="inline-flex items-center gap-1.5 rounded-ctl border border-bear-text px-2.5 py-1 text-xs font-medium text-bear-text"
      >
        <SquareX className="size-3.5" aria-hidden /> Stop sharing
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={share.starting || !sel.sessionId}
      title={sel.sessionId ? undefined : 'Start a session first'}
      onClick={() => void startShare()}
      className="btn-primary inline-flex h-9 items-center gap-1.5 px-3.5 text-xs disabled:opacity-50"
    >
      <MonitorUp className="size-3.5" aria-hidden /> {share.starting ? 'Starting…' : 'Share screen'}
    </button>
  );
}

const fmtPrice = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-line bg-s3 px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

/** Self-view tile, detected-context chips with a manual override, the mismatch notice and Explain now. */
export function SharePanel() {
  const share = useShare();
  const live = useLive();
  const sel = useSelection();
  const inst = useInstruments(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = video.current;
    if (v) v.srcObject = share.stream;
  }, [share.stream]);

  if (!canShareScreen()) return null;
  if (!share.active && !share.error) return null;

  const d = share.ctx?.derived;
  const texts = share.ctx?.texts ?? [];
  const conf = texts.length ? texts.reduce((a, t) => a + t.conf, 0) / texts.length : 0;
  const confLabel = conf >= 0.8 ? 'High' : conf >= 0.5 ? 'Medium' : 'Low';
  const mismatch = live.warnings.includes('FEED_MISMATCH') ? MISMATCH : null;
  const current = inst.data?.items.find((i) => i.id === sel.instrumentId);

  return (
    <section className="border-b border-line bg-s2 px-3 py-2" aria-label="Screen share">
      {share.error && (
        <p role="alert" className="text-xs text-warn-text">
          {share.error}
        </p>
      )}
      {share.active && (
        <div className="flex flex-wrap items-start gap-3">
          <div className="relative w-40 shrink-0 overflow-hidden rounded-ctl border border-line bg-black">
            <video ref={video} autoPlay muted playsInline className="aspect-video w-full" />
            <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded bg-bear-strong px-1.5 py-0.5 text-[10px] font-semibold text-white">
              <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden /> Sharing
            </span>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
              {share.readSome && d ? (
                <>
                  <Chip>{d.symbolText ?? 'Symbol ?'}</Chip>
                  <Chip>{d.tfText ?? 'Timeframe ?'}</Chip>
                  {d.venueText && <Chip>{d.venueText}</Chip>}
                  <Chip>{d.lastPrice !== undefined ? fmtPrice(d.lastPrice) : 'Price ?'}</Chip>
                  <span className="text-xs text-muted">Chart reading: {confLabel}</span>
                </>
              ) : (
                <span className="text-xs text-muted">Reading your chart…</span>
              )}
            </div>
            {share.readSome && !d?.symbolText && (
              <p className="text-xs text-warn-text">
                No trading symbol was found on this chart. If it is a BTC, ETH or SOL market, pick
                it from the Market list; other markets are not covered by our feeds.
              </p>
            )}
            {mismatch && (
              <p role="alert" className="text-xs text-warn-text">
                {mismatch}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-muted">
                Market{' '}
                <select
                  aria-label="Override market"
                  value={current?.canonical ?? ''}
                  onChange={(e) =>
                    emitEvent('context.set', {
                      instrumentId: e.target.value,
                      tf: sel.tf,
                      source: 'manual',
                    })
                  }
                  className="field w-auto px-2 py-1 text-fg"
                >
                  {!current && <option value="">Choose…</option>}
                  {inst.data?.items.map((i) => (
                    <option key={i.id} value={i.canonical}>
                      {i.canonical}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Timeframe{' '}
                <select
                  aria-label="Override timeframe"
                  value={sel.tf}
                  onChange={(e) => {
                    if (current)
                      emitEvent('context.set', {
                        instrumentId: current.canonical,
                        tf: e.target.value as Timeframe,
                        source: 'manual',
                      });
                  }}
                  className="field w-auto px-2 py-1 text-fg"
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void explainShared({})}
                className="inline-flex items-center gap-1.5 btn-primary px-2.5 py-1 text-xs"
              >
                <Sparkles className="size-3.5" aria-hidden /> Explain now
              </button>
            </div>
            <p className="text-[11px] text-muted">{PRIVACY}</p>
          </div>
        </div>
      )}
    </section>
  );
}
