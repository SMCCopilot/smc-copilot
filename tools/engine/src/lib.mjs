// Shared helpers for the engine tools: load candles (file or database), run the engine, summarise.
import { readFileSync } from 'node:fs';
import { CandleSchema, parseStrategyConfig } from '@smc/contracts';
import { countEventsByType, createEngine, eventStreamHash, feed, sha1 } from '@smc/smc-engine';

/** Accepts a JSON array or newline-delimited JSON; every candle is validated against the contract. */
export function parseCandles(text) {
  const trimmed = text.trim();
  const rows = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l));
  return rows.map((r, i) => {
    const parsed = CandleSchema.safeParse(r);
    if (!parsed.success)
      throw new Error(`candle #${i} is invalid: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  });
}

export const loadCandleFile = (path) => parseCandles(readFileSync(path, 'utf8'));

export function loadConfig(path, versionId) {
  return parseStrategyConfig(versionId, JSON.parse(readFileSync(path, 'utf8')));
}

/** Runs the pure engine over candles in canonical close order. */
export function replay(candles, cfg) {
  if (candles.length === 0) throw new Error('no candles to replay');
  const instrumentId = candles[0].instrumentId;
  const mixed = candles.find((c) => c.instrumentId !== instrumentId);
  if (mixed) throw new Error(`mixed instruments: ${instrumentId} and ${mixed.instrumentId}`);
  const { state, events } = feed(createEngine(instrumentId), candles, cfg);
  return {
    state,
    events,
    hash: eventStreamHash(events),
    stateHash: sha1(JSON.stringify(state)),
    counts: countEventsByType(events),
  };
}

/** Closed candles of one instrument from the database (INCOMPLETE ones are skipped and counted). */
export async function loadCandlesFromDb(databaseUrl, canonical, { from, to, tfs }) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      select c.tf, c.open_time, c.o, c.h, c.l, c.c, c.v, c.provider_id, c.status
        from candles c join instruments i on i.id = c.instrument_id
       where i.canonical = ${canonical}
         and c.tf = any(${tfs})
         and c.open_time >= ${from}::timestamptz and c.open_time < ${to}::timestamptz
       order by c.open_time, c.tf`;
    const candles = [];
    let skipped = 0;
    for (const r of rows) {
      if (r.status !== 'CLOSED') {
        skipped++;
        continue;
      }
      candles.push({
        instrumentId: canonical,
        tf: r.tf,
        openTime: new Date(r.open_time).getTime(),
        o: Number(r.o),
        h: Number(r.h),
        l: Number(r.l),
        c: Number(r.c),
        v: Number(r.v ?? 0),
        closed: true,
        providerId: r.provider_id,
      });
    }
    return { candles, skipped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
