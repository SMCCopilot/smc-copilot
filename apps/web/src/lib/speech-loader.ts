'use client';
import type { SttEngine } from '@smc/capture-kit';
import type { Glossary, SttEngineTag, VoiceConfig } from '@smc/contracts';
import { create } from 'zustand';
import { api } from './api';

interface WorkerReply {
  type: 'ready' | 'text' | 'error' | 'progress';
  id: number;
  text?: string;
  message?: string;
  bytes?: number;
}

/** One speech model running in its own worker. Audio is copied in for each call and never kept. */
export class WorkerStt implements SttEngine {
  private seq = 0;
  constructor(
    readonly tag: SttEngineTag,
    private readonly worker: Worker,
  ) {}

  private call<T extends WorkerReply>(
    msg: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const on = (e: MessageEvent<WorkerReply>) => {
        if (e.data.id !== id) return;
        this.worker.removeEventListener('message', on);
        if (e.data.type === 'error') reject(new Error(e.data.message ?? 'failed'));
        else resolve(e.data as T);
      };
      this.worker.addEventListener('message', on);
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  onProgress(fn: (bytes: number) => void): void {
    this.worker.addEventListener('message', (e: MessageEvent<WorkerReply>) => {
      if (e.data.type === 'progress' && typeof e.data.bytes === 'number') fn(e.data.bytes);
    });
  }

  async init(
    repo: string,
    revision: string,
    backend: 'webgpu' | 'wasm',
    files: unknown[],
  ): Promise<void> {
    await this.call({ type: 'init', repo, revision, backend, files });
  }

  async transcribe(pcm: Float32Array, signal: AbortSignal) {
    const copy = pcm.slice(); // the controller wipes its own buffer; the worker gets a transferred copy
    const r = await this.call<WorkerReply>({ type: 'transcribe', pcm: copy }, [copy.buffer]);
    if (signal.aborted) throw new Error('aborted');
    // The engines do not report a confidence, so a plain non-empty result is treated as a fixed, modest value.
    return { text: r.text ?? '', confidence: 0.8 };
  }
  terminate(): void {
    this.worker.terminate();
  }
}

/** Turns a model file URL back into the repo and revision it was pinned at. */
export function repoOf(url: string): { repo: string; revision: string } | null {
  const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([0-9a-f]{40})\//.exec(url);
  return m ? { repo: m[1] as string, revision: m[2] as string } : null;
}

export interface Speech {
  engines: SttEngine[];
  cfg: VoiceConfig;
  glossary: Glossary;
  reasons: string[];
}

export type SpeechStatus = 'IDLE' | 'LOADING' | 'READY' | 'UNAVAILABLE';
export const useSpeech = create<{
  status: SpeechStatus;
  /** 0 to 1 while a model downloads (whole files at a time). */
  progress: number;
  speech: Speech | null;
  detail: string | null;
}>(() => ({ status: 'IDLE', progress: 0, speech: null, detail: null }));

const set = useSpeech.setState;
let loading: Promise<Speech | null> | null = null;

/** False on data-saver or slow mobile links: there the model waits until the first time the microphone is used. */
export function shouldPrefetch(): boolean {
  const c = (
    navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  if (!c) return true;
  if (c.saveData) return false;
  return !/^(slow-2g|2g|3g)$/.test(c.effectiveType ?? '');
}

/**
 * Gets speech recognition ready: the smallest accurate on-device model (about 28 MB, cached after the first time;
 * audio never leaves the device). Safe to call
 * again and again; it is meant to be started quietly right after sign-in, so it is ready before anyone presses the mic.
 */
export function prepareSpeech(): Promise<Speech | null> {
  if (loading) return loading;
  set({ status: 'LOADING', progress: 0, detail: null });
  loading = (async () => {
    try {
      const [{ engineChain }, { VoiceConfigSchema, GlossarySchema }] = await Promise.all([
        import('@smc/capture-kit'),
        import('@smc/contracts'),
      ]);
      const cfg: VoiceConfig = VoiceConfigSchema.parse(await api('/v1/voice/config'));
      const glossary: Glossary = GlossarySchema.parse(await api('/v1/voice/glossary'));
      const engines: SttEngine[] = [];
      const reasons: string[] = [];
      {
        const chain = engineChain(cfg, {
          hasWebGpu: 'gpu' in navigator,
          hasWasm: typeof WebAssembly === 'object',
          hasMicrophoneApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
        });
        for (const choice of chain) {
          const conf = cfg.engines.find((e) => e.tag === choice.tag);
          const pin = conf?.files[0] ? repoOf(conf.files[0].url) : null;
          if (!conf || !pin) continue;
          const worker = new Worker(new URL('./stt.worker.ts', import.meta.url), {
            type: 'module',
          });
          const engine = new WorkerStt(choice.tag, worker);
          const total = conf.files.reduce((n, f) => n + f.bytes, 0) || 1;
          let done = 0;
          engine.onProgress((bytes) => {
            done += bytes;
            set({ progress: Math.min(1, done / total) });
          });
          try {
            await engine.init(pin.repo, pin.revision, choice.backend, conf.files);
            engines.push(engine);
            break; // the best working engine is enough
          } catch (e) {
            reasons.push(
              `${choice.tag}: ${e instanceof Error ? e.message.slice(0, 400) : 'failed'}`,
            );
            engine.terminate();
          }
        }
      }
      const speech: Speech = { engines, cfg, glossary, reasons };
      if (engines.length === 0) {
        set({
          status: 'UNAVAILABLE',
          speech,
          detail: `Voice is not available on this device. Type instead.${reasons.length ? ` (${reasons.join('; ')})` : ''}`,
        });
        return speech;
      }
      set({ status: 'READY', progress: 1, speech, detail: null });
      return speech;
    } catch {
      set({ status: 'UNAVAILABLE', detail: 'Voice could not start. Type instead.' });
      return null;
    }
  })();
  return loading;
}
