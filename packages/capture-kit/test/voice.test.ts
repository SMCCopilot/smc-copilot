/// <reference types="node" />
import { createHash } from 'node:crypto';
import { buildGlossary, type VoiceConfig, VoiceConfigSchema } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AudioCapture,
  EnergyVad,
  engineChain,
  loadVerified,
  type ModelFile,
  ModelIntegrityError,
  type ModelIo,
  PushToTalk,
  percentile,
  rms,
  type SttEngine,
  type Transcript,
  type VoiceReport,
  type VoiceState,
  type VoiceWarning,
  voiceCommandPayload,
} from '../src/voice.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const file = (bytes: Uint8Array, id = 'm'): ModelFile => ({
  id,
  url: `https://x/${id}`,
  sha256: sha(bytes),
  bytes: bytes.byteLength,
});
const hex64 = 'a'.repeat(64);
const cfg = (over: Partial<VoiceConfig['engines'][number]>[] = []): VoiceConfig =>
  VoiceConfigSchema.parse({
    audioLeavesDevice: false,
    maxUtteranceMs: 15000,
    minConfidence: 0.6,
    languages: ['en'],
    glossaryVersion: 'v',
    engines: [
      {
        tag: 'whisper-web',
        label: 'w',
        status: 'READY',
        backend: 'webgpu',
        files: [{ id: 'a', url: 'https://x/a', sha256: hex64, bytes: 1 }],
        ...over[0],
      },
      {
        tag: 'moonshine-web',
        label: 'm',
        status: 'READY',
        backend: 'wasm',
        files: [{ id: 'a', url: 'https://x/b', sha256: hex64, bytes: 1 }],
        ...over[1],
      },
    ],
    vad: { status: 'READY', files: [] },
  });

describe('engine choice', () => {
  const caps = { hasWebGpu: true, hasWasm: true, hasMicrophoneApi: true };
  it('prefers Whisper on WebGPU, then Moonshine, and only engines the server has pinned', () => {
    expect(engineChain(cfg(), caps).map((e) => e.tag)).toEqual(['whisper-web', 'moonshine-web']);
    expect(engineChain(cfg(), { ...caps, hasWebGpu: false }).map((e) => e.tag)).toEqual([
      'moonshine-web',
    ]);
    expect(engineChain(cfg([{ status: 'UNPINNED', files: [] }]), caps).map((e) => e.tag)).toEqual([
      'moonshine-web',
    ]);
    expect(engineChain(cfg(), caps, new Set(['whisper-web'])).map((e) => e.tag)).toEqual([
      'moonshine-web',
    ]);
  });
  it('no microphone API or nothing pinned means typing only', () => {
    expect(engineChain(cfg(), { ...caps, hasMicrophoneApi: false })).toEqual([]);
    expect(
      engineChain(
        cfg([
          { status: 'UNPINNED', files: [] },
          { status: 'OFF', files: [] },
        ]),
        caps,
      ),
    ).toEqual([]);
  });
});

describe('model files are verified before use', () => {
  const good = new Uint8Array([1, 2, 3, 4, 5]);
  const memory = () => {
    const m = new Map<string, Uint8Array>();
    return {
      m,
      cache: {
        get: async (k: string) => m.get(k),
        put: async (k: string, v: Uint8Array) => void m.set(k, v),
      },
    };
  };
  const io = (
    served: Uint8Array,
    cache = memory(),
  ): ModelIo & { fetched: number; m: Map<string, Uint8Array> } => {
    const o = {
      fetched: 0,
      m: cache.m,
      cache: cache.cache,
      fetchBytes: async () => {
        o.fetched++;
        return served;
      },
      sha256: async (b: Uint8Array) => sha(b),
    };
    return o;
  };

  it('accepts the pinned bytes, caches them, and does not download again', async () => {
    const i = io(good);
    expect(await loadVerified(file(good), i)).toEqual(good);
    expect(await loadVerified(file(good), i)).toEqual(good);
    expect(i.fetched).toBe(1);
  });
  it('refuses swapped bytes and never caches them', async () => {
    const i = io(new Uint8Array([9, 9, 9, 9, 9]));
    await expect(loadVerified(file(good), i)).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(i.m.size).toBe(0);
  });
  it('refuses a truncated download even if it were to hash correctly elsewhere', async () => {
    const i = io(good.subarray(0, 3));
    await expect(loadVerified(file(good), i)).rejects.toBeInstanceOf(ModelIntegrityError);
  });
  it('re-checks a cached copy and replaces a corrupted one', async () => {
    const c = memory();
    const f = file(good);
    c.m.set(`${f.id}:${f.sha256}`, new Uint8Array([0, 0, 0, 0, 0]));
    const i = io(good, c);
    expect(await loadVerified(f, i)).toEqual(good);
    expect(i.fetched).toBe(1);
  });
});

