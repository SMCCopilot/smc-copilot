import { Inject, Injectable } from '@nestjs/common';
import type { JournalNoteSchema, JournalPatchSchema } from '@smc/contracts';
import type { Sql } from '@smc/db';
import type { z } from 'zod';
import { ApiProblemError } from '../common/problem.js';
import { assertNoSecret } from '../common/secrets.js';
import { SQL } from '../config/tokens.js';
import { decodeCursor, encodeCursor } from '../setups/setups.service.js';

interface EntryRow {
  id: string;
  kind: string;
  session_id: string | null;
  setup_id: string | null;
  plan_id: string | null;
  trade_id: string | null;
  notes: string | null;
  tags: string[];
  payload: unknown;
  created_at: Date;
}

const toDto = (r: EntryRow) => ({
  id: r.id,
  kind: r.kind,
  sessionId: r.session_id,
  setupId: r.setup_id,
  planId: r.plan_id,
  tradeId: r.trade_id,
  notes: r.notes,
  tags: r.tags,
  payload: r.payload,
  createdAt: r.created_at.toISOString(),
});

/** The minimum number of resolved trades before a win rate is shown (invariant 5). */
export const MIN_N = 30;

@Injectable()
export class JournalService {
  constructor(@Inject(SQL) private readonly sqlOrNull: Sql | null) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async list(
    workspaceId: string,
    f: { kind?: string | undefined; tag?: string | undefined; tradeId?: string | undefined },
    cursor: string | undefined,
    limit: number,
  ) {
    const cur = decodeCursor(cursor);
    const rows = await this.sql<EntryRow[]>`
      select id, kind, session_id, setup_id, plan_id, trade_id, notes, tags, payload, created_at
        from journal_entries
       where workspace_id = ${workspaceId}
         ${f.kind ? this.sql`and kind = ${f.kind}` : this.sql``}
         ${f.tag ? this.sql`and ${f.tag} = any(tags)` : this.sql``}
         ${f.tradeId ? this.sql`and trade_id = ${f.tradeId}` : this.sql``}
         ${cur ? this.sql`and (created_at, id) < (${cur.at}, ${cur.id})` : this.sql``}
       order by created_at desc, id desc limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async addNote(userId: string, workspaceId: string, b: z.infer<typeof JournalNoteSchema>) {
    assertNoSecret(b.notes, ...b.tags);
    if (b.tradeId) {
      const [t] = await this
        .sql`select 1 from trade_records where id = ${b.tradeId} and workspace_id = ${workspaceId}`;
      if (!t) throw new ApiProblemError('NOT_FOUND', 'Unknown trade.');
    }
    const [r] = await this.sql<EntryRow[]>`
      insert into journal_entries (workspace_id, user_id, setup_id, trade_id, kind, notes, tags)
      values (${workspaceId}, ${userId}, ${b.setupId ?? null}, ${b.tradeId ?? null}, 'NOTE', ${b.notes}, ${b.tags})
      returning id, kind, session_id, setup_id, plan_id, trade_id, notes, tags, payload, created_at`;
    return toDto(r as EntryRow);
  }

  /** Only the user's words are editable; the recorded facts of an entry (kind, plan, payload) never change. */
  async patch(id: string, workspaceId: string, b: z.infer<typeof JournalPatchSchema>) {
    assertNoSecret(b.notes, ...(b.tags ?? []));
    const [r] = await this.sql<EntryRow[]>`
      update journal_entries set notes = coalesce(${b.notes ?? null}, notes), tags = coalesce(${b.tags ?? null}, tags)
       where id = ${id} and workspace_id = ${workspaceId}
      returning id, kind, session_id, setup_id, plan_id, trade_id, notes, tags, payload, created_at`;
    if (!r) throw new ApiProblemError('NOT_FOUND');
    return toDto(r);
  }

  /** Counts and realised R. A win rate appears only with at least 30 closed trades (invariant 5). */
  async summary(workspaceId: string) {
    const [t] = await this.sql<
      { n: number; open: number; wins: number; sum_r: string | null; measured: number }[]
    >`
      select count(*) filter (where status = 'CLOSED')::int as n,
             count(*) filter (where status = 'OPEN')::int as open,
             count(*) filter (where status = 'CLOSED' and realized_r > 0)::int as wins,
             sum(realized_r) filter (where status = 'CLOSED') as sum_r,
             count(*) filter (where status = 'CLOSED' and realized_r is not null)::int as measured
        from trade_records where workspace_id = ${workspaceId}`;
    const [v] = await this.sql<{ shown: number }[]>`
      select count(*)::int as shown from journal_entries where workspace_id = ${workspaceId} and kind = 'SETUP_SHOWN'`;
    const measured = t?.measured ?? 0;
    return {
      closedTrades: t?.n ?? 0,
      openTrades: t?.open ?? 0,
      setupsShown: v?.shown ?? 0,
      totalR: t?.sum_r === null || t?.sum_r === undefined ? null : Number(t.sum_r),
      winRate: measured >= MIN_N ? (t?.wins ?? 0) / measured : null,
      winRateReason: measured >= MIN_N ? null : 'INSUFFICIENT_HISTORY',
    };
  }
}
