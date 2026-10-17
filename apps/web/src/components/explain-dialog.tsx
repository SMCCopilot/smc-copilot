'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { TIMEFRAMES, type Timeframe } from '@smc/contracts';
import { useRef, useState } from 'react';
import {
  checkImage,
  explainShared,
  explainUpload,
  startShare,
  stopShare,
  useShare,
} from '../lib/explain';
import { canShareScreen } from '../lib/ocr';
import { useInstruments } from '../lib/queries';
import { usePrefs } from '../lib/records';
import { useSelection } from '../lib/sessions';
import { useUi } from '../lib/ui';

/** Explain a chart: upload one image, or share the screen and read it on this device. The image is never kept. */
export function ExplainDialog() {
  const open = useUi((s) => s.explainOpen);
  const setOpen = useUi((s) => s.setExplainOpen);
  const sel = useSelection();
  const inst = useInstruments(false);
  const share = useShare();
  const [market, setMarket] = useState('');
  const [tf, setTf] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const canShare = canShareScreen();
  const noImages = usePrefs((s) => s.neverSendImages);

  const hints = () => ({
    ...(market ? { instrumentHint: market } : {}),
    ...(tf ? { tfHint: tf as Timeframe } : {}),
    ...(question.trim() ? { question: question.trim() } : {}),
  });

  async function onFile(f: File | undefined) {
    if (!f || !sel.sessionId) return;
    const bad = checkImage(f);
    if (bad) {
      setError(bad);
      return;
    }
    setError(null);
    setOpen(false);
    await explainUpload(f, { sessionId: sel.sessionId, ...hints() });
    if (file.current) file.current.value = ''; // drop the reference to the picture
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-s1 p-5">
          <Dialog.Title className="text-base font-semibold">Explain a chart</Dialog.Title>
          <Dialog.Description className="mt-1 text-muted">
            One image is sent once and not stored. Screen sharing is read on this device and only
            the text leaves it.
          </Dialog.Description>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              Market
              <select
                value={market}
                onChange={(e) => setMarket(e.target.value)}
                className="mt-1 w-full rounded-ctl border border-line bg-s3 px-2 py-1.5 text-fg"
              >
                <option value="">Detect from the picture</option>
                {inst.data?.items.map((i) => (
                  <option key={i.id} value={i.canonical}>
                    {i.canonical}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Timeframe
              <select
                value={tf}
                onChange={(e) => setTf(e.target.value)}
                className="mt-1 w-full rounded-ctl border border-line bg-s3 px-2 py-1.5 text-fg"
              >
                <option value="">Detect</option>
                {TIMEFRAMES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs text-muted">
            Question (optional)
            <input
              value={question}
              maxLength={500}
              onChange={(e) => setQuestion(e.target.value)}
              className="mt-1 w-full rounded-ctl border border-line bg-s3 px-2 py-1.5 text-fg"
            />
          </label>
          {error && (
            <p role="alert" className="mt-2 text-warn-text">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              id="explain-file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <button
              type="button"
              disabled={!sel.sessionId || noImages}
              title={noImages ? 'Switched off in Settings: never send images to AI' : undefined}
              onClick={() => file.current?.click()}
              className="rounded-ctl bg-accent-strong px-3 py-2 font-medium text-white disabled:opacity-50"
            >
              Upload an image
            </button>
            {canShare &&
              (share.active ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      void explainShared(hints());
                    }}
                    className="rounded-ctl bg-accent-strong px-3 py-2 font-medium text-white"
                  >
                    Explain shared screen
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopShare()}
                    className="rounded-ctl border border-line px-3 py-2"
                  >
                    Stop sharing
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={share.starting || !sel.sessionId}
                  onClick={() => void startShare()}
                  className="rounded-ctl border border-line px-3 py-2 disabled:opacity-50"
                >
                  {share.starting ? 'Starting…' : 'Share screen'}
                </button>
              ))}
          </div>
          {!sel.sessionId && <p className="mt-2 text-xs text-muted">Start a session first.</p>}
          <div className="mt-4 flex justify-end">
            <Dialog.Close className="rounded-ctl border border-line px-3 py-2">Close</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