describe('voice activity', () => {
  const loud = new Float32Array(160).fill(0.2);
  const quiet = new Float32Array(160).fill(0.001);
  it('detects the start and end of an utterance with a hangover', () => {
    const v = new EnergyVad({ threshold: 0.015, hangoverFrames: 3, minSpeechFrames: 2 });
    const events = [quiet, loud, loud, loud, quiet, quiet, quiet, quiet].map((f) => v.push(f));
    expect(events.filter(Boolean)).toEqual(['START', 'END']);
  });
  it('a click shorter than the minimum is not speech', () => {
    const v = new EnergyVad({ threshold: 0.015, hangoverFrames: 2, minSpeechFrames: 3 });
    expect([loud, quiet, quiet, quiet].map((f) => v.push(f)).filter(Boolean)).toEqual([]);
  });
  it('rms and percentile', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
    expect(percentile([100, 200, 300, 400, 5000], 95)).toBe(5000);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('what may leave the device', () => {
  it('only text and a confidence', () => {
    const ok = voiceCommandPayload({
      utteranceId: 'u1',
      text: 'switch to 15m',
      sttConfidence: 0.9,
      sttEngine: 'whisper-web',
    });
    expect(ok.text).toBe('switch to 15m');
  });
  it('refuses audio smuggled into the payload', () => {
    const bad = {
      utteranceId: 'u1',
      text: 'hi',
      sttConfidence: 0.9,
      sttEngine: 'whisper-web',
      audio: new Float32Array(10),
    };
    expect(() => voiceCommandPayload(bad as never)).toThrow();
    expect(() =>
      voiceCommandPayload({
        utteranceId: 'u1',
        text: 'x'.repeat(600),
        sttConfidence: 0.9,
        sttEngine: 'whisper-web',
      }),
    ).toThrow();
  });
  it('typed input is always possible', () => {
    expect(PushToTalk.typed('explain this chart', 'u9')).toMatchObject({
      sttEngine: 'typed',
      sttConfidence: 1,
    });
  });
});

describe('push to talk', () => {
  const glossary = buildGlossary(['BTC', 'ETH']);
  function rig(engines: SttEngine[], capture?: Partial<AudioCapture>, startAt = 1000) {
    let t = startAt;
    const timers: { at: number; fn: () => void }[] = [];
    const log = {
      states: [] as VoiceState[],
      transcripts: [] as Transcript[],
      warnings: [] as VoiceWarning[],
      reports: [] as VoiceReport[],
      partials: [] as string[],
    };
    const cap: AudioCapture = {
      start: async () => {},
      stop: async () => new Float32Array(16000).fill(0.1),
      ...capture,
    };
    const p = new PushToTalk({
      capture: cap,
      engines,
      glossary: () => glossary,
      clock: {
        now: () => t,
        after: (ms, fn) => {
          const e = { at: t + ms, fn };
          timers.push(e);
          return () => timers.splice(timers.indexOf(e), 1);
        },
      },
      minConfidence: 0.6,
      maxUtteranceMs: 15000,
      onState: (s) => log.states.push(s),
      onTranscript: (x) => log.transcripts.push(x),
      onWarning: (w) => log.warnings.push(w),
      onReport: (r) => log.reports.push(r),
      onPartial: (x) => log.partials.push(x),
    });
    return {
      p,
      log,
      advance: (ms: number) => {
        t += ms;
        for (const e of [...timers])
          if (e.at <= t) {
            timers.splice(timers.indexOf(e), 1);
            e.fn();
          }
      },
    };
  }
  const engine = (
    tag: SttEngine['tag'],
    text: string,
    confidence = 0.9,
    fail = false,
  ): SttEngine & { calls: number } => {
    const e = {
      tag,
      calls: 0,
      transcribe: async () => {
        e.calls++;
        if (fail) throw new Error('boom');
        return { text, confidence };
      },
    };
    return e;
  };

  it('shows what the engine hears about once a second while the key is held, then the final transcript', async () => {
    const eng = engine('moonshine-web', 'what is the daily structure');
    const { p, log, advance } = rig([eng], {
      peek: () => new Float32Array(16000).fill(0.1),
    });
    await p.press();
    advance(900);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.partials).toEqual(['what is the daily structure']);
    advance(900);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.partials).toHaveLength(2);
    await p.release();
    expect(log.transcripts[0]?.raw).toBe('what is the daily structure');
    // No more previews once the key is up.
    advance(5000);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.partials).toHaveLength(2);
  });

  it('reports whole milliseconds even when the clock has fractions (the server refuses fractions)', async () => {
    const { p, log, advance } = rig([engine('whisper-web', 'btc')], undefined, 1000.37);
    await p.press();
    advance(1234.567);
    await p.release();
    const r = log.reports[0];
    expect(Number.isInteger(r?.durationMs)).toBe(true);
    expect(r?.latencyMs === undefined || Number.isInteger(r.latencyMs)).toBe(true);
  });

  it('hold, release, then an editable corrected transcript, with metadata reported', async () => {
    const { p, log } = rig([engine('whisper-web', 'bee tee see perp')]);
    await p.press();
    expect(p.current).toBe('RECORDING');
    await p.release();
    expect(p.current).toBe('REVIEW');
    expect(log.transcripts[0]).toMatchObject({
      raw: 'bee tee see perp',
      text: 'BTC perp',
      corrected: true,
      forbidden: null,
      engine: 'whisper-web',
    });
    expect(log.reports[0]).toMatchObject({ engine: 'whisper-web', outcome: 'OK' });
    expect(JSON.stringify(log.reports)).not.toContain('perp'); // metadata only: no text
    p.done();
    expect(p.current).toBe('IDLE');
  });

  it('flags a forbidden request and a recognised command on the transcript', async () => {
    const a = rig([engine('whisper-web', 'confirm the trade')]);
    await a.p.press();
    await a.p.release();
    expect(a.log.transcripts[0]?.forbidden).toBe('confirm_trade');
    const b = rig([engine('whisper-web', 'switch to fifteen minute')]);
    await b.p.press();
    await b.p.release();
    expect(b.log.transcripts[0]).toMatchObject({ text: 'switch to 15m', command: 'SWITCH_TF' });
  });

  it('denied microphone permission warns and leaves typing available', async () => {
    const { p, log } = rig([engine('whisper-web', 'x')], {
      start: async () => {
        throw new Error('NotAllowedError');
      },
    });
    await p.press();
    expect(log.warnings).toContain('MIC_PERMISSION_DENIED');
    expect(p.current).toBe('UNAVAILABLE');
  });

  it('falls to the next engine when one fails, and says STT_UNAVAILABLE when all do', async () => {
    const bad = engine('whisper-web', '', 0.9, true);
    const good = engine('moonshine-web', 'show setup two');
    const r = rig([bad, good]);
    await r.p.press();
    await r.p.release();
    expect(r.log.transcripts[0]?.engine).toBe('moonshine-web');
    expect(r.log.reports.some((x) => x.engine === 'whisper-web' && x.outcome === 'ERROR')).toBe(
      true,
    );
    r.p.done();
    await r.p.press();
    await r.p.release();
    expect(bad.calls).toBe(2); // one slip is forgiven; a second in a row retires the engine
    r.p.done();
    await r.p.press();
    await r.p.release();
    expect(bad.calls).toBe(2);

    const none = rig([
      engine('whisper-web', '', 0.9, true),
      engine('moonshine-web', '', 0.9, true),
    ]);
    await none.p.press();
    await none.p.release();
    expect(none.log.warnings).toContain('STT_UNAVAILABLE');
    expect(none.p.current).toBe('IDLE'); // first failures are forgiven
    await none.p.press();
    await none.p.release();
    expect(none.p.current).toBe('UNAVAILABLE'); // second in a row retires both: typing only
  });

  it('too little audio is no speech; a quiet low-confidence result is flagged but still editable', async () => {
    const short = rig([engine('whisper-web', 'x')], { stop: async () => new Float32Array(100) });
    await short.p.press();
    await short.p.release();
    expect(short.log.warnings).toContain('NO_SPEECH');
    expect(short.p.current).toBe('IDLE');

    const low = rig([engine('whisper-web', 'explain this chart', 0.3)]);
    await low.p.press();
    await low.p.release();
    expect(low.log.warnings).toContain('LOW_CONFIDENCE');
    expect(low.log.transcripts).toHaveLength(1);
  });

  it('a held key stops itself at the maximum length', async () => {
    const r = rig([engine('whisper-web', 'mute')]);
    await r.p.press();
    r.advance(15001);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.log.warnings).toContain('TOO_LONG');
  });

  it('with no engines at all the controller starts in typing-only mode', () => {
    const r = rig([]);
    expect(r.p.current).toBe('UNAVAILABLE');
  });

  it('the recording is wiped after the utterance', async () => {
    const pcm = new Float32Array(16000).fill(0.3);
    const r = rig([engine('whisper-web', 'mute')], { stop: async () => pcm });
    await r.p.press();
    await r.p.release();
    expect(pcm.every((v) => v === 0)).toBe(true);
  });

  it('release-to-transcript latency is measured', async () => {
    const r = rig([engine('whisper-web', 'mute')]);
    await r.p.press();
    await r.p.release();
    expect(r.p.latencies).toHaveLength(1);
  });
});

