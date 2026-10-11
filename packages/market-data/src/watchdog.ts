/** Thresholds from A03 section 6.1 (liquid core pairs). */
export const WATCHDOG = {
  /** No message at all for this long on a liquid pair: DEGRADED and start a REST poll. */
  silenceMs: 15_000,
  /** A closed 1m candle is overdue this long after its close time: STALE. */
  overdueMs: 20_000,
  /** Consecutive flat candles on a liquid pair count as stale. */
  flatStreak: 3,
} as const;

const MINUTE = 60_000;

export type FeedState = 'OK' | 'DEGRADED' | 'STALE';

export interface FeedObservation {
  readonly nowMs: number;
  /** Last frame of any kind from the venue for this instrument. */
  readonly lastMessageAtMs: number | null;
  /** Open time of the last closed 1m candle accepted. */
  readonly lastClosedOpenMs: number | null;
  readonly flatStreak: number;
  /** A cross-check divergence or other data-quality incident is open. */
  readonly openIncident: boolean;
  /** The venue connection is currently down. */
  readonly disconnected: boolean;
}

export interface FeedStatusResult {
  readonly state: FeedState;
  readonly reasons: readonly string[];
}

/**
 * Pure status function. STALE means "do not publish new setups or plans" (A03 section 6.1); DEGRADED means
 * data is flowing but not trusted without a caveat. Stale data never produces fresh advice.
 */
export function feedStatus(o: FeedObservation): FeedStatusResult {
  const stale: string[] = [];
  const degraded: string[] = [];

  if (o.lastClosedOpenMs === null) {
    stale.push('NO_CANDLE_YET');
  } else {
    // The candle after `lastClosedOpenMs` opens one minute later and closes one minute after that.
    const nextCloseAt = o.lastClosedOpenMs + 2 * MINUTE;
    if (o.nowMs > nextCloseAt + WATCHDOG.overdueMs) stale.push('CANDLE_OVERDUE');
  }
  if (o.flatStreak >= WATCHDOG.flatStreak) stale.push('FLAT_CANDLES');

  if (o.disconnected) degraded.push('DISCONNECTED');
  if (o.lastMessageAtMs !== null && o.nowMs - o.lastMessageAtMs > WATCHDOG.silenceMs)
    degraded.push('SILENT');
  if (o.openIncident) degraded.push('DATA_QUALITY_INCIDENT');

  if (stale.length > 0) return { state: 'STALE', reasons: [...stale, ...degraded] };
  if (degraded.length > 0) return { state: 'DEGRADED', reasons: degraded };
  return { state: 'OK', reasons: [] };
}
