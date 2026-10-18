'use client';
import type {
  PushToTalk,
  SttEngine,
  Transcript,
  VoiceReport,
  VoiceState,
  VoiceWarning,
} from '@smc/capture-kit';
import type { Glossary, SttEngineTag, VoiceConfig } from '@smc/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { useUi } from './ui';

/** The microphone buffer: 16 kHz mono samples held in memory only, dropped by the controller after each utterance. */
class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext({ sampleRate: 16000 });
    this.ctx = ctx;
    const code = `class Rec extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('rec',Rec)`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'rec');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.chunks.push(e.data);
    };
    ctx.createMediaStreamSource(this.stream).connect(node);
    this.node = node;
  }

  async stop(): Promise<Float32Array> {
    const rate = this.ctx?.sampleRate ?? 16000;
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    await this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.ctx = null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    let pcm: Float32Array = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    if (rate !== 16000) pcm = resample(pcm, rate, 16000);
    return pcm;
  }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, input.length - 1);
    out[i] = (input[a] ?? 0) * (1 - (pos - a)) + (input[b] ?? 0) * (pos - a);
  }
  return out;
}

interface WorkerReply {
  type: 'ready' | 'text' | 'error';
  id: number;
  text?: string;
  message?: string;
}

class WorkerStt implements SttEngine {
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

export interface VoiceStore {
  /** The transcript the user is reviewing (editable), or null. */
  transcript: Transcript | null;
  text: string;
  set: (p: Partial<Omit<VoiceStore, 'set'>>) => void;
}
export const useTranscript = create<VoiceStore>((set) => ({
  transcript: null,
  text: '',
  set: (p) => set(p),
}));

export type VoiceStatus = 'OFF' | 'LOADING' | 'READY' | 'UNAVAILABLE';

export function useVoice(sessionId: string | null) {
  const ptt = useRef<PushToTalk | null>(null);
  const workers = useRef<WorkerStt[]>([]);
  const [state, setState] = useState<VoiceState>('IDLE');
  const [status, setStatus] = useState<VoiceStatus>('OFF');
  const [warning, setWarning] = useState<VoiceWarning | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const confirmOpen = useUi((s) => s.confirmOpen);

  // Leaving the session, or closing the page, drops the models and any recording.
  useEffect(
    () => () => {
      for (const w of workers.current) w.terminate();
      workers.current = [];
      ptt.current = null;
    },
    [],
  );

  const enable = useCallback(async () => {
    if (status === 'LOADING' || status === 'READY') return;
    setStatus('LOADING');
    setDetail('Preparing speech recognition on this device…');
    try {
      const [{ PushToTalk, engineChain }, { VoiceConfigSchema, GlossarySchema }] =
        await Promise.all([import('@smc/capture-kit'), import('@smc/contracts')]);
      const cfg: VoiceConfig = VoiceConfigSchema.parse(await api('/v1/voice/config'));
      const glossary: Glossary = GlossarySchema.parse(await api('/v1/voice/glossary'));
      const chain = engineChain(cfg, {
        hasWebGpu: 'gpu' in navigator,
        hasWasm: typeof WebAssembly === 'object',
        hasMicrophoneApi: typeof navigator.mediaDevices?.getUserMedia === 'function',
      });
      const engines: SttEngine[] = [];
      const reasons: string[] = [];
      for (const choice of chain) {
        const conf = cfg.engines.find((e) => e.tag === choice.tag);
        const pin = conf?.files[0] ? repoOf(conf.files[0].url) : null;
        if (!conf || !pin) continue;
        const worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
        const engine = new WorkerStt(choice.tag, worker);
        try {
          await engine.init(pin.repo, pin.revision, choice.backend, conf.files);
          workers.current.push(engine);
          engines.push(engine);
          break; // the best working engine is enough; the next one is only built if this one fails later
        } catch (e) {
          // Keep why the engine did not start (a short message from the worker, never audio or text), so it can be fixed.
          reasons.push(`${choice.tag}: ${e instanceof Error ? e.message.slice(0, 400) : 'failed'}`);
          engine.terminate();
        }
      }
      const mic = new MicCapture();
      const report = (r: VoiceReport) => {
        void api('/v1/voice/events', {
          method: 'POST',
          body: { ...(sessionId ? { sessionId } : {}), ...r },
        }).catch(() => {});
      };
      ptt.current = new PushToTalk({
        capture: mic,
        engines,
        glossary: () => glossary,
        clock: {
          now: () => performance.now(),
          after: (ms, fn) => {
            const t = setTimeout(fn, ms);
            return () => clearTimeout(t);
          },
        },
        minConfidence: cfg.minConfidence,
        maxUtteranceMs: cfg.maxUtteranceMs,
        onState: setState,
        onTranscript: (t) => useTranscript.getState().set({ transcript: t, text: t.text }),
        onWarning: setWarning,
        onReport: report,
      });
      if (engines.length === 0) {
        setStatus('UNAVAILABLE');
        setDetail(
          `Speech recognition is not available on this device. Type instead.${reasons.length ? ` (${reasons.join('; ')})` : ''}`,
        );
      } else {
        setStatus('READY');
        setDetail(null);
      }
    } catch {
      setStatus('UNAVAILABLE');
      setDetail('Speech recognition could not start. Type instead.');
    }
  }, [status, sessionId]);

  const press = useCallback(() => {
    if (useUi.getState().confirmOpen) return; // voice is off while the confirm dialog is open
    setWarning(null);
    void ptt.current?.press();
  }, []);
  const release = useCallback(() => void ptt.current?.release(), []);
  const done = useCallback(() => {
    ptt.current?.done();
    useTranscript.getState().set({ transcript: null, text: '' });
  }, []);

  return { state, status, warning, detail, confirmOpen, enable, press, release, done };
}
