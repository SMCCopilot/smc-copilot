import { describe, expect, it } from 'vitest';
import { main } from '../src/eval.mjs';
import { makeFixtures } from '../src/fixtures.mjs';
import { main as sessionHour } from '../src/session-hour.mjs';

describe('fixtures', () => {
  it('are deterministic, valid, and include the safety edge cases', () => {
    const a = makeFixtures(100);
    const b = makeFixtures(100);
    expect(a).toEqual(b);
    expect(a).toHaveLength(100);
    expect(a.some((f) => f.dataQuality === 'STALE')).toBe(true);
    expect(a.some((f) => f.setups.length === 0)).toBe(true);
    expect(a.some((f) => f.setups.length >= 3)).toBe(true);
    expect(a.some((f) => f.setups.some((s) => s.stats))).toBe(true);
    expect(a.some((f) => f.setups.some((s) => s.stats === null))).toBe(true);
    expect(a.some((f) => f.htfBias.lastBreak === null)).toBe(true);
    expect(a.some((f) => f.levels.length === 0)).toBe(true);
  });
});

describe('offline harness check', () => {
  it('shows the guardrails catching deliberately bad answers: nothing unsafe is released', async () => {
    const { summary, verdict } = await main(['--n', '100'], {});
    expect(summary.n).toBe(100);
    expect(summary.bannedReleased).toBe(0);
    expect(summary.strayNumbersReleased).toBe(0);
    expect(summary.refIntegrityRate).toBe(1);
    expect(summary.historyIntegrityRate).toBe(1);
    // The stand-in misbehaves on purpose: some answers needed a retry, some fell back to the template.
    expect(summary.retriedRate).toBeGreaterThan(0.1);
    expect(summary.templateFallback).toBeGreaterThan(0);
    expect(summary.templateFallback).toBeLessThan(30);
    expect(verdict.passed).toBe(true);
  });

  it('live mode prints an estimate and sends nothing without --yes', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'k',
      AI_PRICES_JSON: JSON.stringify({ 'claude-sonnet-5-5': { in: 3, out: 15 } }),
    };
    const r = await main(['--live', '--provider', 'anthropic', '--n', '100'], env);
    expect(r.dryRun).toBe(true);
    expect(r.estimateUsd).toBeGreaterThan(0.1);
    expect(r.estimateUsd).toBeLessThan(2);
  });

  it('the judge must be a different vendor', async () => {
    await expect(
      main(['--live', '--provider', 'anthropic', '--judge', 'anthropic'], {
        ANTHROPIC_API_KEY: 'k',
      }),
    ).rejects.toThrow(/different vendor/);
  });

  it('a live run without a key fails clearly', async () => {
    await expect(main(['--live', '--provider', 'openai'], {})).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe('session-hour', () => {
  it('prints an estimate and sends nothing without --yes', async () => {
    const r = await sessionHour(['--provider', 'anthropic'], {
      ANTHROPIC_API_KEY: 'k',
      AI_PRICES_JSON: JSON.stringify({ 'claude-sonnet-5-5': { in: 3, out: 15 } }),
    });
    expect(r.dryRun).toBe(true);
    expect(r.estimateUsd).toBeGreaterThan(0.05);
    expect(r.estimateUsd).toBeLessThan(0.5);
  });
  it('refuses to run without a key', async () => {
    await expect(sessionHour(['--provider', 'gemini'], {})).rejects.toThrow(/GEMINI_API_KEY/);
  });
});
