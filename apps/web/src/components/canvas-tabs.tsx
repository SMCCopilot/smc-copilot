'use client';
import type { AnalysisResponse } from '@smc/contracts';
import { TIMEFRAME_MS } from '@smc/contracts';
import { Info } from 'lucide-react';
import { useLive } from '@/lib/live';
import { useCohorts, useEngineEvents, useRejected } from '@/lib/market';
import { formatPrice } from '@/lib/overlays';
import { useInstruments } from '@/lib/queries';
import { useSelection } from '@/lib/sessions';
import { useUi } from '@/lib/ui';
import { CONDITION, directionLabel, percent, reasonText, SCENARIO_KIND } from '@/lib/wording';

type Setup = NonNullable<AnalysisResponse['setups']>[number];

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted">{children}</p>
);
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <dt className="text-muted">{k}</dt>
    <dd className="num text-right">{v}</dd>
  </div>
);
const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-3 rounded-card border border-line bg-s2 p-3">
    <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
    {children}
  </section>
);
export const GradeChip = ({ grade }: { grade: string | null }) =>
  grade ? (
    <span
      className="rounded-full bg-grade-bg px-2 py-0.5 text-xs font-medium text-grade"
      title="Setup grade"
    >
      Grade {grade}
    </span>
  ) : null;

function usePrecision(): number {
  const sel = useSelection();
  const inst = useInstruments(false);
  return inst.data?.items.find((i) => i.id === sel.instrumentId)?.pricePrecision ?? 2;
}

export function SetupPicker({ setups, current }: { setups: Setup[]; current: Setup | null }) {
  const choose = useUi((s) => s.chooseSetup);
  if (setups.length < 2) return null;
  return (
    <div className="mb-3">
      <label htmlFor="setup" className="sr-only">
        Scenario
      </label>
      <select
        id="setup"
        value={current?.id ?? ''}
        onChange={(e) => choose(e.target.value)}
        className="w-full rounded-ctl border border-line bg-s3 px-2 py-1.5"
      >
        {setups.map((s) => (
          <option key={s.id} value={s.id}>
            {directionLabel(s.direction)} · {s.template} · {s.entryTf}
          </option>
        ))}
      </select>
    </div>
  );
}

export function PlanTab({ setup }: { setup: Setup | null }) {
  const p = usePrecision();
  const f = (n: number) => formatPrice(n, p);
  const plan = setup?.plan;
  if (!setup || !plan) {
    return (
      <Empty>
        No live scenario right now. Entry, stop, targets and invalidation appear here when the
        analysis has one.
      </Empty>
    );
  }
  const scen = (label: string, s: typeof plan.scenarios.primary) => (
    <Row
      k={label}
      v={
        <span>
          {SCENARIO_KIND[s.kind] ?? s.kind}: {CONDITION[s.condition.type] ?? s.condition.type}{' '}
          {f(s.condition.level)}
          {s.next ? `, next ${f(s.next.price)}` : ''}
        </span>
      }
    />
  );
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{directionLabel(setup.direction)}</h2>
        <GradeChip grade={setup.grade} />
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          {setup.template}
        </span>
        <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          {setup.state.toLowerCase()}
        </span>
      </div>
      <Card title="Levels">
        <dl>
          <Row k="Entry zone" v={`${f(plan.entry.bottom)} – ${f(plan.entry.top)}`} />
          <Row k={`Reference (${plan.entry.basis})`} v={f(plan.entry.refPrice)} />
          <Row k={`Stop (${plan.stop.basis})`} v={f(plan.stop.price)} />
          {plan.targets.map((t) => (
            <Row
              key={t.id}
              k={`${t.label} · reward to risk`}
              v={`${f(t.price)} · ${t.rr.toFixed(2)}R`}
            />
          ))}
          <Row k="Invalidation" v={f(plan.invalidation.level)} />
        </dl>
        <p className="mt-1 text-xs text-muted">
          Invalidation rule: {plan.invalidation.rule.replaceAll('_', ' ').toLowerCase()}
        </p>
      </Card>
      <Card title="Scenarios">
        <dl>
          {scen('Primary', plan.scenarios.primary)}
          {scen('Alternate', plan.scenarios.alternate)}
        </dl>
      </Card>
      <Card title="Costs assumed">
        <dl>
          <Row k="Spread" v={f(plan.assumptions.spread)} />
          <Row k="Slippage" v={f(plan.assumptions.slippage)} />
          <Row k="Fee" v={`${plan.assumptions.feeBps} bps`} />
          <Row
            k="Net R after fees"
            v={<span className="text-muted">not supplied by the API yet</span>}
          />
        </dl>
      </Card>
      {plan.risk && (
        <Card title="Size from your risk profile">
          <dl>
            {plan.risk.units !== null && <Row k="Units" v={plan.risk.units} />}
            {plan.risk.riskAmount !== null && <Row k="Risk amount" v={plan.risk.riskAmount} />}
            {plan.risk.notional !== null && <Row k="Notional" v={plan.risk.notional} />}
            {plan.risk.liquidationPrice !== null && (
              <Row k="Approx. liquidation" v={f(plan.risk.liquidationPrice)} />
            )}
          </dl>
          {plan.risk.warnings.length > 0 && (
            <p className="mt-1 text-xs text-warn">
              {plan.risk.warnings.map((w) => w.replaceAll('_', ' ').toLowerCase()).join(' · ')}
            </p>
          )}
        </Card>
      )}
      {plan.warnings.length > 0 && <p className="text-xs text-warn">{plan.warnings.join(' · ')}</p>}
    </div>
  );
}

