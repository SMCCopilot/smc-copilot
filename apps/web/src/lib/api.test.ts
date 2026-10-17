import { ERROR_CODES, ERROR_STATUS } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { FRIENDLY, toApiError } from './errors';

describe('error mapping', () => {
  it('has a friendly message for every contract code', () => {
    for (const code of ERROR_CODES) expect(FRIENDLY[code].message.length).toBeGreaterThan(0);
  });
  it('maps problem+json by code', async () => {
    const body = {
      type: 'about:blank',
      title: 't',
      status: ERROR_STATUS.GATE_TOKEN_EXPIRED,
      code: 'GATE_TOKEN_EXPIRED',
      correlationId: 'c',
    };
    const e = await toApiError(new Response(JSON.stringify(body), { status: 410 }));
    expect(e.code).toBe('GATE_TOKEN_EXPIRED');
    expect(e.friendly.recovery).toBe('REFRESH_PLAN');
  });
  it('survives a non-problem body', async () => {
    const e = await toApiError(new Response('nope', { status: 502 }));
    expect(e.code).toBeNull();
  });
});
