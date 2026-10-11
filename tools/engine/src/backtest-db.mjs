// Stores a backtest run (and the BACKTEST cohort rows the plan lookup uses) in the database.
import { summarizeCohorts } from '@smc/analytics';

export async function storeRun({ url, series, results, range, criteria, outcomes }) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const [strategy] = await sql`
      select id from strategy_versions where name = 'smc-core' and status = 'ACTIVE' order by version desc limit 1`;
    if (!strategy) throw new Error('no ACTIVE smc-core strategy version');
    const ids =
      await sql`select id from instruments where canonical = any(${series.map((s) => s.id)}::text[])`;
    await sql`
      insert into backtest_runs (strategy_version_id, instrument_ids, data_from, data_to, split, trials_count, criteria, results, status)
      values (${strategy.id}, ${ids.map((r) => r.id)}::uuid[], ${new Date(range.from)}, ${new Date(range.to)},
              ${sql.json(results.split)}, ${results.trialsCount}, ${sql.json(criteria)}, ${sql.json(results)}, 'DONE')`;
    for (const c of summarizeCohorts(outcomes)) {
      await sql`
        insert into cohort_stats (strategy_version_id, asset_class, template, grade, direction, segment, source,
                                  window_from, window_to, n, wins, rate, ci_low, ci_high, avg_r, median_mae_r,
                                  median_mfe_r, sufficient)
        values (${strategy.id}, 'CRYPTO', ${c.template}, ${c.grade}, ${c.direction}, 'ALL', 'BACKTEST',
                ${new Date(range.from)}, ${new Date(range.to)}, ${c.n}, ${c.wins}, ${c.rate}, ${c.ci95[0]}, ${c.ci95[1]},
                ${c.avgR === null ? null : Number(c.avgR.toFixed(3))}, ${c.medianMaeR === null ? null : Number(c.medianMaeR.toFixed(3))},
                ${c.medianMfeR === null ? null : Number(c.medianMfeR.toFixed(3))}, ${c.sufficient})
        on conflict (strategy_version_id, asset_class, segment, template, grade, direction, source)
        do update set window_from = excluded.window_from, window_to = excluded.window_to, n = excluded.n,
                      wins = excluded.wins, rate = excluded.rate, ci_low = excluded.ci_low, ci_high = excluded.ci_high,
                      avg_r = excluded.avg_r, median_mae_r = excluded.median_mae_r, median_mfe_r = excluded.median_mfe_r,
                      sufficient = excluded.sufficient, computed_at = now()`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
