import { Inject, Injectable } from '@nestjs/common';
import {
  EXPLAIN_PROMPT_VERSION,
  type ExplainContent,
  fitAxis,
  generateExplain,
  type ImageRead,
  type LlmImage,
  type LlmResult,
  type LlmRouter,
  parsePriceText,
  priceMatch,
  readImage,
  visualLevels,
} from '@smc/ai';
import type { Env } from '@smc/config';
import type { MarketFacts, OcrContext, Timeframe } from '@smc/contracts';
import type { Sql } from '@smc/db';
import sharp, { type Metadata } from 'sharp';
import { ApiProblemError } from '../common/problem.js';
import { assertNoSecret } from '../common/secrets.js';
import { ENV, LLM_ROUTER, SQL } from '../config/tokens.js';
import { ContextService, cleanSymbolText, parseTimeframeText } from '../context/context.service.js';
import { withAiContext } from './ai.context.js';
import { AiAllowanceService } from './ai-allowance.service.js';
import { AiGateService } from './ai-gate.service.js';
import { NarrativeService } from './narrative.service.js';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 2400;
const READ_SIDE = 1600;
const MIN_SIDE = 160;

export interface ExplainCaller {
  sessionId: string | null;
  userId: string;
  workspaceId: string;
  /** The session's current instrument, used when nothing else identifies the chart. */
  sessionInstrumentId: string | null;
  ip: string;
  deviceId?: string | undefined;
}
export interface ExplainRequest {
  source: 'SHARE' | 'UPLOAD';
  /** In memory only; zeroed when done. Null for the socket path, which carries OCR text but no pixels. */
  image: Buffer | null;
  ocr?: OcrContext | undefined;
  instrumentHint?: string | undefined;
  tfHint?: Timeframe | undefined;
  question?: string | undefined;
  inputMode?: 'TEXT' | 'VOICE';
}
export interface ExplainSink {
  stage(stage: 'resolving' | 'reading' | 'writing'): void;
  chunk(delta: string): void;
  done(e: {
    explainId: string;
    mode: 'GROUNDED' | 'APPROXIMATE';
    aiGenerated: boolean;
    warnings: string[];
    content: ExplainContent;
  }): void;
}

interface Prepared {
  llm: LlmImage;
  bytes: number;
  width: number;
  height: number;
}

/**
 * Validates and normalises an image entirely in memory (sharp): format and size caps, then a resize and re-encode that
 * also strips all metadata. Nothing is written to disk. The result is base64 for one model request and is not kept.
 */
