import type { ModelFile } from '@smc/capture-kit';

const HF = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+?)(?:\?.*)?$/;
const PINNED = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/[0-9a-f]{40}\/(.+)$/;

/**
 * Finds the pinned file for a model-hub address. The speech library asks for `.../resolve/main/<path>` whatever
 * revision it was given, while the server's list holds `.../resolve/<commit>/<path>`; they are the same file when
 * the repository and the path match. Anything not on the list stays unknown (and is refused by the caller).
 */
export function pinnedFor(url: string, files: readonly ModelFile[]): ModelFile | undefined {
  const exact = files.find((f) => f.url === url);
  if (exact) return exact;
  const want = HF.exec(url);
  if (!want) return undefined;
  return files.find((f) => {
    const have = PINNED.exec(f.url);
    return have !== null && have[1] === want[1] && have[2] === want[3];
  });
}
