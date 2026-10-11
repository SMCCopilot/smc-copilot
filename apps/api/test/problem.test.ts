import { ApiProblemSchema, ERROR_STATUS } from '@smc/contracts';
import { describe, expect, it } from 'vitest';
import { ApiProblemError, toProblem, validationError } from '../src/common/problem.js';

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

  it('builds a validation problem from issues with paths and rules but never values', () => {
    const { problem } = toProblem(
      validationError([{ path: ['body', 'text'], code: 'too_big', message: 'Too big' }]),
      cid,
    );
    expect(problem).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      extras: { issues: [{ path: 'body.text', code: 'too_big', message: 'Too big' }] },
    });
  });

  it('treats a library error that merely has a 4xx status as an internal fault (M3)', () => {
    for (const e of [{ status: 401 }, { statusCode: 429 }, { status: 404 }, { issues: [{}] }]) {
      const { problem, unexpected } = toProblem(e, cid);
      expect(problem.code).toBe('INTERNAL');
      expect(unexpected).toBe(true);
    }
  });

  it.each([
    [{ status: 413, expose: true, type: 'entity.too.large' }, 'PAYLOAD_TOO_LARGE', 413],
    [{ status: 400, expose: true, type: 'entity.parse.failed' }, 'VALIDATION_FAILED', 422],
    [{ status: 429, expose: true, type: 'x' }, 'RATE_LIMITED', 429],
  ])('maps the framework error %j', (error, code, status) => {
    const { problem, unexpected } = toProblem(error, cid);
    expect(problem).toMatchObject({ code, status });
    expect(unexpected).toBe(false);
  });

  it('sends Retry-After with RATE_LIMITED', () => {
    expect(
      toProblem({ status: 429, expose: true, type: 'x' }, cid).headers['Retry-After'],
    ).toBeDefined();
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
