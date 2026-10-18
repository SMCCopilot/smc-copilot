'use client';
import type {
  PushToTalk,
  Transcript,
  VoiceReport,
  VoiceState,
  VoiceWarning,
} from '@smc/capture-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { prepareSpeech, useSpeech } from './speech-loader';
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

  /** A copy of what has been recorded so far at 16 kHz, without stopping (for the live preview). */
  peek(): Float32Array {
    const rate = this.ctx?.sampleRate ?? 16000;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    return rate !== 16000 ? resample(pcm, rate, 16000) : pcm;
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

export interface VoiceStore {
  /** The transcript the user is reviewing (editable), or null. */
  transcript: Transcript | null;
  text: string;
  /** Words heard so far while the key is held (live recognition only). */
  partial: string;
  set: (p: Partial<Omit<VoiceStore, 'set'>>) => void;
}
export const useTranscript = create<VoiceStore>((set) => ({
  transcript: null,
  text: '',
  partial: '',
  set: (p) => set(p),
}));

export type VoiceStatus = 'OFF' | 'LOADING' | 'READY' | 'UNAVAILABLE';

export function useVoice(sessionId: string | null) {
  const ptt = useRef<PushToTalk | null>(null);
  const sid = useRef(sessionId);
  sid.current = sessionId;
  const [state, setState] = useState<VoiceState>('IDLE');
  const [warning, setWarning] = useState<VoiceWarning | null>(null);
  const { status: loadStatus, progress, speech, detail } = useSpeech();
  const confirmOpen = useUi((s) => s.confirmOpen);
  const status: VoiceStatus =
    loadStatus === 'IDLE' ? 'OFF' : loadStatus === 'LOADING' ? 'LOADING' : loadStatus;

  // Build the push-to-talk controller as soon as the speech models are ready (they load quietly after sign-in).
  useEffect(() => {
    if (!speech || speech.engines.length === 0) return;
    let cancelled = false;
    void import('@smc/capture-kit').then(({ PushToTalk }) => {
      if (cancelled) return;
      const report = (r: VoiceReport) => {
        void api('/v1/voice/events', {
          method: 'POST',
          body: { ...(sid.current ? { sessionId: sid.current } : {}), ...r },
        }).catch(() => {});
      };
      ptt.current = new PushToTalk({
        capture: new MicCapture(),
        engines: speech.engines,
        glossary: () => speech.glossary,
        clock: {
          now: () => performance.now(),
          after: (ms, fn) => {
            const t = setTimeout(fn, ms);
            return () => clearTimeout(t);
          },
        },
        minConfidence: speech.cfg.minConfidence,
        maxUtteranceMs: speech.cfg.maxUtteranceMs,
        onState: setState,
        onTranscript: (t) => useTranscript.getState().set({ transcript: t, text: t.text }),
        onWarning: setWarning,
        onReport: report,
        onPartial: (t) => useTranscript.getState().set({ partial: t }),
      });
    });
    return () => {
      cancelled = true;
      ptt.current = null;
    };
  }, [speech]);

  /** Starts getting voice ready (it normally already did, right after sign-in). */
  const enable = useCallback(async () => {
    await prepareSpeech();
  }, []);

  const press = useCallback(() => {
    if (useUi.getState().confirmOpen) return; // voice is off while the confirm dialog is open
    setWarning(null);
    void ptt.current?.press();
  }, []);
  const release = useCallback(() => void ptt.current?.release(), []);
  const done = useCallback(() => {
    ptt.current?.done();
    useTranscript.getState().set({ transcript: null, text: '', partial: '' });
  }, []);

  return {
    state,
    status,
    progress,
    warning,
    detail,
    engineTag: speech?.engines[0]?.tag ?? null,
    confirmOpen,
    enable,
    press,
    release,
    done,
  };
}
