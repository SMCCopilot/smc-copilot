import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Sql } from '@smc/db';
import { AccountService } from '../account/account.service.js';
import { ApiProblemError } from '../common/problem.js';
import { INGEST_RUNTIME, SQL } from '../config/tokens.js';
import type { IngestRuntime } from '../ingest/ingest.runtime.js';

export const GATE_TTL_SEC = 60;
/** A confirmed gate must be spent on a trade within this long. */
export const GATE_USE_WINDOW_SEC = 60;

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

interface GateRow {
  id: string;
  user_id: string;
  workspace_id: string;
  plan_id: string;
  plan_hash: string;
  action: 'ISSUED' | 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'VOIDED';
  expires_at: Date;
  decided_at: Date | null;
}

export interface GateStateDto {
  gateId: string;
  planId: string;
  planHash: string;
  state: GateRow['action'];
  expiresAt: string;
}

const dto = (g: GateRow): GateStateDto => ({
  gateId: g.id,
  planId: g.plan_id,
  planHash: g.plan_hash,
  state: g.action,
  expiresAt: g.expires_at.toISOString(),
});

/**
 * The execution gate (A04 section 11, invariant 1). The server never places an order: this only records that a human
 * looked at one exact plan and tapped confirm. Token is single-use, 60 s, bound to the plan hash; only its hash is stored;
 * and the database itself refuses any confirmation channel other than UI_TAP.
 */
@Injectable()
export class GateService {
  /** Published to the realtime layer so the open session can show gate.state. Set by the gateway. */
  onState: ((workspaceId: string, userId: string, g: GateStateDto) => void) | null = null;

  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    private readonly account: AccountService,
    @Optional() @Inject(INGEST_RUNTIME) private readonly runtime: IngestRuntime | null,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  /** The newest plan version for the setup of `planId`, with the setup's state and instrument. */
  private async planInfo(planId: string) {
    const [row] = await this.sql<
      {
        setup_id: string;
        instrument_id: string;
        state: string;
        latest_hash: string;
        this_hash: string;
        latest_id: string;
      }[]
    >`
      select p.setup_id, s.instrument_id, s.state, p.plan_hash as this_hash,
             l.plan_hash as latest_hash, l.id as latest_id
        from trade_plans p
        join setups s on s.id = p.setup_id
        join lateral (select id, plan_hash from trade_plans t where t.setup_id = p.setup_id
                       order by plan_version desc limit 1) l on true
       where p.id = ${planId}`;
    return row;
  }

