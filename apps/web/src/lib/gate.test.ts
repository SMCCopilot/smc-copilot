import { describe, expect, it } from 'vitest';
import { createKeyHolder, nextStep, shortAddress } from './gate';
import { explainWalletError } from './wallets';

const me = (o: { invited?: boolean; req?: boolean; disc?: string | null; age?: boolean }) => ({
  invite: { required: o.req ?? true, redeemed: o.invited ?? false },
  disclaimer: { required: true, currentVersion: 'v2', acceptedVersion: o.disc ?? null },
  ageConfirmed: o.age ?? false,
});

describe('onboarding order', () => {
  it('asks for the invite, then the disclaimer, then age', () => {
    expect(nextStep(me({}))).toBe('INVITE');
    expect(nextStep(me({ invited: true }))).toBe('DISCLAIMER');
    expect(nextStep(me({ invited: true, disc: 'v1' }))).toBe('DISCLAIMER');
    expect(nextStep(me({ invited: true, disc: 'v2' }))).toBe('AGE');
    expect(nextStep(me({ invited: true, disc: 'v2', age: true }))).toBe('DONE');
  });
  it('skips the invite when the deployment does not require one', () => {
    expect(nextStep(me({ req: false }))).toBe('DISCLAIMER');
  });
});

describe('idempotency key holder', () => {
  it('reuses the key for a retry and replaces it when the request changes', () => {
    let n = 0;
    const k = createKeyHolder(() => `k${++n}`);
    expect(k.get('a')).toBe('k1');
    expect(k.get('a')).toBe('k1');
    expect(k.get('b')).toBe('k2');
    k.release();
    expect(k.get('b')).toBe('k3');
  });
});

describe('wallet helpers', () => {
  it('shortens addresses', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(shortAddress('short')).toBe('short');
  });
  it('explains the common sign-in failures', () => {
    expect(explainWalletError('User rejected the request', 'http://x')).toMatch(/cancelled/);
    expect(explainWalletError('Unacceptable domain', 'http://localhost:3000')).toMatch(
      /Redirect URLs/,
    );
    expect(explainWalletError('web3 provider is disabled', 'http://x')).toMatch(/Web3 Wallet/);
  });
});
