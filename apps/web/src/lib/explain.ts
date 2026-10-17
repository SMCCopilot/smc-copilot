'use client';
import type { CaptureLoop } from '@smc/capture-kit';
import type { OcrContext, Timeframe } from '@smc/contracts';
import { create } from 'zustand';
import { applyChatEvent, failExplain, say, startExplain } from './chat';
import { API_URL } from './env';
import { FRIENDLY, toApiError } from './errors';
import { emitEvent } from './live';
import { getAccessToken } from './supabase';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function checkImage(file: File): string | null {
  if (!OK_TYPES.includes(file.type)) return 'Use a PNG, JPEG or WebP image.';
  if (file.size > MAX_IMAGE_BYTES) return 'That image is too large. The limit is 6 MB.';
  return null;
}

export interface ExplainRequest {
  sessionId: string;
  instrumentHint?: string;
  tfHint?: Timeframe;
  question?: string;
}

/**
 * One image, sent once, straight from memory. It is never stored, previewed or kept after the answer arrives:
 * the caller drops its reference as soon as this returns.
 */
export async function explainUpload(file: File, r: ExplainRequest): Promise<void> {
  const bad = checkImage(file);
  if (bad) {
    say(bad);
    return;
  }
  startExplain('resolving');
  const form = new FormData();
  form.set('image', file, 'chart');
  form.set('sessionId', r.sessionId);
  form.set('source', 'UPLOAD');
  if (r.instrumentHint) form.set('instrumentHint', r.instrumentHint);
  if (r.tfHint) form.set('tfHint', r.tfHint);
  if (r.question) form.set('question', r.question);
  try {
    const token = await getAccessToken();
    const res = await fetch(`${API_URL}/v1/explain`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!res.ok || !res.body) {
      const e = await toApiError(res);
      failExplain(e.friendly.message);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i = buf.indexOf('\n\n');
      while (i >= 0) {
        handleFrame(buf.slice(0, i));
        buf = buf.slice(i + 2);
        i = buf.indexOf('\n\n');
      }
    }
  } catch {
    failExplain('Could not reach the explainer. Nothing was stored.');
  }
}

function handleFrame(frame: string): void {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(data || '{}');
  } catch {}
  if (event === 'error') {
    const code = String(payload.code ?? 'INTERNAL');
    failExplain(
      code in FRIENDLY
        ? FRIENDLY[code as keyof typeof FRIENDLY].message
        : 'The explanation failed.',
    );
  } else {
    applyChatEvent(event, payload);
  }
}

// ---- screen share (desktop only) -------------------------------------------------------------------------------

interface ShareStore {
  active: boolean;
  starting: boolean;
  readSome: boolean;
  set: (p: Partial<Omit<ShareStore, 'set'>>) => void;
}
export const useShare = create<ShareStore>((set) => ({
  active: false,
  starting: false,
  readSome: false,
  set: (p) => set(p),
}));

let loop: CaptureLoop | null = null;
let engineRef: { dispose(): Promise<void> } | null = null;
let lastCtx: OcrContext | null = null;

export async function startShare(): Promise<void> {
  const st = useShare.getState();
  if (st.active || st.starting) return;
  st.set({ starting: true });
  try {
    const [{ CaptureLoop }, { TesseractEngine, ScreenSource }] = await Promise.all([
      import('@smc/capture-kit'),
      import('./ocr'),
    ]);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const source = new ScreenSource(stream);
    await source.start();
    const engine = new TesseractEngine();
    engineRef = engine;
    // Wait for the first frame so the region of interest matches the real size.
    let frame = await source.grab();
    for (let i = 0; !frame && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      frame = await source.grab();
    }
    if (!frame) throw new Error('no frame');
    loop = new CaptureLoop({
      source,
      engine,
      roi: { x: 0, y: 0, w: frame.width, h: frame.height },
      timer: {
        now: () => Date.now(),
        every: (ms, fn) => {
          const t = setInterval(fn, ms);
          return () => clearInterval(t);
        },
      },
      onContext: (ctx) => {
        lastCtx = ctx;
        useShare.getState().set({ readSome: true });
        emitEvent('context.hint', ctx);
      },
    });
    source.onEnded = () => void stopShare();
    loop.start();
    st.set({ active: true, starting: false });
  } catch {
    await stopShare();
    say('Screen sharing did not start. You can upload an image instead.');
  }
}

export async function stopShare(): Promise<void> {
  loop?.stop();
  loop = null;
  lastCtx = null;
  await engineRef?.dispose().catch(() => {});
  engineRef = null;
  useShare.getState().set({ active: false, starting: false, readSome: false });
}

/** Reads the shared chart once more and asks for an explanation from text only. */
export async function explainShared(r: Omit<ExplainRequest, 'sessionId'>): Promise<void> {
  if (!loop) return;
  await loop.tickNow();
  startExplain('resolving');
  const ok = emitEvent('explain.request', {
    mode: 'SHARE',
    ...(lastCtx ? { ocr: lastCtx } : {}),
    ...(r.instrumentHint ? { instrumentHint: r.instrumentHint } : {}),
    ...(r.tfHint ? { tfHint: r.tfHint } : {}),
    ...(r.question ? { question: r.question } : {}),
  });
  if (!ok) failExplain('The live connection is not open. Try again in a moment.');
}
