import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { SETUP_STATES, TimeframeSchema } from '@smc/contracts';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { SetupsService } from './setups.service.js';

const ListQuerySchema = z.object({
  instrumentId: z.uuid().optional(),
  state: z.enum(SETUP_STATES).optional(),
  template: z.enum(['T1', 'T2', 'T3']).optional(),
  grade: z.enum(['A', 'B', 'C']).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  tf: TimeframeSchema.optional(),
});

const RejectedQuerySchema = z.object({
  instrumentId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('v1')
export class SetupsController {
  constructor(private readonly setups: SetupsService) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('setups')
  list(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(ListQuerySchema, raw);
    return this.setups.list(
      req.account.workspaceId,
      {
        instrumentId: q.instrumentId,
        state: q.state,
        template: q.template,
        grade: q.grade,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
      },
      q.cursor,
      q.limit,
    );
  }

  // Declared before `setups/:id` so "rejected" is not read as an id.
  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('setups/rejected')
  rejected(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(RejectedQuerySchema, raw);
    return this.setups.rejected(
      req.account.workspaceId,
      q.instrumentId,
      q.from ? new Date(q.from) : undefined,
      q.limit,
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('setups/:id')
  one(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.setups.get(id, req.account.workspaceId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('setups/:id/history')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.setups.history(id);
  }

  /** Base-rate cohorts. A rate is only ever returned for a sufficient cohort; `all=true` is for admins. */
  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('stats/cohorts')
  cohorts(@Req() req: AccountRequest, @Query('all') all?: string) {
    if (all === 'true' && !req.principal.roles.includes('admin')) {
      throw new ApiProblemError('FORBIDDEN', 'Administrator access is required.');
    }
    return this.setups.cohorts(all === 'true');
  }
}