export function EvidenceTab({
  setup,
  analysis,
}: {
  setup: Setup | null;
  analysis: AnalysisResponse | undefined;
}) {
  const sel = useSelection();
  const rejected = useRejected(sel.instrumentId);
  const breaks = analysis?.structure?.breaks.slice(-5).reverse() ?? [];
  return (
    <div>
      <Card title="Why this scenario">
        {setup ? (
          <>
            {setup.components.length > 0 ? (
              <ul className="list-inside list-disc">
                {setup.components.map((c) => (
                  <li key={`${c.kind}-${c.id}`}>{c.label}</li>
                ))}
              </ul>
            ) : (
              <Empty>No components listed.</Empty>
            )}
            {setup.reasonCodes.length > 0 && (
              <p className="mt-2 text-muted">{setup.reasonCodes.map(reasonText).join(' · ')}</p>
            )}
          </>
        ) : (
          <Empty>No live scenario.</Empty>
        )}
      </Card>
      <Card title="Structure events">
        {breaks.length ? (
          <ul>
            {breaks.map((b) => (
              <li key={b.id} className="flex justify-between gap-2 py-0.5">
                <span>
                  {b.type.replaceAll('_', ' ')} ({b.scale})
                </span>
                <time className="num text-muted" dateTime={b.time}>
                  {new Date(b.time).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>None yet.</Empty>
        )}
      </Card>
      <Card title="Why not (recently rejected)">
        {rejected.data?.length ? (
          <ul className="space-y-2">
            {rejected.data.map((r) => (
              <li key={r.id}>
                <span className="font-medium">
                  {directionLabel(r.direction)} · {r.template}
                </span>
                <p className="text-muted">
                  {r.reasonCodes.map(reasonText).join(' · ') || 'No reason recorded'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{rejected.isPending ? 'Loading…' : 'Nothing rejected recently.'}</Empty>
        )}
      </Card>
    </div>
  );
}

export function ChangesTab({ analysis }: { analysis: AnalysisResponse | undefined }) {
  const sel = useSelection();
  const events = useEngineEvents(sel.instrumentId, sel.tf);
  const live = useLive((s) => s.changes);
  const cutoff = analysis
    ? new Date(analysis.asOf).getTime() - TIMEFRAME_MS[sel.tf]
    : Number.POSITIVE_INFINITY;
  const items = [...(events.data ?? [])].reverse().slice(0, 30);
  return (
    <div>
      {live.length > 0 && (
        <Card title="This session">
          <ul>
            {live.map((c) => (
              <li key={c.at} className="py-0.5">
                {c.text}{' '}
                <time className="num text-muted">{new Date(c.at).toLocaleTimeString()}</time>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Engine events">
        {items.length ? (
          <ul>
            {items.map((e) => {
              const fresh = new Date(e.time).getTime() >= cutoff;
              return (
                <li key={e.id} className="flex items-baseline justify-between gap-2 py-0.5">
                  <span>
                    {fresh && (
                      <span className="mr-1.5 rounded-full accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                        new
                      </span>
                    )}
                    {e.type.replaceAll('_', ' ').toLowerCase()} · {e.tf}
                    {e.scale ? ` (${e.scale})` : ''}
                  </span>
                  <time className="num text-muted" dateTime={e.time}>
                    {new Date(e.time).toLocaleTimeString()}
                  </time>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{events.isPending ? 'Loading…' : 'No events yet.'}</Empty>
        )}
      </Card>
    </div>
  );
}

export function StatsTab({ setup }: { setup: Setup | null }) {
  const cohorts = useCohorts();
  const h = setup?.historical;
  return (
    <div>
      <p className="mb-3 flex gap-2 rounded-card border border-line bg-s2 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <span>
          <strong>No proven edge yet.</strong> Rules-based scenarios are shown for study. Past
          frequencies are not forecasts.
        </span>
      </p>
      <Card title="This scenario">
        {h ? (
          <dl>
            <Row
              k="Base rate"
              v={`${percent(h.rate)} (95% ${percent(h.ci95[0])} to ${percent(h.ci95[1])})`}
            />
            <Row k="Sample size" v={`n = ${h.n}`} />
            <Row k="Source" v={h.source === 'BACKTEST' ? 'Backtest' : 'Live shadow'} />
          </dl>
        ) : (
          <Empty>Not enough history.</Empty>
        )}
      </Card>
      <Card title="Cohorts with enough history">
        {cohorts.data?.filter((c) => c.sufficient && c.rate !== null && c.n >= 30).length ? (
          <ul className="space-y-1">
            {cohorts.data
              .filter((c) => c.sufficient && c.rate !== null && c.n >= 30)
              .map((c) => (
                <li
                  key={`${c.template}${c.grade}${c.direction}${c.source}`}
                  className="flex justify-between gap-2"
                >
                  <span>
                    {c.template} · grade {c.grade}
                    {c.direction ? ` · ${c.direction.toLowerCase()}` : ''}
                  </span>
                  <span className="num">
                    {percent(c.rate as number)} · n = {c.n}
                  </span>
                </li>
              ))}
          </ul>
        ) : (
          <Empty>{cohorts.isPending ? 'Loading…' : 'Not enough history in any cohort yet.'}</Empty>
        )}
      </Card>
    </div>
  );
}
