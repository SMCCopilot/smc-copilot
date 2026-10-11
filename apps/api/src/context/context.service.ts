import { Inject, Injectable } from '@nestjs/common';
import { parsePriceText, priceMatch } from '@smc/ai';
import { type OcrContext, type Timeframe, TimeframeSchema, type WarningCode } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { RateLimiter } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';
import { MarketsService } from '../markets/markets.service.js';

/** Instruments whose price tolerance is the tighter "core" one (A02 section 3.2). */
const CORE_BASES = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP']);
const MIN_TEXT_CONFIDENCE = 0.5;
const LOW_SYMBOL_CONFIDENCE = 0.6;
/** Every price comparison reveals a little about the price; cap how many one user can make. */
const RECONCILE_PER_HOUR = 60;

export interface HintState {
  /** Instrument the last hint(s) pointed at, and how many consecutive hints agreed. */
  candidate: string | null;
  count: number;
  /** Instrument currently locked by OCR, if any. */
  locked: string | null;
}
export const newHintState = (): HintState => ({ candidate: null, count: 0, locked: null });

/**
 * The 2-hint rule (A02 section 3.2): a context only changes after two consecutive hints name the same new instrument,
 * so a flapping read (A, B, A, B) never moves the user's view. Pure.
 */
export function applyHint(
  state: HintState,
  instrumentId: string | null,
): { state: HintState; lock: string | null } {
  if (!instrumentId) return { state: { ...state, candidate: null, count: 0 }, lock: null };
  if (instrumentId === state.locked)
    return { state: { ...state, candidate: null, count: 0 }, lock: null };
  const count = state.candidate === instrumentId ? state.count + 1 : 1;
  if (count >= 2)
    return { state: { candidate: null, count: 0, locked: instrumentId }, lock: instrumentId };
  return { state: { ...state, candidate: instrumentId, count }, lock: null };
}

/** `15` -> 15m, `60` -> 1h, `240` -> 4h, `1D`/`D` -> 1d, `4h`, `1W`. Anything else is null. */
export function parseTimeframeText(text: string | undefined): Timeframe | null {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  let norm: string | null = null;
  const bare = /^(\d{1,4})$/.exec(t);
  const suffixed = /^(\d{0,3})(m|min|h|hr|d|w)$/.exec(t);
  if (bare) {
    const n = Number(bare[1]);
    norm = n % 1440 === 0 ? `${n / 1440}d` : n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  } else if (suffixed) {
    const n = suffixed[1] || '1';
    const u = suffixed[2];
    norm = `${n}${u === 'min' ? 'm' : u === 'hr' ? 'h' : u}`;
  }
  const parsed = TimeframeSchema.safeParse(norm);
  return parsed.success ? parsed.data : null;
}

export function cleanSymbolText(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  return /^[A-Za-z0-9:._/\- ]{2,30}$/.test(t) ? t : null;
}

export interface HintEvaluation {
  instrumentId: string | null;
  canonical: string | null;
  tf: Timeframe | null;
  feedMatch: 'MATCH' | 'MISMATCH' | 'UNVERIFIED';
  deltaPct: number | null;
  /** A different candidate whose price does match, offered when the first one does not (no price is revealed). */
  suggestion: string | null;
  ambiguous: boolean;
  warnings: { code: WarningCode; detail: string }[];
}

/**
 * Server side of `context.hint` (A02 section 3.2, B05 week 14). The browser only sends text; everything here is
 * re-derived with the server's own parsers, free text (`OTHER`) is discarded, and a price read from the screen is
 * only ever compared with the feed, never returned.
 */
@Injectable()
export class ContextService {
  private readonly reconcileLimiter = new RateLimiter();

  constructor(
    @Inject(SQL) private readonly sql: Sql | null,
    private readonly markets: MarketsService,
  ) {}

  private async feedPrice(instrumentId: string): Promise<number | null> {
    if (!this.sql) return null;
    const [r] = await this.sql<{ c: string }[]>`
      select c from candles
       where instrument_id = ${instrumentId} and tf = '1m' and status = 'CLOSED'
         and scope_id = '00000000-0000-0000-0000-000000000000'
       order by open_time desc limit 1`;
    return r ? Number(r.c) : null;
  }

  private best(
    ocr: OcrContext,
    kind: 'SYMBOL' | 'TIMEFRAME' | 'VENUE' | 'LAST_PRICE',
  ): { text: string; conf: number } | null {
    const c = ocr.texts
      .filter((t) => t.kind === kind && t.conf >= MIN_TEXT_CONFIDENCE)
      .sort((a, b) => b.conf - a.conf)[0];
    return c ? { text: c.text, conf: c.conf } : null;
  }

