import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  factsHash,
  generateNarrative,
  type LlmRouter,
  NARRATIVE_PROMPT_VERSION,
  type NarrativeContent,
  refSpaceOf,
  renderNarrative,
  templateNarrative,
} from '@smc/ai';
import { HistoricalStatSchema, type MarketFacts, type NarrativeResponse } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { shortId } from '@smc/smc-engine';
import { AnalysisService } from '../analysis/analysis.service.js';
import { ApiProblemError } from '../common/problem.js';
import { EVENT_BUS, LLM_ROUTER, SQL } from '../config/tokens.js';
import type { EventBus } from '../ingest/event-bus.js';
import { withAiContext } from './ai.context.js';
import { AiGateService } from './ai-gate.service.js';
import { ProviderConfigService } from './provider-config.service.js';

/** Minimum time between generations for one instrument (A05 section 9.2). */
export const MIN_INTERVAL_MS = 60_000;

/**
 * Shared narratives (A05 section 9.1): the text depends only on the facts and the prompt version, never on the user,
 * so one generation serves every session watching the instrument and cost scales with instruments, not users.
 * The template is always available instantly; a model-written version replaces it when ready.
 */
@Injectable()
export class NarrativeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Narrative');
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly lastRun = new Map<string, number>();
  private unsub: (() => void)[] = [];
  /** Counters for the admin spend view: how often the shared cache saved a call. */
  readonly stats = { cacheHits: 0, generated: 0, templates: 0, skippedInterval: 0 };

  /** Realtime hook: a narrative for this instrument is ready to push to the sessions watching it. */
  onReady: ((instrumentId: string, n: NarrativeResponse) => void) | null = null;
  /** Realtime hook: are any sessions watching this instrument? No watcher, no generation. */
  hasWatchers: ((instrumentId: string) => boolean) | null = null;

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    private readonly analysis: AnalysisService,
    private readonly gate: AiGateService,
    private readonly providers: ProviderConfigService,
    @Inject(LLM_ROUTER) private readonly router: LlmRouter,
    @Optional() @Inject(EVENT_BUS) private readonly bus: EventBus | null,
  ) {}

  onModuleInit(): void {
    if (!this.bus) return;
    this.unsub.push(
      this.bus.subscribe('engine.updated', async (e) => {
        if (e.events === 0 || !this.hasWatchers?.(e.instrumentId)) return;
        const n = await this.current(e.instrumentId).catch(() => null);
        if (n) this.onReady?.(e.instrumentId, n);
      }),
    );
  }
  onModuleDestroy(): void {
    for (const u of this.unsub) u();
  }

  private get db(): Sql {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sql;
  }

  /** The engine's facts with each live setup's stored base rate attached (only ever a sufficient cohort). */
  /** The engine's facts for one instrument with each live setup's stored base rate attached. */
  async factsFor(instrumentId: string) {
    const { facts, instrument, asOf } = await this.analysis.marketFacts(instrumentId);
    const rows = await this.db<{ setup_key: string; stats: unknown }[]>`
      select s.setup_key, p.plan->'stats' as stats
        from setups s
        left join lateral (select plan from trade_plans t where t.setup_id = s.id order by plan_version desc limit 1) p on true
       where s.instrument_id = ${instrumentId} and s.state in ('ARMED','TRIGGERED')`;
    const byId = new Map(rows.map((r) => [shortId('S', r.setup_key), r.stats] as const));
    const enriched: MarketFacts = {
      ...facts,
      setups: facts.setups.map((s) => {
        const parsed = HistoricalStatSchema.safeParse(byId.get(s.id));
        return { ...s, stats: parsed.success ? parsed.data : null };
      }),
    };
    return { facts: enriched, instrument, asOf };
  }

  private toResponse(
    instrumentId: string,
    asOf: number,
    source: 'LLM' | 'TEMPLATE',
    hash: string,
    content: NarrativeContent,
    generating: boolean,
  ): NarrativeResponse {
    return {
      instrumentId,
      asOf: new Date(asOf).toISOString(),
      source,
      aiGenerated: source === 'LLM',
      factsHash: hash,
      promptVersion: NARRATIVE_PROMPT_VERSION,
      generating,
      content,
    };
  }

  /** What to show now: the cached model text for these exact facts, else the template (and a refresh is started). */
  async current(instrumentId: string): Promise<NarrativeResponse> {
    const { facts, instrument, asOf } = await this.factsFor(instrumentId);
    const hash = factsHash(facts);
    const [hit] = await this.db<{ content: NarrativeContent }[]>`
      select content from narratives
       where instrument_id = ${instrumentId} and facts_hash = ${hash}
         and prompt_version = ${NARRATIVE_PROMPT_VERSION} and language = 'en'`;
    if (hit) {
      this.stats.cacheHits++;
      return this.toResponse(instrumentId, asOf, 'LLM', hash, hit.content, false);
    }
    const space = refSpaceOf(facts, instrument.pricePrecision);
    const template = renderNarrative(templateNarrative(facts), facts, space);
    const canGenerate = await this.canGenerate();
    if (canGenerate)
      this.startGeneration(instrumentId, facts, instrument.pricePrecision, hash, asOf);
    this.stats.templates++;
    return this.toResponse(instrumentId, asOf, 'TEMPLATE', hash, template, canGenerate);
  }

  private async canGenerate(): Promise<boolean> {
    if (!(await this.providers.anyReady())) return false;
    const v = await this.gate.check(['AI']);
    return v.allowed;
  }

  private startGeneration(
    instrumentId: string,
    facts: MarketFacts,
    precision: number,
    hash: string,
    asOf: number,
  ): void {
    const key = `${instrumentId}:${hash}`;
    if (this.inflight.has(key)) return;
    const last = this.lastRun.get(instrumentId) ?? 0;
    if (Date.now() - last < MIN_INTERVAL_MS) {
      this.stats.skippedInterval++;
      return;
    }
    this.lastRun.set(instrumentId, Date.now());
    const work = (async () => {
      const r = await withAiContext(
        { promptVersion: NARRATIVE_PROMPT_VERSION, factsHash: hash },
        () => generateNarrative(this.router, facts, precision),
      );
      this.stats.generated++;
      if (r.source !== 'LLM') return;
      await this.db`
        insert into narratives (instrument_id, facts_hash, prompt_version, language, source, model, content)
        values (${instrumentId}, ${hash}, ${NARRATIVE_PROMPT_VERSION}, 'en', 'LLM', ${r.calls.at(-1)?.model ?? null}, ${this.db.json(r.content as never)})
        on conflict (instrument_id, facts_hash, prompt_version, language) do nothing`;
      this.onReady?.(
        instrumentId,
        this.toResponse(instrumentId, asOf, 'LLM', hash, r.content, false),
      );
    })()
      .catch((e: unknown) => this.log.warn(`narrative generation failed: ${String(e)}`))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
  }

  /** Test and shutdown helper: resolves when no generation is running. */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }
}
