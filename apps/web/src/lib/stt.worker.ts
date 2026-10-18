/// <reference lib="webworker" />
// Speech recognition in a Web Worker so the page's main thread stays free. Model files come only from the
// server's pinned list and must match their SHA-256 and size, or they are refused (A02 section 6.3).
import { loadVerified, type ModelCache, type ModelFile, type ModelIo } from '@smc/capture-kit';
import { pinnedFor } from './stt-pin';

interface InitMsg {
  type: 'init';
  id: number;
  repo: string;
  revision: string;
  backend: 'webgpu' | 'wasm';
  files: ModelFile[];
}
interface RunMsg {
  type: 'transcribe';
  id: number;
  pcm: Float32Array;
}
type In = InitMsg | RunMsg;

const cacheApi: ModelCache = {
  async get(key) {
    try {
      const c = await caches.open('smc-speech-models');
      const r = await c.match(`/__model/${key}`);
      return r ? new Uint8Array(await r.arrayBuffer()) : undefined;
    } catch {
      return undefined;
    }
  },
  async put(key, bytes) {
    try {
      const c = await caches.open('smc-speech-models');
      await c.put(`/__model/${key}`, new Response(bytes as BufferSource));
    } catch {}
  },
};

const io: ModelIo = {
  async fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  },
  async sha256(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
  cache: cacheApi,
};

// biome-ignore lint/suspicious/noExplicitAny: the pipeline type is large and only called through one method
let asr: ((audio: Float32Array, opts?: Record<string, unknown>) => Promise<any>) | null = null;

async function init(m: InitMsg): Promise<void> {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  // Every network read of the library goes through here: pinned model files are verified, other model-hub
  // requests are refused, and only same-origin files (the runtime under /vendor) may be fetched directly.
  env.fetch = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const file = pinnedFor(url, m.files);
    if (file) {
      const bytes = await loadVerified(file, io);
      return new Response(bytes as BufferSource, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      });
    }
    if (/^https?:\/\/(www\.)?huggingface\.co\//i.test(url))
      return new Response(null, { status: 404 });
    if (url.startsWith('/') || url.startsWith(self.location.origin)) return fetch(url, init);
    throw new Error('blocked request to an unpinned address');
  };
  // biome-ignore lint/suspicious/noExplicitAny: wasm paths are typed loosely across library versions
  const onnx = env.backends.onnx as any;
  if (onnx?.wasm) onnx.wasm.wasmPaths = '/vendor/ort/';
  asr = (await pipeline('automatic-speech-recognition', m.repo, {
    device: m.backend === 'webgpu' ? 'webgpu' : 'wasm',
    dtype: 'q8',
    revision: m.revision,
  })) as unknown as typeof asr;
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      await init(m);
      self.postMessage({ type: 'ready', id: m.id });
    } else if (asr) {
      const out = await asr(m.pcm, { chunk_length_s: 30 });
      const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : String(out?.text ?? '');
      self.postMessage({ type: 'text', id: m.id, text });
    } else {
      self.postMessage({ type: 'error', id: m.id, message: 'not ready' });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: m.id,
      message: err instanceof Error ? err.message.slice(0, 400) : 'failed',
    });
  }
};
