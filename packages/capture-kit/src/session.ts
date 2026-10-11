import { type OcrContext, OcrContextSchema } from '@smc/contracts';
import { buildOcrContext } from './classify.js';
import { cropRoi, DEFAULT_SAMPLER, FrameGate, type SamplerOptions } from './sampler.js';
import type { Frame, OcrEngine, Roi } from './types.js';

// ---- capability report ------------------------------------------------------------------------------------------

export interface CapabilityInput {
  hasWebGpu: boolean;
  hasWorker: boolean;
  hasOffscreenCanvas: boolean;
  hasDisplayMedia: boolean;
  /** navigator.deviceMemory in GB when the browser reports it. */
  deviceMemoryGb?: number | undefined;
  hardwareConcurrency?: number | undefined;
}
export interface CapabilityReport {
  ocrBackend: 'webgpu' | 'wasm' | 'none';
  webgpu: boolean;
  /** Suggested sampling pace for this machine. */
  sampler: SamplerOptions;
  /** Why the picker should be the primary way to choose a market on this device. */
  pickerPrimary: boolean;
}

/** What the browser can do, sent at session start (A02 section 3.1). Pure, so it is testable without a browser. */
export function detectCapabilities(i: CapabilityInput): CapabilityReport {
  const canOcr = i.hasWorker && i.hasDisplayMedia;
  const low = (i.deviceMemoryGb ?? 8) <= 4 || (i.hardwareConcurrency ?? 4) <= 2;
  return {
    ocrBackend: !canOcr ? 'none' : i.hasWebGpu ? 'webgpu' : 'wasm',
    webgpu: i.hasWebGpu,
    sampler: low ? { ...DEFAULT_SAMPLER, minIntervalMs: 3000, maxPerMinute: 10 } : DEFAULT_SAMPLER,
    pickerPrimary: !canOcr || low,
  };
}

// ---- nothing but text may leave --------------------------------------------------------------------------------------

/**
 * Last line of defence before a hint is sent: refuses typed arrays, buffers, data URIs and long base64-looking strings
 * anywhere in the payload (A02 section 3.5). The strict schema already forbids extra fields; this is the belt to its braces.
 */
export function assertNoPixels(value: unknown, path = 'payload'): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/^data:/i.test(value) || value.length > 500 || /^[A-Za-z0-9+/=]{200,}$/.test(value)) {
      throw new Error(`${path} looks like image data`);
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    throw new Error(`${path} is binary data`);
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${path} is too large to be text`);
    for (const [i, v] of value.entries()) assertNoPixels(v, `${path}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(value)) assertNoPixels(v, `${path}.${k}`);
}

/** Validates against the contract and refuses anything that could be pixels. Returns the payload to send. */
export function prepareHint(ctx: OcrContext): OcrContext {
  const parsed = OcrContextSchema.parse(ctx);
  assertNoPixels(parsed);
  return parsed;
}

// ---- the capture loop ------------------------------------------------------------------------------------------------

export interface FrameSource {
  /** The newest frame, or null when none is ready. The loop does not keep it. */
  grab(): Promise<Frame | null>;
  stop(): void;
}
export interface Timer {
  now(): number;
  every(ms: number, fn: () => void): () => void;
}
export interface CaptureOptions {
  source: FrameSource;
  engine: OcrEngine;
  roi: Roi;
  timer: Timer;
  /** Receives text-only context. Wire this to the socket's `context.hint`. */
  onContext: (ctx: OcrContext) => void;
  onStats?: (s: CaptureStats) => void;
  sampler?: SamplerOptions;
  tickMs?: number;
  /** A page that identified itself as TradingView from its title. */
  tradingView?: boolean;
}
export interface CaptureStats {
  processed: number;
  skippedUnchanged: number;
  skippedRate: number;
  droppedBusy: number;
  failures: number;
  lastMs: number | null;
}

/**
 * Samples a shared screen, recognises text on the device and emits `OcrContext` only. One recognition runs at a time
 * (extra ticks are dropped, never queued), so the main thread is never waiting on it. Frames are not retained.
 */
export class CaptureLoop {
  private readonly gate: FrameGate;
  private stopTicker: (() => void) | null = null;
  private busy = false;
  readonly stats: CaptureStats = {
    processed: 0,
    skippedUnchanged: 0,
    skippedRate: 0,
    droppedBusy: 0,
    failures: 0,
    lastMs: null,
  };

  constructor(private readonly o: CaptureOptions) {
    this.gate = new FrameGate(o.sampler ?? DEFAULT_SAMPLER);
  }

  start(): void {
    if (this.stopTicker) return;
    this.stopTicker = this.o.timer.every(this.o.tickMs ?? 500, () => void this.tick(false));
  }

  stop(): void {
    this.stopTicker?.();
    this.stopTicker = null;
    this.o.source.stop();
    this.gate.reset();
  }

  /** Runs one cycle now regardless of the diff gate (for "explain this chart" or after a symbol change). */
  async tickNow(): Promise<void> {
    await this.tick(true);
  }

  private async tick(force: boolean): Promise<void> {
    if (this.busy) {
      this.stats.droppedBusy++;
      return;
    }
    this.busy = true;
    try {
      const frame = await this.o.source.grab();
      if (!frame) return;
      const now = this.o.timer.now();
      const verdict = this.gate.check(frame, now, this.o.roi, force);
      if (!verdict.process) {
        if (verdict.reason === 'UNCHANGED') this.stats.skippedUnchanged++;
        else this.stats.skippedRate++;
        return;
      }
      const started = this.o.timer.now();
      const lines = await this.o.engine.recognize(cropRoi(frame, this.o.roi));
      const ms = this.o.timer.now() - started;
      const ctx = buildOcrContext(lines, {
        capturedAt: now,
        roi: { w: this.o.roi.w, h: this.o.roi.h },
        engine: this.o.engine.info,
        ms,
        ...(this.o.tradingView ? { tradingView: true } : {}),
      });
      this.o.onContext(prepareHint(ctx));
      this.stats.processed++;
      this.stats.lastMs = ms;
    } catch {
      this.stats.failures++;
    } finally {
      this.busy = false;
      this.o.onStats?.({ ...this.stats });
    }
  }
}
