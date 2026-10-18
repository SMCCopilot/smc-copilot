import type { MeResponse } from '@smc/contracts';

export type OnboardingStep = 'DISCLAIMER' | 'AGE' | 'DONE';

/** Which account gate is still open, in the order the API checks them. Display only; the API enforces them. */
export function nextStep(me: Pick<MeResponse, 'disclaimer' | 'ageConfirmed'>): OnboardingStep {
  if (me.disclaimer.required && me.disclaimer.acceptedVersion !== me.disclaimer.currentVersion) {
    return 'DISCLAIMER';
  }
  if (!me.ageConfirmed) return 'AGE';
  return 'DONE';
}

export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * One idempotency key per user action: reused when the same request is retried, replaced when the request
 * content changes (the server rejects a reused key with different content), dropped once it succeeds.
 */
export function createKeyHolder(make: () => string) {
  let key: string | undefined;
  let sig: string | undefined;
  return {
    get: (signature: string) => {
      if (key === undefined || sig !== signature) {
        key = make();
        sig = signature;
      }
      return key;
    },
    release: () => {
      key = undefined;
      sig = undefined;
    },
  };
}
