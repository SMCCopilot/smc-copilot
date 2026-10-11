import {
  type CalibrationReport,
  calibration,
  driftStatus,
  type OutcomeRow,
  summarizeCohorts,
} from '@smc/analytics';
import type { Sql } from '@smc/db';

interface OutcomeJoin {
  template: string;
  grade: string;
  direction: 'LONG' | 'SHORT';
  outcome: OutcomeRow['outcome'];
  filled: boolean;
  realized_r: string | null;
  mfe_r: string | null;
  mae_r: string | null;
  ambiguous_intrabar: boolean;
  created_at: Date;
  resolution_time: Date | null;
}

const asNumber = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * Nightly (here: scheduled) statistics jobs (A04 sections 8.4 and 13.4).
 * - Cohort stats: shadow outcomes of every ARMED setup, grouped by template, grade and direction. Only resolved
 *   trades enter the rate; outcomes flagged `data_revised` are left out so repaired data cannot move a base rate.
 * - Calibration: the rates that were actually displayed against what then happened.
 */
export class AnalyticsJobs {
  constructor(private readonly sql: Sql) {}

  /** Recomputes LIVE_SHADOW cohorts for a strategy version. Returns the number of cohort rows written. */
  async refreshCohorts(strategyId: string): Promise<number> {
    const rows = await this.sql<OutcomeJoin[]>`
      select s.template, s.grade, s.direction, o.outcome, o.filled, o.realized_r, o.mfe_r, o.mae_r,
             o.ambiguous_intrabar, s.created_at, o.resolution_time
        from setup_outcomes o join setups s on s.id = o.setup_id
       where s.strategy_version_id = ${strategyId} and s.grade is not null and not o.data_revised`;
    if (rows.length === 0) return 0;
    const summaries = summarizeCohorts(
      rows.map((r) => ({
        template: r.template,
        grade: r.grade,
        direction: r.direction,
        outcome: r.outcome,
        filled: r.filled,
        realizedR: asNumber(r.realized_r),
        mfeR: asNumber(r.mfe_r),
        maeR: asNumber(r.mae_r),
        ambiguousIntrabar: r.ambiguous_intrabar,
      })),
    );
    const from = new Date(Math.min(...rows.map((r) => r.created_at.getTime())));
    const to = new Date(
      Math.max(...rows.map((r) => (r.resolution_time ?? r.created_at).getTime())),
    );
    let written = 0;
    for (const c of summaries) {
      // A cohort whose live rate has drifted outside its backtest interval is held back until reviewed.
      const [bt] = await this.sql<{ ci_low: string; ci_high: string }[]>`
        select ci_low, ci_high from cohort_stats
         where strategy_version_id = ${strategyId} and asset_class = 'CRYPTO' and segment = 'ALL'
           and template = ${c.template} and grade = ${c.grade} and source = 'BACKTEST'
           and direction is not distinct from ${c.direction}`;
      const status =
        bt && c.sufficient
          ? driftStatus({ n: c.n, rate: c.rate }, [Number(bt.ci_low), Number(bt.ci_high)])
          : 'ACTIVE';
      await this.sql`
        insert into cohort_stats (strategy_version_id, asset_class, template, grade, direction, segment, source,
                                  window_from, window_to, n, wins, rate, ci_low, ci_high, avg_r, median_mae_r,
                                  median_mfe_r, sufficient, status)
        values (${strategyId}, 'CRYPTO', ${c.template}, ${c.grade}, ${c.direction}, 'ALL', 'LIVE_SHADOW',
                ${from}, ${to}, ${c.n}, ${c.wins}, ${c.rate}, ${c.ci95[0]}, ${c.ci95[1]},
                ${c.avgR === null ? null : Number(c.avgR.toFixed(3))},
                ${c.medianMaeR === null ? null : Number(c.medianMaeR.toFixed(3))},
                ${c.medianMfeR === null ? null : Number(c.medianMfeR.toFixed(3))},
                ${c.sufficient}, ${status})
        on conflict (strategy_version_id, asset_class, segment, template, grade, direction, source)
        do update set window_from = excluded.window_from, window_to = excluded.window_to, n = excluded.n,
                      wins = excluded.wins, rate = excluded.rate, ci_low = excluded.ci_low,
                      ci_high = excluded.ci_high, avg_r = excluded.avg_r,
                      median_mae_r = excluded.median_mae_r, median_mfe_r = excluded.median_mfe_r,
                      sufficient = excluded.sufficient, computed_at = now(),
                      status = case when cohort_stats.status = 'UNDER_REVIEW' then 'UNDER_REVIEW'
                                    else excluded.status end`;
      written++;
    }
    return written;
  }

  /** Reliability table, Brier score and log loss of the displayed rates against resolved outcomes. */
  async calibrate(strategyId: string): Promise<CalibrationReport | null> {
    const rows = await this.sql<{ rate: string; outcome: string }[]>`
      select d.rate, o.outcome
        from setup_displays d
        join setups s on s.id = d.setup_id
        join setup_outcomes o on o.setup_id = s.id
       where s.strategy_version_id = ${strategyId} and o.outcome in ('TP1_FIRST', 'SL_FIRST')`;
    if (rows.length === 0) return null;
    const report = calibration(
      rows.map((r) => ({ predicted: Number(r.rate), hit: r.outcome === 'TP1_FIRST' })),
    );
    await this.sql`
      insert into calibration_reports (strategy_version_id, report)
      values (${strategyId}, ${this.sql.json(report as never)})`;
    return report;
  }
}
