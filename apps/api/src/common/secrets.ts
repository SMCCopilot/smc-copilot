import { containsSecret } from '@smc/ai';
import { ApiProblemError } from './problem.js';

/**
 * Refuses text that looks like a seed phrase or private key (A05 section 12.2). Used on everything a user types that
 * could be stored or sent to a model. The message never repeats the text.
 */
export function assertNoSecret(...texts: readonly (string | null | undefined)[]): void {
  for (const t of texts) {
    if (t && containsSecret(t)) {
      throw new ApiProblemError(
        'SECRET_DETECTED',
        'That looks like a seed phrase or private key. Nothing was saved or sent. Never share these with anyone.',
      );
    }
  }
}
