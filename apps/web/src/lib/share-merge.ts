import type { OcrContext } from '@smc/contracts';

/**
 * OCR on a live chart varies from one pass to the next: a pass may miss the symbol line that the one before read. Keep
 * the symbol, timeframe and venue read earlier until a later pass reads a new one. The price always follows the latest
 * pass (a stale price would be wrong).
 */
export function keepKnown(prev: OcrContext | null, next: OcrContext): OcrContext {
  const p = prev?.derived;
  const d = next.derived;
  if (!p) return next;
  const symbolText = d?.symbolText ?? p.symbolText;
  const tfText = d?.tfText ?? p.tfText;
  const venueText = d?.venueText ?? p.venueText;
  return {
    ...next,
    derived: {
      ...(d ?? {}),
      ...(symbolText ? { symbolText, ...(d?.symbolText ? {} : { isPerp: p.isPerp }) } : {}),
      ...(tfText ? { tfText } : {}),
      ...(venueText ? { venueText } : {}),
    },
  };
}
