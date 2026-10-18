import { Inject, Injectable } from '@nestjs/common';
import {
  type KillSwitchScope,
  parseStrategyConfig,
  StrategyVersionCreateSchema,
} from '@smc/contracts';
import type { Sql } from '@smc/db';
import type { z } from 'zod';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';
import { AccountService } from './account.service.js';
import { FlagsService } from './flags.service.js';
import { normalizeWallet } from './wallet.js';

export interface Actor {
  userId: string;
  ip: string | null;
}

const FLAG_KEY = /^[a-z0-9_.-]{1,64}$/;

/** Operator actions. Every one writes `audit_log` (A07 section 9). */
@Injectable()
export class AdminOpsService {
  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    private readonly accounts: AccountService,
    private readonly flags: FlagsService,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  private audit(
    a: Actor,
    action: string,
    target: string | null,
    detail: Record<string, unknown> = {},
  ) {
    return this.accounts.audit(a.userId, null, action, target, a.ip, detail);
  }

  async blocklist(
    a: Actor,
    entry: {
      chain: 'evm' | 'solana';
      address: string;
      note?: string | undefined;
      action: 'ADD' | 'REMOVE';
    },
  ): Promise<void> {
    const w = normalizeWallet(entry.chain, entry.address);
    if (!w) throw new ApiProblemError('VALIDATION_FAILED', 'Not a valid address for that chain.');
    if (entry.action === 'ADD') {
      await this.sql`
        insert into address_blocklist (chain, address_norm, source, note)
        values (${w.chain}, ${w.norm}, 'MANUAL', ${entry.note ?? null})
        on conflict (chain, address_norm) do nothing`;
    } else {
      await this
        .sql`delete from address_blocklist where chain = ${w.chain} and address_norm = ${w.norm}`;
    }
    await this.audit(a, `admin.blocklist.${entry.action.toLowerCase()}`, `${w.chain}:${w.norm}`);
  }

  /** Loads a public sanctions list. Invalid addresses are counted and skipped, never guessed at. */
  async importBlocklist(
    a: Actor,
    source: string,
    entries: { chain: 'evm' | 'solana'; address: string }[],
  ): Promise<{ imported: number; skipped: number }> {
    const rows = entries.flatMap((e) => {
      const w = normalizeWallet(e.chain, e.address);
      return w ? [{ chain: w.chain, address_norm: w.norm, source }] : [];
    });
    for (let i = 0; i < rows.length; i += 1000) {
      await this.sql`
        insert into address_blocklist ${this.sql(rows.slice(i, i + 1000), 'chain', 'address_norm', 'source')}
        on conflict (chain, address_norm) do nothing`;
    }
    await this.audit(a, 'admin.blocklist.import', source, { imported: rows.length });
    return { imported: rows.length, skipped: entries.length - rows.length };
  }

  async user(userId: string) {
    const [p] = await this.sql<Record<string, unknown>[]>`
      select p.id, p.display_name, p.created_at, p.disclaimer_version, p.age_confirmed_at,
             p.blocked_at, p.block_reason, p.deleted_at, w.id as workspace_id, w.plan
        from profiles p left join workspaces w on w.owner_id = p.id and w.kind = 'personal'
       where p.id = ${userId}`;
    if (!p) throw new ApiProblemError('NOT_FOUND');
    const wallets = await this.accounts.walletsOf(userId);
    const [e] = await this.sql<{ limits: unknown; features: unknown }[]>`
      select e.limits, e.features from entitlements e join workspaces w on w.id = e.workspace_id
       where w.owner_id = ${userId} and w.kind = 'personal'`;
    return { profile: p, wallets, entitlements: e ?? null };
  }

  async patchEntitlements(
    a: Actor,
    userId: string,
    patch: {
      limits?: Record<string, number> | undefined;
      features?: Record<string, boolean> | undefined;
    },
  ): Promise<void> {
    const res = await this.sql`
      update entitlements e set
        limits = e.limits || ${this.sql.json((patch.limits ?? {}) as never)},
        features = e.features || ${this.sql.json((patch.features ?? {}) as never)},
        updated_at = now()
       from workspaces w
      where w.id = e.workspace_id and w.owner_id = ${userId} and w.kind = 'personal'
      returning e.workspace_id`;
    if (res.length === 0) throw new ApiProblemError('NOT_FOUND');
    await this.audit(a, 'admin.entitlements', userId, patch as Record<string, unknown>);
  }

