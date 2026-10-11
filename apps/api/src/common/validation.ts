import type { z } from 'zod';
import { validationError } from './problem.js';

/** Parses untrusted input with a contract schema; failures become a VALIDATION_FAILED problem listing paths only. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    );
  }
  return result.data;
}
