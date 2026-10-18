import type { LiveRecognizer } from '@smc/capture-kit';

/**
 * The browser's own speech recognition, used only when it can run fully on this device (the language pack is
 * installed and `processLocally` is honoured). It shows words while you speak and is more accurate than a tiny model.
 * If the browser cannot promise on-device processing it is not used at all: audio is never handed to a cloud service.
 */
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string; confidence: number };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: { results: ArrayLike<RecognitionResult> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionCtor {
  new (): RecognitionLike;
  available?(o: { langs: string[]; processLocally: boolean }): Promise<string>;
  install?(o: { langs: string[]; processLocally: boolean }): Promise<boolean>;
  prototype: object;
}

const LANG = 'en-US';

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Null when the browser cannot do on-device recognition; call this from the click that turns voice on. */
export async function createBrowserRecognizer(
  onNote: (text: string | null) => void,
): Promise<LiveRecognizer | null> {
  const C = ctor();
  if (!C || typeof C.available !== 'function' || !('processLocally' in C.prototype)) return null;
  const opts = { langs: [LANG], processLocally: true };
  let status = await C.available(opts).catch(() => 'unavailable');
  if ((status === 'downloadable' || status === 'downloading') && typeof C.install === 'function') {
    onNote('Downloading the on-device speech language pack (once)…');
    const ok = await C.install(opts).catch(() => false);
    status = ok ? 'available' : 'unavailable';
    onNote(null);
  }
  if (status !== 'available') return null;

  let rec: RecognitionLike | null = null;
  let finalText = '';
  let interim = '';
  let confs: number[] = [];
  let ended = true;
  const waiters: (() => void)[] = [];

  const result = () => {
    const text = (finalText + interim).trim();
    const known = confs.filter((c) => c > 0);
    // Chrome reports a confidence for final results; fall back to a modest value when it does not.
    const confidence = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0.8;
    return { text, confidence };
  };

  return {
    tag: 'browser-local',
    start(onPartial) {
      return new Promise<void>((resolve, reject) => {
        const r = new (C as RecognitionCtor)();
        rec = r;
        finalText = '';
        interim = '';
        confs = [];
        ended = false;
        let started = false;
        r.lang = LANG;
        r.continuous = true;
        r.interimResults = true;
        r.maxAlternatives = 1;
        r.processLocally = true; // the audio must stay on this device
        r.onstart = () => {
          started = true;
          resolve();
        };
        r.onresult = (e) => {
          let fin = '';
          let int = '';
          const cs: number[] = [];
          for (let i = 0; i < e.results.length; i++) {
            const res = e.results[i] as RecognitionResult;
            if (res.isFinal) {
              fin += res[0].transcript;
              cs.push(res[0].confidence);
            } else int += res[0].transcript;
          }
          finalText = fin;
          interim = int;
          confs = cs;
          onPartial((fin + int).trim());
        };
        r.onerror = (e) => {
          if (!started) reject(new Error(e.error));
        };
        r.onend = () => {
          ended = true;
          if (!started) reject(new Error('ended before start'));
          for (const w of waiters.splice(0)) w();
        };
        try {
          r.start();
        } catch (e) {
          reject(e instanceof Error ? e : new Error('start failed'));
        }
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!rec || ended) return resolve(result());
        waiters.push(() => resolve(result()));
        rec.stop();
        // Never wait forever for the last words.
        setTimeout(() => resolve(result()), 3000);
      });
    },
    abort() {
      rec?.abort();
      rec = null;
    },
  };
}
