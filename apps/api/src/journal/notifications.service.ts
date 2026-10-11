import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';
import { decodeCursor, encodeCursor } from '../setups/setups.service.js';

export interface NotificationDto {
  id: string;
  type: string;
  payload: unknown;
  read: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  created_at: Date;
}
const toDto = (r: Row): NotificationDto => ({
  id: r.id,
  type: r.type,
  payload: r.payload,
  read: r.status === 'READ',
  createdAt: r.created_at.toISOString(),
});

/** In-app notifications only (B05 week 11). There is no email, push or webhook channel in the MVP. */
@Injectable()
export class NotificationsService {
  /** Realtime hook: called after a notification is stored. */
  onCreated: ((workspaceId: string, userId: string, n: NotificationDto) => void) | null = null;

  constructor(@Inject(SQL) private readonly sqlOrNull: Sql | null) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async create(
    workspaceId: string,
    userId: string,
    type: string,
    payload: Record<string, unknown>,
  ) {
    const [r] = await this.sql<Row[]>`
      insert into notifications (workspace_id, user_id, channel, type, payload, status, sent_at)
      values (${workspaceId}, ${userId}, 'IN_APP', ${type}, ${this.sql.json(payload as never)}, 'SENT', now())
      returning id, type, payload, status, created_at`;
    const dto = toDto(r as Row);
    this.onCreated?.(workspaceId, userId, dto);
    return dto;
  }

  async list(userId: string, unreadOnly: boolean, cursor: string | undefined, limit: number) {
    const cur = decodeCursor(cursor);
    const rows = await this.sql<Row[]>`
      select id, type, payload, status, created_at from notifications
       where user_id = ${userId} and channel = 'IN_APP'
         ${unreadOnly ? this.sql`and status <> 'READ'` : this.sql``}
         ${cur ? this.sql`and (created_at, id) < (${cur.at}, ${cur.id})` : this.sql``}
       order by created_at desc, id desc limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const r = await this
      .sql`update notifications set status = 'READ' where id = ${id} and user_id = ${userId} returning id`;
    if (r.length === 0) throw new ApiProblemError('NOT_FOUND');
  }

  async markAllRead(userId: string): Promise<void> {
    await this
      .sql`update notifications set status = 'READ' where user_id = ${userId} and status <> 'READ'`;
  }
}
