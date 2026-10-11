import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATES, main, wer } from '../src/eval.mjs';
import { PHRASES } from '../src/phrases.mjs';
import { hashFile, MANIFEST, pin, unpinned, urlOf } from '../src/pin-models.mjs';

describe('the phrase set', () => {
  it('has 200 phrases across the five categories, with unique ids', () => {
    expect(PHRASES).toHaveLength(200);
    expect(new Set(PHRASES.map((p) => p.id)).size).toBe(200);
    const cats = new Set(PHRASES.map((p) => p.category));
    expect([...cats].sort()).toEqual(['command', 'forbidden', 'jargon', 'question', 'symbol']);
  });
});

describe('text-only check of correction and grammar', () => {
  it('passes every gate on the simulated engine output', () => {
    const { s, v } = main([]);
    expect(s.commandAccuracy).toBeGreaterThanOrEqual(GATES.commandAccuracy);
    expect(s.forbiddenCaught).toBe(1);
    expect(s.jargonAccuracy).toBeGreaterThanOrEqual(GATES.jargonAccuracy);
    expect(s.falseCommandOnQuestions).toBe(0);
    expect(v.passed).toBe(true);
  });

  it('prints the numbered script to read aloud', () => {
    const { script } = main(['--print-script']);
    expect(script.split('\n')).toHaveLength(200);
    expect(script).toContain('explain this chart');
  });
});

describe('scoring a real engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-eval-'));
  const write = (rows) => {
    const p = join(dir, `r${Math.random()}.json`);
    writeFileSync(p, JSON.stringify(rows));
    return p;
  };

  it('a perfect engine passes, including word error rate and latency', () => {
    const rows = PHRASES.map((p) => ({ id: p.id, hypothesis: p.say, latencyMs: 900 }));
    const { s, v } = main(['--results', write(rows)]);
    expect(s.wer).toBe(0);
    expect(s.p95LatencyMs).toBe(900);
    expect(v.passed).toBe(true);
  });

  it('a poor engine fails the gates and the report names the misses', () => {
    const rows = PHRASES.map((p) => ({ id: p.id, hypothesis: 'uh what', latencyMs: 4000 }));
    const { s, v, report } = main(['--results', write(rows)]);
    expect(v.passed).toBe(false);
    expect(s.p95LatencyMs).toBe(4000);
    expect(report).toContain('## Misses');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('word error rate', () => {
  it('counts substitutions, insertions and deletions over the reference length', () => {
    expect(wer('switch to fifteen minute', 'switch to fifteen minute')).toBe(0);
    expect(wer('switch to fifteen minute', 'switch two fifteen minute')).toBeCloseTo(0.25);
    expect(wer('a b c d', 'a b')).toBeCloseTo(0.5);
    expect(wer('a b', 'a b c d')).toBeCloseTo(1);
    expect(wer('', '')).toBe(0);
  });
});

describe('speech model manifest', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));

  it('is fully pinned: every file has a revision, a SHA-256 and a size', () => {
    expect(unpinned(m)).toEqual([]);
    for (const g of [...m.engines, m.vad]) {
      expect(g.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const f of g.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes).toBeGreaterThan(0);
      }
    }
  });

  it('builds immutable URLs from the pinned revision', () => {
    expect(urlOf('a/b', 'c'.repeat(40), 'onnx/x.onnx')).toBe(
      `https://huggingface.co/a/b/resolve/${'c'.repeat(40)}/onnx/x.onnx`,
    );
  });

  const fake = (body) => async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield body;
    })(),
    json: async () => ({ sha: 'd'.repeat(40) }),
  });

  it('hashes a download as it streams', async () => {
    const bytes = Buffer.from('model bytes');
    const r = await hashFile('https://x', fake(bytes));
    expect(r).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  });

  it('pins missing entries and, in verify mode, rejects a changed file', async () => {
    const mini = {
      engines: [],
      vad: {
        repo: 'r/v',
        revision: null,
        files: [{ id: 'model', path: 'x', sha256: null, bytes: null }],
      },
    };
    const f = async (url) =>
      String(url).includes('/api/models/')
        ? { ok: true, json: async () => ({ sha: 'e'.repeat(40) }) }
        : fake(Buffer.from('abc'))();
    expect(await pin(mini, { fetchImpl: f, log: () => {} })).toBe(true);
    expect(mini.vad.revision).toBe('e'.repeat(40));
    expect(unpinned(mini)).toEqual([]);
    const f2 = async (url) =>
      String(url).includes('/api/models/')
        ? { ok: true, json: async () => ({ sha: 'e'.repeat(40) }) }
        : fake(Buffer.from('DIFFERENT'))();
    await expect(pin(mini, { verify: true, fetchImpl: f2, log: () => {} })).rejects.toThrow(
      /no longer matches/,
    );
  });

  it('flags an unpinned manifest', () => {
    expect(
      unpinned({
        engines: [{ tag: 'x', revision: null, files: [] }],
        vad: { revision: 'a', files: [{ sha256: null, bytes: 1 }] },
      }),
    ).toEqual(['x', 'vad']);
  });
});