  async issue(userId: string, workspaceId: string, planId: string, ip: string | null) {
    const info = await this.planInfo(planId);
    if (!info) throw new ApiProblemError('NOT_FOUND', 'That plan does not exist.');
    if (info.latest_id !== planId) {
      throw new ApiProblemError('PLAN_CHANGED', 'The plan has been revised. Review the new plan.');
    }
    if (info.state !== 'ARMED' && info.state !== 'TRIGGERED') {
      throw new ApiProblemError('CONFLICT', 'That setup is no longer actionable.');
    }
    const feed = this.runtime?.monitor?.statusOf(info.instrument_id)?.state;
    if (feed === 'STALE') {
      throw new ApiProblemError('FEED_STALE', 'The data feed is stale; no new gate can be issued.');
    }

    const token = randomBytes(32).toString('base64url');
    // At most one open gate per user and plan: void the previous and insert in one serialised transaction.
    const gate = await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      await db`select pg_advisory_xact_lock(hashtext(${`gate:${userId}:${planId}`}))`;
      await db`
        update gate_decisions set action = 'VOIDED', decided_at = now(), void_reason = 'SUPERSEDED'
         where user_id = ${userId} and plan_id = ${planId} and action = 'ISSUED'`;
      const [g] = await db<GateRow[]>`
      insert into gate_decisions (workspace_id, user_id, plan_id, plan_hash, token_hash, expires_at)
      values (${workspaceId}, ${userId}, ${planId}, ${info.this_hash}, ${hashToken(token)},
              now() + ${GATE_TTL_SEC} * interval '1 second')
      returning id, user_id, workspace_id, plan_id, plan_hash, action, expires_at, decided_at`;
      return g as GateRow;
    });
    await this.account.audit(userId, workspaceId, 'gate.issue', gate.id, ip, { planId });
    this.onState?.(workspaceId, userId, dto(gate));
    return { ...dto(gate), token };
  }

  /** Confirm: one atomic conditional update, so a token can win at most once. */
  async confirm(
    userId: string,
    workspaceId: string,
    gateId: string,
    token: string,
    planHash: string,
    ip: string | null,
  ) {
    const [won] = await this.sql<GateRow[]>`
      update gate_decisions
         set action = 'CONFIRMED', decided_at = now(), confirmed_via = 'UI_TAP'
       where id = ${gateId} and user_id = ${userId} and token_hash = ${hashToken(token)}
         and plan_hash = ${planHash} and action = 'ISSUED' and expires_at > now()
      returning id, user_id, workspace_id, plan_id, plan_hash, action, expires_at, decided_at`;
    if (!won) {
      const [g] = await this.sql<GateRow[]>`
        select id, user_id, workspace_id, plan_id, plan_hash, action, expires_at, decided_at
          from gate_decisions where id = ${gateId} and user_id = ${userId}`;
      if (!g) throw new ApiProblemError('GATE_TOKEN_INVALID', 'That gate does not exist.');
      if (g.action === 'ISSUED' && g.expires_at.getTime() <= Date.now()) {
        await this
          .sql`update gate_decisions set action = 'EXPIRED', decided_at = now() where id = ${gateId} and action = 'ISSUED'`;
        throw new ApiProblemError('GATE_TOKEN_EXPIRED', 'The confirmation window has closed.');
      }
      if (g.action === 'EXPIRED') {
        throw new ApiProblemError('GATE_TOKEN_EXPIRED', 'The confirmation window has closed.');
      }
      throw new ApiProblemError('GATE_TOKEN_INVALID', 'That confirmation is not valid.');
    }

    // The plan must still be the newest version and the setup still actionable at the moment of the tap.
    const info = await this.planInfo(won.plan_id);
    const stale = !info || info.latest_id !== won.plan_id || info.latest_hash !== won.plan_hash;
    if (stale || (info.state !== 'ARMED' && info.state !== 'TRIGGERED')) {
      await this.sql`
        update gate_decisions set action = 'VOIDED', void_reason = ${stale ? 'PLAN_CHANGED' : 'SETUP_CLOSED'}
         where id = ${gateId}`;
      throw new ApiProblemError(
        'PLAN_CHANGED',
        'The plan changed before you confirmed. Review it again.',
      );
    }
    await this.account.audit(userId, workspaceId, 'gate.confirm', gateId, ip, {
      planId: won.plan_id,
      planHash: won.plan_hash,
      via: 'UI_TAP',
    });
    this.onState?.(workspaceId, userId, dto(won));
    return dto(won);
  }

  async decline(
    userId: string,
    workspaceId: string,
    gateId: string,
    reason: string | undefined,
    ip: string | null,
  ) {
    const [g] = await this.sql<GateRow[]>`
      update gate_decisions set action = 'DECLINED', decided_at = now(), void_reason = ${reason ?? null}
       where id = ${gateId} and user_id = ${userId} and action = 'ISSUED'
      returning id, user_id, workspace_id, plan_id, plan_hash, action, expires_at, decided_at`;
    if (!g) throw new ApiProblemError('GATE_TOKEN_INVALID', 'That gate is not open.');
    await this.account.audit(userId, workspaceId, 'gate.decline', gateId, ip, {});
    this.onState?.(workspaceId, userId, dto(g));
    return dto(g);
  }

  async get(userId: string, gateId: string) {
    const [g] = await this.sql<GateRow[]>`
      select id, user_id, workspace_id, plan_id, plan_hash, action, expires_at, decided_at
        from gate_decisions where id = ${gateId} and user_id = ${userId}`;
    if (!g) throw new ApiProblemError('NOT_FOUND');
    return dto(g);
  }

  /**
   * Spends a confirmed gate inside the caller's transaction. Locks the row, so two trades can never use one gate; the
   * gate must be CONFIRMED for this exact plan, still within the use window, and unused.
   */
  async spend(tx: Sql, userId: string, gateId: string, planId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtext(${`spend:${gateId}`}))`;
    const [g] = await tx<(GateRow & { used: boolean; fresh: boolean })[]>`
      select g.id, g.user_id, g.workspace_id, g.plan_id, g.plan_hash, g.action, g.expires_at, g.decided_at,
             exists (select 1 from trade_records t where t.gate_id = g.id) as used,
             coalesce(g.decided_at > now() - ${GATE_USE_WINDOW_SEC} * interval '1 second', false) as fresh
        from gate_decisions g where g.id = ${gateId} and g.user_id = ${userId} for update`;
    if (!g || g.plan_id !== planId || g.action !== 'CONFIRMED') {
      throw new ApiProblemError(
        'GATE_TOKEN_INVALID',
        'A confirmed gate for this plan is required.',
      );
    }
    if (g.used) throw new ApiProblemError('GATE_TOKEN_INVALID', 'That gate was already used.');
    if (!g.fresh) throw new ApiProblemError('GATE_TOKEN_EXPIRED', 'The confirmation has expired.');
    const info = await this.planInfo(planId);
    if (!info || info.latest_id !== planId || info.latest_hash !== g.plan_hash) {
      throw new ApiProblemError('PLAN_CHANGED', 'The plan changed after you confirmed.');
    }
  }
}
