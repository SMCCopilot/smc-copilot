import { sha1 } from './sha1.js';
import type { EngineEvent } from './types.js';

/**
 * Digest of an event stream (ids, types, timeframes, times and payloads in emission order). The engine uses
 * only IEEE-754 +, -, *, / and comparisons, so the digest is identical on x64 and arm64 (golden replay).
 */
export const eventStreamHash = (events: readonly EngineEvent[]): string =>
  sha1(events.map((e) => JSON.stringify([e.id, e.type, e.tf, e.scale, e.time, e.data])).join('\n'));

export function countEventsByType(events: readonly EngineEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
