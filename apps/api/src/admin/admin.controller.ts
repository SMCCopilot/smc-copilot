import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { VenuePatchSchema, VenueTermsInputSchema } from '@smc/contracts';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { INGEST_RUNTIME } from '../config/tokens.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';
import { MarketsService } from '../markets/markets.service.js';
import { AdminGuard, adminSourceIp } from './admin.guard.js';

@Controller('v1/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly markets: MarketsService,
    @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  private actor(req: AuthenticatedRequest) {
    return { userId: req.principal.userId, ip: adminSourceIp(req) || null };
  }

  /** Feed health per instrument plus the counters an operator needs to see at a glance. */
  @Get('feeds')
  feeds() {
    const rt = this.runtime;
    return {
      ingest: rt ? 'RUNNING' : 'DISABLED',
      counters: rt?.ingest?.counters ?? null,
      providers: rt
        ? [...rt.providers.entries()].map(([id, p]) => ({
            id,
            ...p.health(),
            lastStatus: rt.providerStatus.get(id) ?? null,
          }))
        : [],
      feeds: rt?.monitor?.all() ?? [],
    };
  }

  /** Evidence for a licence decision. Recording a DISPLAY_OK row is the only thing that can open raw egress. */
  @Post('venues/:id/terms')
  async terms(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const input = parseWith(VenueTermsInputSchema, body);
    const created = await this.markets.recordVenueTerms(id, input, this.actor(req));
    if (!created) throw new ApiProblemError('NOT_FOUND');
    return { id: created };
  }

  @Patch('venues/:id')
  async patch(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const patch = parseWith(VenuePatchSchema, body);
    if (!(await this.markets.patchVenue(id, patch, this.actor(req))))
      throw new ApiProblemError('NOT_FOUND');
    return { ok: true };
  }
}
