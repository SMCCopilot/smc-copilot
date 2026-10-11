import { ApiProblemSchema, ERROR_STATUS } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { ApiProblemError, toProblem } from '../src/common/problem.js';

const cid = 'corr-12345678';

describe('toProblem', () => {
  it('maps an ApiProblemError to its catalogue status and keeps extras', () => {
    const { problem, unexpected } = toProblem(
      new ApiProblemError('PLAN_CHANGED', 'moved', { diff: { stop: { from: 1, to: 2 } } }),
      cid,
    );
    expect(unexpected).toBe(false);
    expect(ApiProblemSchema.parse(problem)).toMatchObject({
      status: 409,
      code: 'PLAN_CHANGED',
      correlationId: cid,
      type: 'urn:smc-copilot:error:plan-changed',
      title: 'Plan changed',
    });
    expect(problem.extras).toEqual({ diff: { stop: { from: 1, to: 2 } } });
  });

  it('keeps every catalogue code self-consistent', () => {
    for (const code of Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[]) {
      expect(() =>
        ApiProblemSchema.parse(toProblem(new ApiProblemError(code), cid).problem),
      ).not.toThrow();
    }
  });

  it('maps zod-like errors to VALIDATION_FAILED listing paths and rules but never values', () => {
    const { problem } = toProblem(
      { issues: [{ path: ['body', 'text'], code: 'too_big', message: 'Too big' }] },
      cid,
    );
    expect(problem).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      extras: { issues: [{ path: 'body.text', code: 'too_big', message: 'Too big' }] },
    });
  });

  it.each([
    [{ status: 413, type: 'entity.too.large' }, 'PAYLOAD_TOO_LARGE', 413],
    [{ status: 400, type: 'entity.parse.failed' }, 'VALIDATION_FAILED', 422],
    [{ statusCode: 429 }, 'RATE_LIMITED', 429],
    [{ status: 404 }, 'NOT_FOUND', 404],
  ])('maps the framework error %j', (error, code, status) => {
    const { problem, unexpected } = toProblem(error, cid);
    expect(problem).toMatchObject({ code, status });
    expect(unexpected).toBe(false);
  });

  it('sends Retry-After with RATE_LIMITED', () => {
    expect(toProblem({ status: 429 }, cid).headers['Retry-After']).toBeDefined();
  });

  it.each([
    new Error('db password is hunter2'),
    'string failure',
    null,
    undefined,
    { status: 503 },
  ])('turns %j into INTERNAL without leaking', (error) => {
    const { problem, unexpected } = toProblem(error, cid);
    expect(unexpected).toBe(true);
    expect(problem).toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(JSON.stringify(problem)).not.toContain('hunter2');
  });
});
