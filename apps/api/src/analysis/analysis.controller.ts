import { Controller, Get, Headers, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { ANALYSIS_INCLUDES, TimeframeSchema } from '@smc/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { parseWith } from '../common/validation.js';
import { AnalysisService } from './analysis.service.js';

const AnalysisQuerySchema = z.object({
  tf: TimeframeSchema.optional(),
  include: z
    .string()
    .max(100)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : []))
    .pipe(z.array(z.enum(ANALYSIS_INCLUDES))),
});

const EventsQuerySchema = z.object({
  tf: TimeframeSchema.optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

@Controller('v1/instruments/:id')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  /** The main read. `ETag` is the snapshot id: poll with `If-None-Match` and get 304 while nothing changed. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.analysis)
  @Get('analysis')
  async get(
    @Req() req: AccountRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() raw: unknown,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const q = parseWith(AnalysisQuerySchema, raw);
    const body = await this.analysis.snapshot(
      id,
      req.account.workspaceId,
      q.tf,
      new Set(q.include),
    );
    const etag = `"${body.snapshotId}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (ifNoneMatch === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('analysis/events')
  events(@Param('id', ParseUUIDPipe) id: string, @Query() raw: unknown) {
    const q = parseWith(EventsQuerySchema, raw);
    return this.analysis.events(id, q.tf, q.since ? new Date(q.since) : undefined, q.limit);
  }
}