export async function prepareImage(buf: Buffer): Promise<Prepared> {
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    throw new ApiProblemError('IMAGE_TOO_LARGE', 'That image is too large. The limit is 6 MB.');
  }
  let meta: Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
  } catch {
    throw new ApiProblemError('UNSUPPORTED_IMAGE', 'That file could not be read as an image.');
  }
  if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new ApiProblemError('UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP images are supported.');
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) {
    throw new ApiProblemError(
      'IMAGE_TOO_LARGE',
      `That image is too large. The longest side may be ${MAX_IMAGE_SIDE} pixels.`,
    );
  }
  if (w < MIN_SIDE || h < MIN_SIDE) {
    throw new ApiProblemError('NOT_A_CHART', 'That image is too small to be a chart.');
  }
  const out = await sharp(buf)
    .rotate()
    .resize({ width: READ_SIDE, height: READ_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return {
    llm: { mime: 'image/jpeg', base64: out.data.toString('base64') },
    bytes: buf.length,
    width: w,
    height: h,
  };
}

/** Plain-text rendering of an explanation, streamed in pieces for progressive display. */
export function renderPlain(c: ExplainContent): string {
  const lines = [
    c.headline,
    c.what_you_are_looking_at,
    `Structure: ${c.structure}`,
    c.key_levels.length > 0
      ? `Key levels: ${c.key_levels.map((k) => `${k.ref} (${k.why})`).join('; ')}`
      : '',
    `Liquidity: ${c.liquidity}`,
    ...c.scenarios.map(
      (s) => `${s.kind === 'PRIMARY' ? 'Primary' : 'Alternate'} scenario: ${s.if_then}`,
    ),
    c.what_to_watch.length > 0 ? `Watch: ${c.what_to_watch.join('; ')}` : '',
    c.user_markings_note ? `Your markings: ${c.user_markings_note}` : '',
    ...c.history.map((h) => h.text),
    `Caveats: ${c.caveats.join(' ')}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Explain this chart end to end (A05 section 8.3). The picture lives in memory for the length of the request: it is read
 * once by the reader model for descriptors, never given to the writer, and then discarded. Only metadata and the text
 * answer are stored (invariant 2).
 */
@Injectable()
export class ExplainService {
  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    @Inject(ENV) private readonly env: Env,
    @Inject(LLM_ROUTER) private readonly router: LlmRouter,
    private readonly gate: AiGateService,
    private readonly allowance: AiAllowanceService,
    private readonly context: ContextService,
    private readonly narratives: NarrativeService,
  ) {}

  private get db(): Sql {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sql;
  }

  private async dailyCap(workspaceId: string): Promise<void> {
    const [row] = await this.db<{ used: number; lim: string | null }[]>`
      select (select count(*)::int from explain_requests
               where workspace_id = ${workspaceId} and created_at >= date_trunc('day', now() at time zone 'utc')
                 and outcome in ('OK','OK_APPROXIMATE')) as used,
             (select limits->>'explain_per_day' from entitlements where workspace_id = ${workspaceId}) as lim`;
    const limit = row?.lim != null ? Number(row.lim) : 3;
    if ((row?.used ?? 0) >= limit) {
      throw new ApiProblemError(
        'DAILY_LIMIT_REACHED',
        'You have used today’s chart explanations. They reset at midnight UTC.',
      );
    }
  }

  async run(c: ExplainCaller, r: ExplainRequest, sink: ExplainSink): Promise<void> {
    const started = Date.now();
    try {
      assertNoSecret(r.question);
      this.allowance.check(c, 'explain', 6, 200);
      const scopes = r.image
        ? (['AI', 'EXPLAIN', 'IMAGE_READ'] as const)
        : (['AI', 'EXPLAIN'] as const);
      await this.gate.require(scopes, c.workspaceId);
      await this.dailyCap(c.workspaceId);
      const prepared = r.image ? await prepareImage(r.image) : null;
      await withAiContext(
        {
          workspaceId: c.workspaceId,
          userId: c.userId,
          sessionId: c.sessionId,
          promptVersion: EXPLAIN_PROMPT_VERSION,
        },
        () => this.flow(c, r, prepared, sink, started),
      );
    } finally {
      // Hygiene: the original upload is wiped as soon as the request is over.
      r.image?.fill(0);
    }
  }

  private async flow(
    c: ExplainCaller,
    r: ExplainRequest,
    prepared: Prepared | null,
    sink: ExplainSink,
    started: number,
  ): Promise<void> {
    sink.stage('resolving');
    const calls: LlmResult[] = [];

    // The reader model looks at the picture once, when there is one.
    let read: ImageRead | null = null;
    if (prepared) {
      sink.stage('reading');
      const rr = await readImage(this.router, prepared.llm);
      calls.push(...rr.calls);
      read = rr.read;
      if (read?.unreadable_reason === 'NOT_A_CHART') {
        await this.record(c, r, prepared, {
          outcome: 'NOT_A_CHART',
          mode: 'APPROXIMATE',
          calls,
          started,
        });
        throw new ApiProblemError('NOT_A_CHART', 'That does not look like a price chart.');
      }
    }

    // Which market is it? Manual pick first, then the on-screen text, then the picture, then the session's own context.
    let resolvedBy: 'PICKER' | 'OCR' | 'VISION' | null = null;
    let instrument: { id: string; canonical: string; base: string; pricePrecision: number } | null =
      null;
    let tf: Timeframe | null = r.tfHint ?? null;
    if (r.instrumentHint) {
      instrument = await this.context.instrumentByCanonical(r.instrumentHint);
      resolvedBy = 'PICKER';
    }
    let shown: number | null = null;
    if (r.ocr) {
      const ev = await this.context.evaluate(r.ocr, c.userId);
      tf = tf ?? ev.tf;
      if (!instrument && ev.instrumentId && !ev.ambiguous && ev.feedMatch !== 'MISMATCH') {
        instrument = await this.context.instrumentByCanonical(ev.canonical as string);
        resolvedBy = 'OCR';
      }
      shown = r.ocr.derived?.lastPrice ?? null;
    }
    if (!instrument && read) {
      const text = cleanSymbolText(read.symbol_text ?? undefined);
      if (text && read.confidence.symbol >= 0.6) {
        const res = await this.context.evaluate(
          {
            capturedAt: 0,
            roi: { w: 1, h: 1 },
            texts: [{ kind: 'SYMBOL', text, conf: read.confidence.symbol, box: [0, 0, 0, 0] }],
            engine: { name: 'paddleocr-web', version: '0', backend: 'wasm', ms: 0 },
          },
          c.userId,
        );
        if (res.instrumentId && !res.ambiguous) {
          instrument = await this.context.instrumentByCanonical(res.canonical as string);
          resolvedBy = 'VISION';
        }
      }
    }
    if (!instrument && c.sessionInstrumentId) {
      const row = await this.db<
        { id: string }[]
      >`select id from instruments where id = ${c.sessionInstrumentId}`;
      if (row[0]) {
        const [i] = await this.db<
          { canonical: string }[]
        >`select canonical from instruments where id = ${c.sessionInstrumentId}`;
        instrument = await this.context.instrumentByCanonical(
          (i as { canonical: string }).canonical,
        );
        resolvedBy = 'PICKER';
      }
    }
    tf = tf ?? parseTimeframeText(read?.timeframe_text ?? undefined);
    shown = shown ?? parsePriceText(read?.last_price_text);

    // Does the picture agree with the feed? A screenshot of another market, or an old one, must not get live levels.
    let feedMatch: 'MATCH' | 'MISMATCH' | 'UNVERIFIED' = 'UNVERIFIED';
    let deltaPct: number | null = null;
    if (instrument && shown !== null) {
      const m = priceMatch(
        shown,
        await this.context.feedPriceOf(instrument.id),
        this.context.isCore(instrument.base),
      );
      feedMatch = m.match;
      deltaPct = m.deltaPct;
    }
    // A live capture of the instrument the user chose cannot be stale; an upload must positively match.
    const groundedOk =
      instrument !== null &&
      (r.source === 'SHARE' ? feedMatch !== 'MISMATCH' : feedMatch === 'MATCH');
    const warnings: string[] = [];
    if (instrument && feedMatch === 'MISMATCH')
      warnings.push(r.source === 'UPLOAD' ? 'STALE_IMAGE' : 'FEED_MISMATCH');
    if (!groundedOk) warnings.push('APPROX_MODE');

    let facts: MarketFacts | null = null;
    let precision = instrument?.pricePrecision ?? 2;
    let mode: 'GROUNDED' | 'APPROXIMATE' = groundedOk ? 'GROUNDED' : 'APPROXIMATE';
    if (groundedOk && instrument) {
      try {
        const f = await this.narratives.factsFor(instrument.id);
        facts = f.facts;
        precision = f.instrument.pricePrecision;
      } catch (e) {
        if (!(e instanceof ApiProblemError) || e.code !== 'ANALYSIS_UNAVAILABLE') throw e;
        mode = 'APPROXIMATE';
        warnings.push('APPROX_MODE');
      }
    }
    const fit = read ? fitAxis(read.axis_labels) : null;
    const visual =
      read && mode === 'APPROXIMATE' ? visualLevels(read, fit) : new Map<string, number>();

    sink.stage('writing');
    const result = await generateExplain(this.router, {
      mode,
      facts,
      precision,
      view: {
        venue: instrument ? (instrument.canonical.split(':')[0] ?? null) : null,
        symbol: instrument ? (instrument.canonical.split(':')[2] ?? null) : null,
        timeframe: tf,
        resolvedBy,
        feedMatch,
      },
      read,
      visual,
      question: r.question ? r.question.slice(0, 500) : null,
      staleImage: warnings.includes('STALE_IMAGE'),
    });
    calls.push(...result.calls);
    const content = result.content;
    for (let i = 0; i < renderPlain(content).length; i += 140) {
      sink.chunk(renderPlain(content).slice(i, i + 140));
    }
    const explainId = await this.record(c, r, prepared, {
      outcome: mode === 'GROUNDED' ? 'OK' : 'OK_APPROXIMATE',
      mode,
      calls,
      started,
      instrumentId: instrument?.id ?? null,
      tf,
      resolvedBy,
      feedMatch,
      deltaPct,
      symbolText: cleanSymbolText(read?.symbol_text ?? r.ocr?.derived?.symbolText) ?? null,
      factsHash: result.factsHash,
      output: content,
    });
    sink.done({
      explainId,
      mode,
      aiGenerated: result.source === 'LLM',
      warnings: [...new Set(warnings)],
      content,
    });
  }

  /** Stores metadata and the text answer. Never the image: there is no column for it. */
  private async record(
    c: ExplainCaller,
    r: ExplainRequest,
    prepared: Prepared | null,
    o: {
      outcome: string;
      mode: 'GROUNDED' | 'APPROXIMATE';
      calls: LlmResult[];
      started: number;
      instrumentId?: string | null;
      tf?: Timeframe | null;
      resolvedBy?: string | null;
      feedMatch?: string;
      deltaPct?: number | null;
      symbolText?: string | null;
      factsHash?: string | null;
      output?: ExplainContent;
    },
  ): Promise<string> {
    const cost = o.calls.reduce((s, x) => s + x.costUsd, 0);
    const [row] = await this.db<{ id: string }[]>`
      insert into explain_requests (workspace_id, user_id, session_id, source, mode, input_mode, instrument_id, symbol_text, tf,
                                    resolved_by, feed_match, feed_delta_pct, image_bytes, image_width, image_height, question,
                                    facts_hash, output, cost_usd, latency_ms, outcome)
      values (${c.workspaceId}, ${c.userId}, ${c.sessionId}, ${r.source}, ${o.mode}, ${r.inputMode ?? 'TEXT'}, ${o.instrumentId ?? null},
              ${o.symbolText ?? null}, ${o.tf ?? null}, ${o.resolvedBy ?? null}, ${o.feedMatch ?? null}, ${o.deltaPct ?? null},
              ${prepared?.bytes ?? null}, ${prepared?.width ?? null}, ${prepared?.height ?? null}, ${r.question ?? null},
              ${o.factsHash ?? null}, ${o.output ? this.db.json(o.output as never) : null}, ${cost}, ${Date.now() - o.started}, ${o.outcome})
      returning id`;
    const id = (row as { id: string }).id;
    if (o.outcome === 'OK' || o.outcome === 'OK_APPROXIMATE') {
      await this.db`
        insert into journal_entries (workspace_id, user_id, session_id, explain_id, kind, payload)
        values (${c.workspaceId}, ${c.userId}, ${c.sessionId}, ${id}, 'EXPLAIN',
                ${this.db.json({ mode: o.mode, feedMatch: o.feedMatch ?? null } as never)})`;
    }
    if (c.sessionId && o.calls.length > 0) {
      await this.db`
        update copilot_sessions set ai_calls_count = ai_calls_count + ${o.calls.length}, ai_cost_usd = ai_cost_usd + ${cost}
         where id = ${c.sessionId}`;
    }
    return id;
  }
}
