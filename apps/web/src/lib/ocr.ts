import type { Frame, FrameSource, OcrEngine, OcrEngineInfo, OcrLine } from '@smc/capture-kit';

/**
 * On-device OCR for shared screens. Tesseract runs in its own worker, with its files served from /vendor (no CDN).
 * Frames are turned into text lines and dropped; pixels never leave the page.
 */
export class TesseractEngine implements OcrEngine {
  readonly info: OcrEngineInfo = { name: 'tesseract-js', version: '7', backend: 'wasm' };
  private worker: Promise<import('tesseract.js').Worker> | null = null;

  private get(): Promise<import('tesseract.js').Worker> {
    this.worker ??= import('tesseract.js').then(({ createWorker }) =>
      createWorker('eng', 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract/core',
        langPath: '/vendor/tesseract/lang',
        workerBlobURL: false,
        gzip: true,
      }),
    );
    return this.worker;
  }

  async recognize(frame: Frame): Promise<OcrLine[]> {
    const w = await this.get();
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height),
      0,
      0,
    );
    const { data } = await w.recognize(canvas, {}, { blocks: true });
    canvas.width = 0; // release the pixels
    const lines: OcrLine[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          const text = l.text.trim();
          if (text) {
            lines.push({
              text,
              conf: Math.max(0, Math.min(1, l.confidence / 100)),
              box: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1],
            });
          }
        }
      }
    }
    return lines;
  }

  async dispose(): Promise<void> {
    const w = await this.worker;
    this.worker = null;
    await w?.terminate();
  }
}

/** Grabs frames from a shared screen. Each frame lives only until the loop has read its text. */
export class ScreenSource implements FrameSource {
  private video: HTMLVideoElement | null = null;
  private canvas = document.createElement('canvas');
  /** The browser's own "stop sharing" control ends the stream; the page is told through this. */
  onEnded: (() => void) | null = null;

  constructor(private readonly stream: MediaStream) {
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = stream;
    this.video = v;
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded?.());
  }

  async start(): Promise<void> {
    await this.video?.play();
  }

  async grab(): Promise<Frame | null> {
    const v = this.video;
    if (!v || v.videoWidth === 0) return null;
    // Chart legends are small. Checked on a live 1920 px TradingView tab: at 1280 px the symbol line read as garbage
    // ("OBRCoMm/USDT", confidence 30) and at 1920 px as "BTCUSDT" / "Bitcoin/USDT - 1D - OKX" with the last price,
    // in the same time (about 2 s). Keep up to full HD.
    const scale = Math.min(1, 1920 / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: img.data };
  }

  stop(): void {
    for (const t of this.stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.canvas.width = 0;
  }
}

export const canShareScreen = (): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
  !/Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
