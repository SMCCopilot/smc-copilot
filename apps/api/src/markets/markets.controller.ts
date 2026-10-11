import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { TimeframeSchema } from '@smc/contracts';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { INGEST_RUNTIME } from '../config/tokens.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';
import { LicenseGuard } from './license.guard.js';
import { MarketsService } from './markets.service.js';

const ResolveQuerySchema = z.object({
  q: z.string().min(1).max(60),
  venue: z.string().max(40).optional(),
  perp: z.enum(['true', 'false']).optional(),
  price: z.coerce.number().positive().max(1e12).optional(),
});

const CandlesQuerySchema = z.object({
  tf: TimeframeSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  before: z.iso.datetime().optional(),
});

@Controller('v1')
export class MarketsController {
  constructor(
    private readonly markets: MarketsService,
    @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  /** Public: overall feed health, no instrument detail. */
  @Get('status')
  status(): {
    ingest: 'DISABLED' | 'RUNNING';
    feeds: { ok: number; degraded: number; stale: number; total: number };
    asOf: string;
  } {
    const all = this.runtime?.monitor?.all() ?? [];
    return {
      ingest: this.runtime ? 'RUNNING' : 'DISABLED',
      feeds: {
        ok: all.filter((f) => f.state === 'OK').length,
        degraded: all.filter((f) => f.state === 'DEGRADED').length,
        stale: all.filter((f) => f.state === 'STALE').length,
        total: all.length,
      },
      asOf: new Date().toISOString(),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('instruments')
  async list() {
    return { items: await this.markets.list() };
  }

  @UseGuards(JwtAuthGuard)
  @Get('instruments/resolve')
  async resolve(@Query() raw: unknown) {
    const q = parseWith(ResolveQuerySchema, raw);
    const { result, dtos } = await this.markets.resolve({
      text: q.q,
      venueText: q.venue,
      isPerp: q.perp === undefined ? undefined : q.perp === 'true',
      lastPrice: q.price,
    });
    return {
      ambiguous: result.ambiguous,
      candidates: result.candidates.flatMap((c) => {
        const instrument = dtos.get(c.instrument.id);
        return instrument ? [{ instrument, score: c.score, reasons: c.reasons }] : [];
      }),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('instruments/:id')
  async one(@Param('id', ParseUUIDPipe) id: string) {
    const instrument = await this.markets.get(id);
    if (!instrument) throw new ApiProblemError('NOT_FOUND');
    return instrument;
  }

  @UseGuards(JwtAuthGuard)
  @Get('instruments/:id/status')
  async instrumentStatus(@Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.markets.get(id))) throw new ApiProblemError('NOT_FOUND');
    const s = this.runtime?.monitor?.statusOf(id);
    if (!s)
      return {
        instrumentId: id,
        state: 'UNKNOWN' as const,
        reasons: [] as string[],
        lastClosedAt: null,
        since: null,
      };
    return {
      instrumentId: id,
      state: s.state,
      reasons: s.reasons,
      lastClosedAt: s.lastClosedOpenMs === null ? null : new Date(s.lastClosedOpenMs).toISOString(),
      since: new Date(s.since).toISOString(),
    };
  }

  /** Always registered (keeps the contract identical to Set A) but refuses unless the licence view says DISPLAY_OK. */
  @UseGuards(JwtAuthGuard, LicenseGuard)
  @Get('instruments/:id/candles')
  async candles(@Param('id', ParseUUIDPipe) id: string, @Query() raw: unknown) {
    const q = parseWith(CandlesQuerySchema, raw);
    return {
      items: await this.markets.candles(
        id,
        q.tf,
        q.limit,
        q.before ? new Date(q.before) : undefined,
      ),
    };
  }
}
