import {
  ClientEventSchemas,
  correctTranscript,
  forbiddenByVoice,
  type Glossary,
  parseVoiceCommand,
  type SttEngineTag,
  type VoiceConfig,
} from '@smc/contracts';
import { assertNoPixels } from './session.js';

/**
 * Push-to-talk voice on the device (A02 section 6). Audio is captured, recognised and thrown away in the browser; only
 * the corrected text of an utterance can leave, and only when the user sends it. Everything here is injectable, so the
 * logic is tested without a microphone; the real recogniser plugs into `SttEngine` (spike S3).
 */

// ---- choosing an engine -------------------------------------------------------------------------------------------

export interface VoiceCapabilities {
  hasWebGpu: boolean;
  hasWasm: boolean;
  hasMicrophoneApi: boolean;
}
export type EngineChoice = { tag: SttEngineTag; backend: 'webgpu' | 'wasm' };

/**
 * The engines to try, best first: Whisper on WebGPU, then Moonshine on WASM, then typing. Only engines the server reports
 * as pinned and READY are considered, because the browser can verify nothing else.
 */
export function engineChain(
  cfg: VoiceConfig,
  caps: VoiceCapabilities,
  failed: ReadonlySet<SttEngineTag> = new Set(),
): EngineChoice[] {
  if (!caps.hasMicrophoneApi) return [];
  const out: EngineChoice[] = [];
  for (const e of cfg.engines) {
    if (e.status !== 'READY' || failed.has(e.tag)) continue;
    if (e.backend === 'webgpu' && !caps.hasWebGpu) continue;
    if (e.backend === 'wasm' && !caps.hasWasm) continue;
    out.push({ tag: e.tag, backend: e.backend });
  }
  return out;
}

// ---- model files: verify before use ---------------------------------------------------------------------------------

export interface ModelFile {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
}
export interface ModelCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}
export interface ModelIo {
  fetchBytes(url: string): Promise<Uint8Array>;
  /** SHA-256 as lowercase hex (SubtleCrypto in the browser). */
  sha256(bytes: Uint8Array): Promise<string>;
  cache: ModelCache;
}

export class ModelIntegrityError extends Error {
  constructor(readonly fileId: string) {
    super(`model file ${fileId} does not match its pinned hash`);
  }
}

/**
 * Returns the file's bytes only if they match the pinned hash and size. A cached copy is checked again before use, and a
 * bad download is never cached, so a swapped or corrupted file cannot be used or persist.
 */
export async function loadVerified(file: ModelFile, io: ModelIo): Promise<Uint8Array> {
  const key = `${file.id}:${file.sha256}`;
  const cached = await io.cache.get(key);
  if (cached && cached.byteLength === file.bytes && (await io.sha256(cached)) === file.sha256)
    return cached;
  const fresh = await io.fetchBytes(file.url);
  if (fresh.byteLength !== file.bytes || (await io.sha256(fresh)) !== file.sha256)
    throw new ModelIntegrityError(file.id);
  await io.cache.put(key, fresh);
  return fresh;
}

// ---- voice activity ---------------------------------------------------------------------------------------------------

export interface VadOptions {
  /** RMS level (0 to 1) above which a frame counts as speech. */
  threshold: number;
  /** Frames of silence that end an utterance. */
  hangoverFrames: number;
  /** Frames of speech needed before it counts. */
  minSpeechFrames: number;
}
export const DEFAULT_VAD: VadOptions = { threshold: 0.015, hangoverFrames: 12, minSpeechFrames: 3 };

export const rms = (frame: Float32Array): number => {
  let s = 0;
  for (const v of frame) s += v * v;
  return frame.length === 0 ? 0 : Math.sqrt(s / frame.length);
};

/** Energy-based speech detection: the fallback when the neural detector is unavailable, and the reference for tests. */
export class EnergyVad {
  private speech = 0;
  private silence = 0;
  private active = false;

  constructor(private readonly o: VadOptions = DEFAULT_VAD) {}