  async blockUser(
    a: Actor,
    userId: string,
    blocked: boolean,
    reason: string | undefined,
  ): Promise<void> {
    const res = await this.sql`
      update profiles set blocked_at = ${blocked ? this.sql`now()` : null}, block_reason = ${blocked ? (reason ?? 'ADMIN') : null}
       where id = ${userId} returning id`;
    if (res.length === 0) throw new ApiProblemError('NOT_FOUND');
    if (blocked) {
      // A blocked user keeps nothing open: gates are voided and sessions ended at once.
      await this
        .sql`update gate_decisions set action = 'VOIDED', decided_at = now(), void_reason = 'USER_BLOCKED' where user_id = ${userId} and action in ('ISSUED','CONFIRMED') and decided_at is null or (user_id = ${userId} and action = 'ISSUED')`;
      await this
        .sql`update copilot_sessions set state = 'ENDED', ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'USER_BLOCKED') where user_id = ${userId} and state <> 'ENDED'`;
    }
    await this.audit(a, blocked ? 'admin.user.block' : 'admin.user.unblock', userId, {
      reason: reason ?? null,
    });
  }

  async setFlag(
    a: Actor,
    key: string,
    enabled: boolean,
    rolloutPct: number | undefined,
  ): Promise<void> {
    if (!FLAG_KEY.test(key)) throw new ApiProblemError('VALIDATION_FAILED', 'Invalid flag key.');
    await this.sql`
      insert into feature_flags (key, enabled, rollout_pct)
      values (${key}, ${enabled}, ${rolloutPct ?? (enabled ? 100 : 0)})
      on conflict (key) do update set enabled = excluded.enabled, rollout_pct = excluded.rollout_pct, updated_at = now()`;
    this.flags.invalidate();
    await this.audit(a, 'admin.flag', key, { enabled, rolloutPct: rolloutPct ?? null });
  }

  async killSwitch(a: Actor, scope: KillSwitchScope, active: boolean): Promise<void> {
    await this.sql`
      insert into feature_flags (key, enabled, rollout_pct)
      values (${`kill.${scope}`}, ${active}, ${active ? 100 : 0})
      on conflict (key) do update set enabled = excluded.enabled, rollout_pct = excluded.rollout_pct, updated_at = now()`;
    this.flags.invalidate();
    await this.audit(a, 'admin.kill_switch', scope, { active });
  }

  async createStrategyVersion(a: Actor, body: z.infer<typeof StrategyVersionCreateSchema>) {
    // The config must parse as a full strategy before it is stored; once stored it can never be edited.
    let config: ReturnType<typeof parseStrategyConfig>;
    try {
      config = parseStrategyConfig('draft', body.config);
    } catch (e) {
      throw new ApiProblemError('VALIDATION_FAILED', 'The strategy config is not valid.', {
        issues: ((e as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? []).map(
          (i) => ({
            path: i.path.join('.'),
            message: i.message,
          }),
        ),
      });
    }
    const { strategyVersionId: _ignored, ...stored } = config;
    const [row] = await this.sql<{ id: string; version: number }[]>`
      insert into strategy_versions (name, version, schema_version, config, status, notes)
      values (${body.name},
              (select coalesce(max(version), 0) + 1 from strategy_versions where name = ${body.name}),
              ${config.schemaVersion}, ${this.sql.json(stored as never)}, 'DRAFT', ${body.notes ?? null})
      returning id, version`;
    await this.audit(a, 'admin.strategy.create', row?.id ?? null, {
      name: body.name,
      version: row?.version,
    });
    return row;
  }

  /** Exactly one ACTIVE version per name: the previous one is retired in the same transaction. */
  async activateStrategyVersion(a: Actor, id: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      const [v] = await db<
        { name: string }[]
      >`select name from strategy_versions where id = ${id} for update`;
      if (!v) throw new ApiProblemError('NOT_FOUND');
      await db`update strategy_versions set status = 'RETIRED' where name = ${v.name} and status = 'ACTIVE' and id <> ${id}`;
      await db`update strategy_versions set status = 'ACTIVE' where id = ${id}`;
      await this.accounts.audit(a.userId, null, 'admin.strategy.activate', id, a.ip, {}, db);
    });
  }

  async dqIncidents(status: 'open' | 'closed' | 'all') {
    const rows = await this.sql<Record<string, unknown>[]>`
      select id, instrument_id, venue_id, rule, details, opened_at, closed_at from dq_incidents
       where ${status === 'all' ? this.sql`true` : status === 'open' ? this.sql`closed_at is null` : this.sql`closed_at is not null`}
       order by opened_at desc limit 200`;
    return { items: rows };
  }

  async closeDqIncident(a: Actor, id: number): Promise<void> {
    const res = await this
      .sql`update dq_incidents set closed_at = now() where id = ${id} and closed_at is null returning id`;
    if (res.length === 0) throw new ApiProblemError('NOT_FOUND');
    await this.audit(a, 'admin.dq.close', String(id));
  }
}
