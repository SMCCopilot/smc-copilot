import { confidenceLabel, toHistoricalStat } from '@smc/analytics';
import type { HistoricalStat, TradePlan } from '@smc/contracts';
import type { Sql } from '@smc/db';
import type { EngineEvent } from '@smc/smc-engine';

type Tx = Sql;

export const SETUP_EVENT_TYPES = new Set([
  'SETUP_CANDIDATE',
  'SETUP_REJECTED',
  'SETUP_ARMED',
  'PLAN_READY',
  'SETUP_TRIGGERED',
  'SETUP_EXPIRED',
  'SETUP_INVALIDATED',
  'SETUP_RESOLVED',
]);

const text = (v: unknown): string => String(v);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const date = (v: unknown): Date | null => (typeof v === 'number' ? new Date(v) : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

interface CohortRow {
  direction: 'LONG' | 'SHORT' | null;
  source: 'LIVE_SHADOW' | 'BACKTEST';
  window_from: Date;
  window_to: Date;
  n: number;
  wins: number;
  ci_low: string;
  ci_high: string;
  sufficient: boolean;
  status: string;
}

/**
 * The base rate that goes with a plan: only a cohort with n >= 30 produces a number, preferring live shadow
 * results over a backtest, and a cohort under review shows nothing. Otherwise: no stat and a reason.
 */
async function cohortFor(
  tx: Tx,
  strategyId: string,
  template: string,
  grade: string,
  direction: 'LONG' | 'SHORT',
): Promise<{ stat: HistoricalStat | null; confidence: 'LOW' | 'MEDIUM' | 'HIGH' }> {
  const rows = await tx<CohortRow[]>`
    select direction, source, window_from, window_to, n, wins, ci_low, ci_high, sufficient, status
      from cohort_stats
     where strategy_version_id = ${strategyId} and asset_class = 'CRYPTO' and segment = 'ALL'
       and template = ${template} and grade = ${grade}
       and (direction = ${direction} or direction is null)`;
  const usable = rows.filter((r) => r.sufficient && r.status === 'ACTIVE');
  const rank = (r: CohortRow): number =>
    (r.source === 'LIVE_SHADOW' ? 0 : 2) + (r.direction === direction ? 0 : 1);
  const best = [...usable].sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return { stat: null, confidence: 'LOW' };
  const ci: [number, number] = [Number(best.ci_low), Number(best.ci_high)];
  const { stat } = toHistoricalStat(
    { n: best.n, wins: best.wins, ci95: ci, sufficient: true },
    best.source,
    {
      from: best.window_from.toISOString(),
      to: best.window_to.toISOString(),
    },
  );
  const live = rows.find((r) => r.source === 'LIVE_SHADOW' && r.sufficient);
  return {
    stat,
    confidence: stat
      ? confidenceLabel({
          sufficient: true,
          ciWidth: ci[1] - ci[0],
          dataClean: true,
          liveShadowN: live?.n ?? 0,
        })
      : 'LOW',
  };
}

export interface ApplyResult {
  setups: number;
}

/**
 * Projects newly stored engine setup events into the setup tables, in event order. `events` must be the events
 * that were NEWLY inserted: replays of already stored events never reach here, so transitions are not duplicated.
 */
export async function applySetupEvents(
  tx: Tx,
  instrumentId: string,
  strategyId: string,
  events: readonly EngineEvent[],
): Promise<ApplyResult> {
  let touched = 0;
  for (const e of events) {
    if (!SETUP_EVENT_TYPES.has(e.type)) continue;
    const d = e.data;
    const key = text(d.setupKey);
    const at = new Date(e.time);
    touched++;
    const transition = async (to: string, reasons: string[]): Promise<void> => {
      await tx`
        insert into setup_transitions (setup_id, from_state, to_state, at_candle, reason_codes)
        select id, state, ${to}, ${at}, ${reasons}::text[] from setups
         where strategy_version_id = ${strategyId} and setup_key = ${key}`;
    };

    switch (e.type) {
      case 'SETUP_CANDIDATE':
        await tx`
          insert into setups (setup_key, strategy_version_id, instrument_id, template, direction, entry_tf, bias_tf,
                              state, components, poi, invalidation, created_at)
          values (${key}, ${strategyId}, ${instrumentId}, ${text(d.template)}, ${text(d.direction)}, ${text(d.entryTf)},
                  ${text(d.biasTf)}, 'CANDIDATE', ${tx.json(d.components as never)}, ${tx.json((d.poi ?? {}) as never)},
                  ${tx.json((d.invalidation ?? {}) as never)}, ${at})
          on conflict (strategy_version_id, setup_key) do nothing`;
        await tx`
          insert into setup_transitions (setup_id, from_state, to_state, at_candle, reason_codes)
          select id, null, 'CANDIDATE', ${at}, '{}'::text[] from setups
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        break;
      case 'SETUP_REJECTED': {
        const reasons = arr(d.reasonCodes);
        await transition('REJECTED', reasons);
        await tx`
          update setups set state = 'REJECTED', reason_codes = ${reasons}::text[], closed_at = ${at}
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        break;
      }
      case 'SETUP_ARMED':
        await transition('ARMED', []);
        await tx`
          update setups set state = 'ARMED', grade = ${text(d.grade)}, score = ${num(d.score)},
                 features = ${tx.json(d.features as never)}, armed_at = ${at}
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        break;
      case 'PLAN_READY': {
        const plan = d.plan as unknown as TradePlan;
        const [s] = await tx<{ template: string; grade: string; direction: 'LONG' | 'SHORT' }[]>`
          select template, grade, direction from setups
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        let stored: TradePlan = plan;
        if (s) {
          const c = await cohortFor(tx, strategyId, s.template, s.grade, s.direction);
          stored = {
            ...plan,
            stats: c.stat,
            statsReason: c.stat ? null : 'INSUFFICIENT_HISTORY',
            confidence: c.confidence,
          };
        }
        await tx`
          insert into trade_plans (setup_id, plan_version, plan, plan_hash)
          select id, 1, ${tx.json(stored as never)}, ${text(d.planHash)} from setups
           where strategy_version_id = ${strategyId} and setup_key = ${key}
          on conflict (setup_id, plan_version) do nothing`;
        break;
      }
      case 'SETUP_TRIGGERED':
        await transition('TRIGGERED', []);
        await tx`
          update setups set state = 'TRIGGERED', triggered_at = ${at}
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        break;
      case 'SETUP_EXPIRED':
      case 'SETUP_INVALIDATED': {
        const to = e.type === 'SETUP_EXPIRED' ? 'EXPIRED' : 'INVALIDATED';
        const reasons = arr(d.reasonCodes);
        await transition(to, reasons);
        await tx`
          update setups set state = ${to}, reason_codes = ${reasons}::text[], closed_at = ${at}
           where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        break;
      }
      case 'SETUP_RESOLVED': {
        await tx`
          insert into setup_outcomes (setup_id, outcome_rules_version, outcome, filled, fill_time, fill_price,
                 resolution_time, r_tp1, fees_r, realized_r, mfe_r, mae_r, bars_to_resolution, ambiguous_intrabar)
          select id, ${text(d.rulesVersion)}, ${text(d.outcome)}, ${d.filled === true}, ${date(d.fillTime)},
                 ${num(d.fillPrice)}, ${date(d.resolutionTime)}, ${num(d.rTp1)}, ${num(d.feesR)}, ${num(d.realizedR)},
                 ${num(d.mfeR)}, ${num(d.maeR)}, ${num(d.barsToResolution)}, ${d.ambiguousIntrabar === true}
            from setups where strategy_version_id = ${strategyId} and setup_key = ${key}
          on conflict (setup_id) do nothing`;
        if (d.outcome === 'TP1_FIRST' || d.outcome === 'SL_FIRST') {
          await transition('RESOLVED', []);
          await tx`
            update setups set state = 'RESOLVED', closed_at = ${at}
             where strategy_version_id = ${strategyId} and setup_key = ${key}`;
        }
        break;
      }
    }
  }
  return { setups: touched };
}

