import type { Frame, OcrEngine, OcrEngineInfo, OcrLine } from './types.js';

/**
 * Message protocol between the page and the OCR Web Worker. The worker owns the recogniser and the model cache; the
 * page only posts frames (transferred, so they are not copied) and receives text lines. These types are structural, so
 * the same code runs in the worker, on the page, and in tests with a fake worker.
 */
export type ToWorker =
  | { type: 'init'; id: number; backend: 'webgpu' | 'wasm' }
  | { type: 'recognize'; id: number; width: number; height: number; data: ArrayBuffer };
export type FromWorker =
  | { type: 'ready'; id: number; info: OcrEngineInfo }
  | { type: 'lines'; id: number; lines: OcrLine[] }
  | { type: 'error'; id: number; message: string };

export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: ArrayBuffer[]): void;
  addEventListener(type: 'message', fn: (e: { data: FromWorker }) => void): void;
  removeEventListener(type: 'message', fn: (e: { data: FromWorker }) => void): void;
  terminate(): void;
}

/**
 * Page-side proxy for the worker. It is an `OcrEngine`, so the capture loop does not know a worker exists. Every call
 * has a deadline: a stuck recogniser fails that frame instead of hanging the loop.
 */
export class OcrWorkerClient implements OcrEngine {
  private seq = 0;
  private _info: OcrEngineInfo = { name: 'paddleocr-web', version: 'unknown', backend: 'wasm' };

  constructor(
    private readonly worker: WorkerLike,
    private readonly timeoutMs = 8000,
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) =>
      setTimeout(fn, ms),
    private readonly clearTimer: (h: unknown) => void = (h) => clearTimeout(h as never),
  ) {}

  get info(): OcrEngineInfo {
    return this._info;
  }

  private request<T extends FromWorker>(
    msg: ToWorker,
    transfer: ArrayBuffer[],
    want: T['type'],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => {
        this.clearTimer(timer);
        this.worker.removeEventListener('message', on);
        fn();
      };
      const on = (e: { data: FromWorker }) => {
        if (e.data.id !== msg.id) return;
        if (e.data.type === 'error')
          return done(() => reject(new Error(e.data.type === 'error' ? e.data.message : 'error')));
        if (e.data.type === want) done(() => resolve(e.data as T));
      };
      const timer = this.setTimer(
        () => done(() => reject(new Error('OCR timed out'))),
        this.timeoutMs,
      );
      this.worker.addEventListener('message', on);
      this.worker.postMessage(msg, transfer);
    });
  }

  async init(backend: 'webgpu' | 'wasm'): Promise<OcrEngineInfo> {
    const r = await this.request<Extract<FromWorker, { type: 'ready' }>>(
      { type: 'init', id: ++this.seq, backend },
      [],
      'ready',
    );
    this._info = r.info;
    return r.info;
  }

  async recognize(frame: Frame): Promise<OcrLine[]> {
    // The buffer is copied once here so the caller's frame stays usable; the copy is transferred and then gone.
    const copy = frame.data.slice().buffer;
    const r = await this.request<Extract<FromWorker, { type: 'lines' }>>(
      { type: 'recognize', id: ++this.seq, width: frame.width, height: frame.height, data: copy },
      [copy],
      'lines',
    );
    return r.lines;
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** Worker-side handler: wire `self.onmessage` to this with a factory that builds the real recogniser (spike S1). */
export function createWorkerHost(
  makeEngine: (backend: 'webgpu' | 'wasm') => Promise<OcrEngine>,
  post: (msg: FromWorker) => void,
): (msg: ToWorker) => Promise<void> {
  let engine: OcrEngine | null = null;
  return async (msg) => {
    try {
      if (msg.type === 'init') {
        engine = await makeEngine(msg.backend);
        post({ type: 'ready', id: msg.id, info: engine.info });
      } else if (engine) {
        const lines = await engine.recognize({
          width: msg.width,
          height: msg.height,
          data: new Uint8ClampedArray(msg.data),
        });
        post({ type: 'lines', id: msg.id, lines });
      } else {
        post({ type: 'error', id: msg.id, message: 'engine not initialised' });
      }
    } catch (e) {
      post({
        type: 'error',
        id: msg.id,
        message: e instanceof Error ? e.message.slice(0, 200) : 'failed',
      });
    }
  };
}
