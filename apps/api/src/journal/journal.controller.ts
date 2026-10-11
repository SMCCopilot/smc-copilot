import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { FeedbackSchema, JournalNoteSchema, JournalPatchSchema } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { SQL } from '../config/tokens.js';
import { JournalService } from './journal.service.js';
import { NotificationsService } from './notifications.service.js';

const Page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
const JournalQuery = Page.extend({
  kind: z
    .enum(['SETUP_SHOWN', 'SETUP_REJECTED', 'GATE', 'TRADE', 'NOTE', 'AI_REVIEW', 'EXPLAIN'])
    .optional(),
  tag: z.string().max(32).optional(),
  tradeId: z.uuid().optional(),
});
const NotifQuery = Page.extend({ unread: z.enum(['true', 'false']).default('false') });

@Controller('v1')
export class JournalController {
  constructor(
    private readonly journal: JournalService,
    private readonly notifications: NotificationsService,
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
  ) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('journal')
  list(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(JournalQuery, raw);
    return this.journal.list(req.account.workspaceId, q, q.cursor, q.limit);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('journal/summary')
  summary(@Req() req: AccountRequest) {
    return this.journal.summary(req.account.workspaceId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Post('journal/notes')
  note(@Req() req: AccountRequest, @Body() body: unknown) {
    return this.journal.addNote(
      req.account.userId,
      req.account.workspaceId,
      parseWith(JournalNoteSchema, body),
    );
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Patch('journal/:id')
  patch(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.journal.patch(id, req.account.workspaceId, parseWith(JournalPatchSchema, body));
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('notifications')
  notes(@Req() req: AccountRequest, @Query() raw: unknown) {
    const q = parseWith(NotifQuery, raw);
    return this.notifications.list(req.account.userId, q.unread === 'true', q.cursor, q.limit);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post('notifications/read-all')
  @HttpCode(204)
  async readAll(@Req() req: AccountRequest): Promise<void> {
    await this.notifications.markAllRead(req.account.userId);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post('notifications/:id/read')
  @HttpCode(204)
  async read(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.notifications.markRead(req.account.userId, id);
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.tradeWrite)
  @Post('feedback')
  @HttpCode(204)
  async feedback(@Req() req: AccountRequest, @Body() body: unknown): Promise<void> {
    const b = parseWith(FeedbackSchema, body);
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    await this.sqlOrNull`
      insert into user_feedback (workspace_id, user_id, target_type, target_id, rating, comment)
      values (${req.account.workspaceId}, ${req.account.userId}, ${b.targetType}, ${b.targetId}, ${b.rating ?? null}, ${b.comment ?? null})`;
  }
}