  /** Feed one frame. Returns what changed: started speaking, ended an utterance, or nothing. */
  push(frame: Float32Array): 'START' | 'END' | null {
    const loud = rms(frame) >= this.o.threshold;
    if (loud) {
      this.silence = 0;
      this.speech++;
      if (!this.active && this.speech >= this.o.minSpeechFrames) {
        this.active = true;
        return 'START';
      }
    } else if (this.active) {
      this.silence++;
      if (this.silence >= this.o.hangoverFrames) {
        this.active = false;
        this.speech = 0;
        this.silence = 0;
        return 'END';
      }
    } else {
      this.speech = 0;
    }
    return null;
  }
}

// ---- what may be sent -------------------------------------------------------------------------------------------------

export interface VoiceUtterance {
  utteranceId: string;
  text: string;
  sttConfidence: number;
  sttEngine: SttEngineTag;
}

/** The only voice payload that can leave the device: text and a confidence, validated and checked for binary data. */
export function voiceCommandPayload(u: VoiceUtterance): VoiceUtterance {
  const parsed = ClientEventSchemas['voice.command'].parse(u);
  assertNoPixels(parsed, 'voice.command');
  return parsed;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

// ---- push to talk ------------------------------------------------------------------------------------------------------

export interface AudioCapture {
  /** Asks for the microphone; rejects with a permission error when denied. */
  start(): Promise<void>;
  /** Stops and returns the audio recorded since `start`, as 16 kHz mono samples. Kept in memory only. */
  stop(): Promise<Float32Array>;
}
export interface SttEngine {
  readonly tag: SttEngineTag;
  transcribe(
    pcm: Float32Array,
    signal: AbortSignal,
  ): Promise<{ text: string; confidence: number; language?: string }>;
}
export interface VoiceClock {
  now(): number;
  after(ms: number, fn: () => void): () => void;
}

export type VoiceState = 'IDLE' | 'RECORDING' | 'TRANSCRIBING' | 'REVIEW' | 'UNAVAILABLE';
export type VoiceWarning =
  | 'MIC_PERMISSION_DENIED'
  | 'STT_UNAVAILABLE'
  | 'NO_SPEECH'
  | 'LOW_CONFIDENCE'
  | 'TOO_LONG';

export interface Transcript {
  /** What the engine heard. */
  raw: string;
  /** After glossary correction: this is what the user sees and may edit. */
  text: string;
  confidence: number;
  engine: SttEngineTag;
  corrected: boolean;
  /** Already refused by the voice rules; the UI shows an on-screen prompt instead of sending. */
  forbidden: string | null;
  /** Recognised as a closed command, or null for a question. */
  command: string | null;
  latencyMs: number;
}

export interface VoiceReport {
  engine: SttEngineTag;
  outcome: 'OK' | 'LOW_CONFIDENCE' | 'NO_SPEECH' | 'ERROR';
  durationMs?: number;
  latencyMs?: number;
  confidence?: number;
  errorCode?: string;
}

export interface VoiceOptions {
  capture: AudioCapture;
  /** Engines in order of preference, already built. Empty means typed input only. */
  engines: SttEngine[];
  glossary: () => Glossary;
  clock: VoiceClock;
  minConfidence: number;
  maxUtteranceMs: number;
  onState: (s: VoiceState) => void;
  onTranscript: (t: Transcript) => void;
  onWarning: (w: VoiceWarning) => void;
  /** Metadata only (engine, timings, outcome). Never audio, never text. */
  onReport: (r: VoiceReport) => void;
  /** Samples shorter than this are treated as no speech. */
  minSamples?: number;
}

/**
 * Hold to talk, release to get an editable transcript. A failing engine is skipped for the rest of the session and the
 * next one is tried; with none left the controller says `STT_UNAVAILABLE` and the UI offers typing. Denied microphone
 * permission says `MIC_PERMISSION_DENIED` and also falls back to typing. The audio buffer is dropped after each utterance.
 */
export class PushToTalk {
  private state: VoiceState = 'IDLE';
  private failed = new Set<SttEngineTag>();
  private cancelTimer: (() => void) | null = null;
  private recordedAt = 0;
  readonly latencies: number[] = [];

  constructor(private readonly o: VoiceOptions) {
    if (o.engines.length === 0) this.set('UNAVAILABLE');
  }

  get current(): VoiceState {
    return this.state;
  }

  private set(s: VoiceState): void {
    this.state = s;
    this.o.onState(s);
  }

  async press(): Promise<void> {
    if (this.state !== 'IDLE' && this.state !== 'REVIEW') return;
    if (this.o.engines.every((e) => this.failed.has(e.tag))) {
      this.set('UNAVAILABLE');
      this.o.onWarning('STT_UNAVAILABLE');
      return;
    }
    try {
      await this.o.capture.start();
    } catch {
      this.o.onWarning('MIC_PERMISSION_DENIED');
      this.set('UNAVAILABLE');
      return;
    }
    this.recordedAt = this.o.clock.now();
    this.set('RECORDING');
    // A held key must not record forever.
    this.cancelTimer = this.o.clock.after(this.o.maxUtteranceMs, () => {
      this.o.onWarning('TOO_LONG');
      void this.release();
    });
  }

  async release(): Promise<void> {
    if (this.state !== 'RECORDING') return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const releasedAt = this.o.clock.now();
    this.set('TRANSCRIBING');
    let pcm: Float32Array | null = await this.o.capture.stop();
    const durationMs = releasedAt - this.recordedAt;
    try {
      if (pcm.length < (this.o.minSamples ?? 4800)) {
        this.o.onReport({ engine: this.firstEngine(), outcome: 'NO_SPEECH', durationMs });
        this.o.onWarning('NO_SPEECH');
        this.set('IDLE');
        return;
      }
      for (const engine of this.o.engines) {
        if (this.failed.has(engine.tag)) continue;
        const ctl = new AbortController();
        const stop = this.o.clock.after(15_000, () => ctl.abort());
        try {
          const r = await engine.transcribe(pcm, ctl.signal);
          stop();
          const latencyMs = this.o.clock.now() - releasedAt;
          this.latencies.push(latencyMs);
          this.deliver(engine.tag, r.text, r.confidence, latencyMs, durationMs);
          return;
        } catch {
          stop();
          this.failed.add(engine.tag);
          this.o.onReport({
            engine: engine.tag,
            outcome: 'ERROR',
            durationMs,
            errorCode: 'ENGINE_FAILED',
          });
        }
      }
      this.o.onWarning('STT_UNAVAILABLE');
      this.set('UNAVAILABLE');
    } finally {
      // The recording is dropped as soon as the utterance is handled, whatever happened.
      if (pcm) pcm.fill(0);
      pcm = null;
    }
  }

  private firstEngine(): SttEngineTag {
    return this.o.engines[0]?.tag ?? 'typed';
  }

  private deliver(
    engine: SttEngineTag,
    raw: string,
    confidence: number,
    latencyMs: number,
    durationMs: number,
  ): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      this.o.onReport({ engine, outcome: 'NO_SPEECH', durationMs, latencyMs });
      this.o.onWarning('NO_SPEECH');
      this.set('IDLE');
      return;
    }
    const fixed = correctTranscript(trimmed, this.o.glossary());
    const t: Transcript = {
      raw: trimmed,
      text: fixed.text,
      confidence,
      engine,
      corrected: fixed.changes.length > 0,
      forbidden: forbiddenByVoice(trimmed) ?? forbiddenByVoice(fixed.text),
      command: parseVoiceCommand(fixed.text)?.command ?? null,
      latencyMs,
    };
    const low = confidence < this.o.minConfidence;
    this.o.onReport({
      engine,
      outcome: low ? 'LOW_CONFIDENCE' : 'OK',
      durationMs,
      latencyMs,
      confidence,
    });
    if (low) this.o.onWarning('LOW_CONFIDENCE');
    this.o.onTranscript(t);
    this.set('REVIEW');
  }

  /** Back to idle once the user has sent or dismissed the transcript. */
  done(): void {
    if (this.state === 'REVIEW') this.set('IDLE');
  }

  /** Typed input is always available; it needs no engine. */
  static typed(text: string, id: string): VoiceUtterance {
    return voiceCommandPayload({ utteranceId: id, text, sttConfidence: 1, sttEngine: 'typed' });
  }
}
