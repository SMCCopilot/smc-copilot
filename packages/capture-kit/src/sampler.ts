import type { Frame, Roi } from './types.js';

export interface SamplerOptions {
  /** Never sample more often than this. */
  minIntervalMs: number;
  /** Hard cap per rolling minute (battery and CPU). */
  maxPerMinute: number;
  /** Mean absolute grey difference (0 to 255) below which a frame counts as unchanged. */
  diffThreshold: number;
}
export const DEFAULT_SAMPLER: SamplerOptions = {
  minIntervalMs: 1500,
  maxPerMinute: 20,
  diffThreshold: 2,
};

const GRID_W = 32;
const GRID_H = 18;

/** A tiny grey signature of a frame (576 bytes). It is all that is kept between frames: never the frame itself. */
export function signature(frame: Frame, roi?: Roi): Uint8Array {
  const r = roi ?? { x: 0, y: 0, w: frame.width, h: frame.height };
  const out = new Uint8Array(GRID_W * GRID_H);
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.min(frame.width - 1, Math.floor(r.x + ((gx + 0.5) / GRID_W) * r.w));
      const y = Math.min(frame.height - 1, Math.floor(r.y + ((gy + 0.5) / GRID_H) * r.h));
      const i = (y * frame.width + x) * 4;
      const [R, G, B] = [frame.data[i] ?? 0, frame.data[i + 1] ?? 0, frame.data[i + 2] ?? 0];
      out[gy * GRID_W + gx] = Math.round(0.299 * R + 0.587 * G + 0.114 * B);
    }
  }
  return out;
}

export function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return s / a.length;
}

export type SampleVerdict =
  | { process: true }
  | { process: false; reason: 'TOO_SOON' | 'RATE_CAP' | 'UNCHANGED' };

/**
 * Decides whether a captured frame is worth recognising: not too soon after the last one, under the per-minute cap,
 * and visibly different from the last processed frame (A02 section 3.1). Keeps only a small signature, never pixels.
 */
export class FrameGate {
  private last: Uint8Array | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private stamps: number[] = [];

  constructor(private readonly o: SamplerOptions = DEFAULT_SAMPLER) {}

  check(frame: Frame, nowMs: number, roi?: Roi, force = false): SampleVerdict {
    if (!force && nowMs - this.lastAt < this.o.minIntervalMs)
      return { process: false, reason: 'TOO_SOON' };
    this.stamps = this.stamps.filter((t) => nowMs - t < 60_000);
    if (!force && this.stamps.length >= this.o.maxPerMinute)
      return { process: false, reason: 'RATE_CAP' };
    const sig = signature(frame, roi);
    if (!force && this.last && meanDiff(sig, this.last) < this.o.diffThreshold) {
      return { process: false, reason: 'UNCHANGED' };
    }
    this.last = sig;
    this.lastAt = nowMs;
    this.stamps.push(nowMs);
    return { process: true };
  }

  reset(): void {
    this.last = null;
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.stamps = [];
  }
}

/** Copies the region of interest out of a frame (clamped to the frame). */
export function cropRoi(frame: Frame, roi: Roi): Frame {
  const x0 = Math.max(0, Math.min(frame.width - 1, Math.floor(roi.x)));
  const y0 = Math.max(0, Math.min(frame.height - 1, Math.floor(roi.y)));
  const w = Math.max(1, Math.min(frame.width - x0, Math.floor(roi.w)));
  const h = Math.max(1, Math.min(frame.height - y0, Math.floor(roi.h)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y0 + row) * frame.width + x0) * 4;
    data.set(frame.data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}
