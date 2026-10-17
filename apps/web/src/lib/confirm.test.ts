import { describe, expect, it } from 'vitest';
import { confirmRequest, gateMatchesPlan, remainingMs, tradeBody } from './confirm';

const plan = {
  planId: 'p1',
  planHash: 'hash-a',
  direction: 'LONG' as const,
  entry: { refPrice: 100 },
  stop: { price: 95 },
  targets: [{ price: 110 }, { price: 120 }],
};
const gate = {
  gateId: 'g1',
  planId: 'p1',
  planHash: 'hash-a',
  expiresAt: '2026-10-17T12:01:00.000Z',
  token: 't'.repeat(20),
};

describe('confirm gate', () => {
  it('counts down to zero and never goes negative', () => {
    const t0 = Date.parse('2026-10-17T12:00:00.000Z');
    expect(remainingMs(gate, t0)).toBe(60_000);
    expect(remainingMs(gate, t0 + 61_000)).toBe(0);
  });
  it('detects a gate that is not for the plan on screen', () => {
    expect(gateMatchesPlan(gate, plan)).toBe(true);
    expect(gateMatchesPlan({ ...gate, planHash: 'hash-b' }, plan)).toBe(false);
    expect(gateMatchesPlan({ ...gate, planId: 'p2' }, plan)).toBe(false);
  });
  it('confirms only as a tap, with the hash the user was shown', () => {
    const r = confirmRequest(gate, plan);
    expect(r.headers).toEqual({ 'x-input-mode': 'tap' });
    expect(r.body).toEqual({ token: gate.token, planHash: 'hash-a' });
    expect(r.path).toBe('/v1/gate/g1/confirm');
  });
  it('logs exactly the plan levels, bound to the gate', () => {
    expect(tradeBody('inst', gate, plan)).toEqual({
      instrumentId: 'inst',
      direction: 'LONG',
      entryPrice: 100,
      stopPrice: 95,
      targets: [110, 120],
      planId: 'p1',
      gateId: 'g1',
    });
  });
});