describe('push to talk: review regressions', () => {
  const glossary = buildGlossary(['BTC']);
  function mk(over: Partial<AudioCapture> = {}, tr?: SttEngine['transcribe']) {
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const warnings: VoiceWarning[] = [];
    const eng: SttEngine = {
      tag: 'whisper-web',
      transcribe: tr ?? (async () => ({ text: 'mute', confidence: 0.9 })),
    };
    const starts = { n: 0, stops: 0 };
    const cap: AudioCapture = {
      start: async () => {
        starts.n++;
      },
      stop: async () => {
        starts.stops++;
        return new Float32Array(16000).fill(0.1);
      },
      ...over,
    };
    const p = new PushToTalk({
      capture: cap,
      engines: [eng],
      glossary: () => glossary,
      clock: {
        now: () => t,
        after: (ms, fn) => {
          const e = { at: t + ms, fn };
          timers.push(e);
          return () => {
            const i = timers.indexOf(e);
            if (i >= 0) timers.splice(i, 1);
          };
        },
      },
      minConfidence: 0.6,
      maxUtteranceMs: 15000,
      onState: () => {},
      onTranscript: () => {},
      onWarning: (w) => warnings.push(w),
      onReport: () => {},
    });
    return {
      p,
      warnings,
      starts,
      advance: (ms: number) => {
        t += ms;
        for (const e of [...timers])
          if (e.at <= t) {
            timers.splice(timers.indexOf(e), 1);
            e.fn();
          }
      },
    };
  }

  it('two quick presses open the microphone once', async () => {
    const r = mk();
    await Promise.all([r.p.press(), r.p.press()]);
    expect(r.starts.n).toBe(1);
  });

  it('letting go while the microphone is still opening stops straight away', async () => {
    let open: () => void = () => {};
    const r = mk({
      start: () =>
        new Promise<void>((res) => {
          open = res;
        }),
    });
    const pressing = r.p.press();
    await r.p.release();
    open();
    await pressing;
    expect(r.starts.stops).toBe(1);
    expect(r.p.current).not.toBe('RECORDING');
  });

  it('a microphone that fails to stop does not wedge the controller', async () => {
    const r = mk({
      stop: async () => {
        throw new Error('gone');
      },
    });
    await r.p.press();
    await r.p.release();
    expect(r.p.current).toBe('IDLE');
    await r.p.press();
    expect(r.p.current).toBe('RECORDING');
  });

  it('an engine that ignores the abort signal cannot hang it: the deadline wins', async () => {
    const r = mk({}, () => new Promise(() => {}));
    await r.p.press();
    const releasing = r.p.release();
    await Promise.resolve();
    r.advance(15001);
    await releasing;
    expect(r.warnings).toContain('STT_UNAVAILABLE');
    expect(r.p.current).not.toBe('TRANSCRIBING');
  });
});
