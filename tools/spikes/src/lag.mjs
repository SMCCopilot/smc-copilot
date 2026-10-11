// Pure helpers for spike S2: find closed candles in raw venue frames and summarise receive lag.

/**
 * @param {'binance' | 'bybit'} venue
 * @param {string} text raw WebSocket frame
 * @returns {{ closeTimeMs: number }[]} one entry per candle the frame reports as closed
 */
export function closedCandles(venue, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return [];
  }
  if (venue === 'binance') {
    const k = (msg?.data ?? msg)?.k;
    return k?.x === true && Number.isFinite(k.T) ? [{ closeTimeMs: k.T }] : [];
  }
  if (Array.isArray(msg?.data)) {
    return msg.data
      .filter((c) => c?.confirm === true && Number.isFinite(c.end))
      .map((c) => ({ closeTimeMs: c.end }));
  }
  return [];
}

/** Nearest-rank percentile; null when there is no data. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function summarizeLags(lags) {
  return {
    n: lags.length,
    p50: percentile(lags, 50),
    p95: percentile(lags, 95),
    max: lags.length === 0 ? null : Math.max(...lags),
  };
}