/**
 * A rebuild changed or removed setup events. Setups already RESOLVED are never rewritten; they are flagged
 * `data_revised`. A setup that still has no outcome and whose candidate no longer exists is closed as INVALIDATED.
 */
export async function flagRevisedSetups(
  tx: Tx,
  strategyId: string,
  revisedKeys: readonly string[],
  retractedCandidateKeys: readonly string[],
  at: Date,
): Promise<void> {
  if (revisedKeys.length > 0 || retractedCandidateKeys.length > 0) {
    const all = [...new Set([...revisedKeys, ...retractedCandidateKeys])];
    await tx`
      update setups set data_revised = true
       where strategy_version_id = ${strategyId} and setup_key = any(${all}::text[])`;
    await tx`
      update setup_outcomes set data_revised = true
       where setup_id in (select id from setups
                           where strategy_version_id = ${strategyId} and setup_key = any(${all}::text[]))`;
  }
  if (retractedCandidateKeys.length > 0) {
    await tx`
      insert into setup_transitions (setup_id, from_state, to_state, at_candle, reason_codes)
      select id, state, 'INVALIDATED', ${at}, '{DATA_REVISED}'::text[] from setups
       where strategy_version_id = ${strategyId} and setup_key = any(${retractedCandidateKeys}::text[])
         and state in ('CANDIDATE', 'ARMED', 'TRIGGERED')`;
    await tx`
      update setups set state = 'INVALIDATED', reason_codes = '{DATA_REVISED}'::text[], closed_at = ${at}
       where strategy_version_id = ${strategyId} and setup_key = any(${retractedCandidateKeys}::text[])
         and state in ('CANDIDATE', 'ARMED', 'TRIGGERED')`;
  }
}