  async evaluate(ocr: OcrContext, userId: string): Promise<HintEvaluation> {
    const warnings: HintEvaluation['warnings'] = [];
    const sym = this.best(ocr, 'SYMBOL');
    const symbolText = cleanSymbolText(sym?.text ?? ocr.derived?.symbolText);
    const tf = parseTimeframeText(this.best(ocr, 'TIMEFRAME')?.text ?? ocr.derived?.tfText);
    const venueText =
      cleanSymbolText(this.best(ocr, 'VENUE')?.text ?? ocr.derived?.venueText) ?? undefined;
    const shown =
      parsePriceText(this.best(ocr, 'LAST_PRICE')?.text) ?? ocr.derived?.lastPrice ?? null;
    const empty: HintEvaluation = {
      instrumentId: null,
      canonical: null,
      tf,
      feedMatch: 'UNVERIFIED',
      deltaPct: null,
      suggestion: null,
      ambiguous: false,
      warnings,
    };
    if (!symbolText || (sym && sym.conf < LOW_SYMBOL_CONFIDENCE)) {
      warnings.push({
        code: 'LOW_OCR_CONFIDENCE',
        detail: 'The symbol could not be read reliably. Pick it manually.',
      });
      return empty;
    }
    const { result, dtos } = await this.markets.resolve({
      text: symbolText,
      ...(venueText ? { venueText } : {}),
      ...(ocr.derived?.isPerp !== undefined ? { isPerp: ocr.derived.isPerp } : {}),
    });
    const top = result.candidates[0];
    if (!top) {
      warnings.push({
        code: 'LOW_OCR_CONFIDENCE',
        detail: 'That symbol is not one this service analyses. Pick it manually.',
      });
      return empty;
    }
    const inst = dtos.get(top.instrument.id);
    const out: HintEvaluation = {
      ...empty,
      instrumentId: top.instrument.id,
      canonical: top.instrument.canonical,
      ambiguous: result.ambiguous,
    };
    if (result.ambiguous) {
      warnings.push({
        code: 'LOW_OCR_CONFIDENCE',
        detail:
          'More than one market fits that chart (spot, perpetual or another venue). Pick it manually.',
      });
    }
    // Compare the price on the screen with the feed, internally.
    if (
      shown !== null &&
      this.reconcileLimiter.hit(`recon:${userId}`, RECONCILE_PER_HOUR, 3_600_000) === null
    ) {
      const core = CORE_BASES.has(inst?.base ?? '');
      const feed = await this.feedPrice(top.instrument.id);
      const m = priceMatch(shown, feed, core);
      out.feedMatch = m.match;
      out.deltaPct = m.deltaPct;
      if (m.match === 'MISMATCH') {
        for (const c of result.candidates.slice(1)) {
          const cinst = dtos.get(c.instrument.id);
          const alt = priceMatch(
            shown,
            await this.feedPrice(c.instrument.id),
            CORE_BASES.has(cinst?.base ?? ''),
          );
          if (alt.match === 'MATCH') {
            out.suggestion = c.instrument.canonical;
            break;
          }
        }
        warnings.push({
          code: 'FEED_MISMATCH',
          detail: out.suggestion
            ? `The price on your chart does not match ${top.instrument.canonical}. Did you mean ${out.suggestion}?`
            : `The price on your chart does not match ${top.instrument.canonical}. Check the venue and market type.`,
        });
      }
    }
    return out;
  }

  /** Throws when the instrument id does not exist (a manual pick that is not analysed). */
  async instrumentByCanonical(
    canonical: string,
  ): Promise<{ id: string; canonical: string; base: string; pricePrecision: number }> {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    const [row] = await this.sql<
      { id: string }[]
    >`select id from instruments where canonical = ${canonical}`;
    const inst = row ? await this.markets.get(row.id) : undefined;
    if (!inst)
      throw new ApiProblemError('INSTRUMENT_NOT_ENTITLED', 'That instrument is not available.');
    return {
      id: inst.id,
      canonical: inst.canonical,
      base: inst.base,
      pricePrecision: inst.pricePrecision,
    };
  }

  async feedPriceOf(instrumentId: string): Promise<number | null> {
    return this.feedPrice(instrumentId);
  }

  isCore(base: string): boolean {
    return CORE_BASES.has(base);
  }
}
