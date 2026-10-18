import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@smc/config';
import type { MeResponse, WalletDto } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { ENV, SQL } from '../config/tokens.js';
import { type Wallet, walletFromIdentity } from './wallet.js';

export interface AccountContext {
  userId: string;
  workspaceId: string;
  profile: {
    displayName: string | null;
    locale: string;
    timezone: string;
    createdAt: Date;
    disclaimerVersion: string | null;
    ageConfirmedAt: Date | null;
    blockedAt: Date | null;
    deletedAt: Date | null;
  };
}

interface WalletRow {
  id: string;
  chain: 'evm' | 'solana';
  address_norm: string;
  address_display: string;
  is_primary: boolean;
  linked_at: Date;
}

const toDto = (r: WalletRow): WalletDto => ({
  id: r.id,
  chain: r.chain,
  address: r.address_display,
  primary: r.is_primary,
  linkedAt: r.linked_at.toISOString(),
});

/** Everything about "who is this user": profile, wallets mirrored from Supabase Auth, gates, entitlements. */
@Injectable()
export class AccountService {
  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async audit(
    actorId: string | null,
    workspaceId: string | null,
    action: string,
    target: string | null,
    ip: string | null,
    detail: Record<string, unknown> = {},
    db: Sql = this.sql,
  ): Promise<void> {
    await db`
      insert into audit_log (actor_id, workspace_id, action, target, ip, detail)
      values (${actorId}, ${workspaceId}, ${action}, ${target}, ${ip}::inet, ${db.json(detail as never)})`;
  }

  async loadContext(userId: string): Promise<AccountContext | null> {
    const [row] = await this.sql<
      {
        display_name: string | null;
        locale: string;
        timezone: string;
        created_at: Date;
        disclaimer_version: string | null;
        age_confirmed_at: Date | null;
        blocked_at: Date | null;
        deleted_at: Date | null;
        workspace_id: string;
      }[]
    >`
      select p.display_name, p.locale, p.timezone, p.created_at, p.disclaimer_version, p.age_confirmed_at,
             p.blocked_at, p.deleted_at, w.id as workspace_id
        from profiles p
        join workspaces w on w.owner_id = p.id and w.kind = 'personal'
       where p.id = ${userId}`;
    if (!row) return null;
    return {
      userId,
      workspaceId: row.workspace_id,
      profile: {
        displayName: row.display_name,
        locale: row.locale,
        timezone: row.timezone,
        createdAt: row.created_at,
        disclaimerVersion: row.disclaimer_version,
        ageConfirmedAt: row.age_confirmed_at,
        blockedAt: row.blocked_at,
        deletedAt: row.deleted_at,
      },
    };
  }

  /**
   * Mirrors the wallets Supabase Auth holds for this user into `wallet_identities` (idempotent), runs the sanctions
   * blocklist check, drops mirrors whose identity no longer exists and keeps exactly one primary wallet.
   * The wallet comes from the identity Supabase verified, never from anything the client sends.
   */
  async syncWallets(userId: string, ip: string | null): Promise<WalletRow[]> {
    const identities = await this.sql<
      { provider: string; identity_data: unknown; last_sign_in_at: Date | null }[]
    >`select provider, identity_data, last_sign_in_at from auth.identities where user_id = ${userId}`;
    const found: { wallet: Wallet; at: number }[] = [];
    for (const i of identities) {
      const wallet = walletFromIdentity(i.provider, i.identity_data);
      if (wallet) found.push({ wallet, at: i.last_sign_in_at?.getTime() ?? 0 });
    }

    for (const { wallet } of found) {
      const [hit] = await this.sql<{ source: string }[]>`
        select source from address_blocklist where chain = ${wallet.chain} and address_norm = ${wallet.norm}`;
      if (hit) {
        await this
          .sql`update profiles set blocked_at = now(), block_reason = ${hit.source} where id = ${userId} and blocked_at is null`;
        await this.audit(userId, null, 'wallet.blocked', wallet.chain, ip, { source: hit.source });
        throw new ApiProblemError('ADDRESS_BLOCKED', 'This account cannot be used.');
      }
    }

    return (await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      await db`select pg_advisory_xact_lock(hashtext(${`wallets:${userId}`}))`;
      const current = await db<WalletRow[]>`
        select id, chain, address_norm, address_display, is_primary, linked_at
          from wallet_identities where user_id = ${userId} and unlinked_at is null
         order by linked_at, id`;
      const key = (c: string, a: string): string => `${c}:${a}`;
      const have = new Map(current.map((r) => [key(r.chain, r.address_norm), r]));
      const want = new Set(found.map((f) => key(f.wallet.chain, f.wallet.norm)));

      for (const { wallet } of found) {
        if (have.has(key(wallet.chain, wallet.norm))) continue;
        const [owner] = await db<{ user_id: string }[]>`
          select user_id from wallet_identities
           where chain = ${wallet.chain} and address_norm = ${wallet.norm} and unlinked_at is null`;
        if (owner && owner.user_id !== userId) {
          throw new ApiProblemError(
            'WALLET_ALREADY_LINKED',
            'That wallet belongs to another account.',
          );
        }
        await db`
          insert into wallet_identities (user_id, chain, address_norm, address_display, is_primary)
          values (${userId}, ${wallet.chain}, ${wallet.norm}, ${wallet.display},
                  ${current.length === 0 && have.size === 0})`;
        have.set(key(wallet.chain, wallet.norm), {} as WalletRow);
      }

      // A wallet whose identity was removed at Supabase can no longer sign in: unlink its mirror.
      for (const r of current) {
        if (!want.has(key(r.chain, r.address_norm)) && found.length > 0) {
          await db`update wallet_identities set unlinked_at = now(), is_primary = false where id = ${r.id}`;
        }
      }

      // The wallet that signed in most recently gets last_login_at.
      const latest = [...found].sort((a, b) => b.at - a.at)[0];
      if (latest) {
        await db`
          update wallet_identities set last_login_at = now()
           where user_id = ${userId} and chain = ${latest.wallet.chain} and address_norm = ${latest.wallet.norm}
             and unlinked_at is null`;
      }

      // Exactly one primary among the active wallets.
      const [primaries] = await db<{ n: number }[]>`
        select count(*)::int as n from wallet_identities where user_id = ${userId} and unlinked_at is null and is_primary`;
      if ((primaries?.n ?? 0) === 0) {
        await db`
          update wallet_identities set is_primary = true
           where id = (select id from wallet_identities where user_id = ${userId} and unlinked_at is null
                        order by linked_at, id limit 1)`;
      }
      return db<WalletRow[]>`
        select id, chain, address_norm, address_display, is_primary, linked_at
          from wallet_identities where user_id = ${userId} and unlinked_at is null
         order by is_primary desc, linked_at, id`;
    })) as WalletRow[];
  }

  async walletsOf(userId: string): Promise<WalletDto[]> {
    const rows = await this.sql<WalletRow[]>`
      select id, chain, address_norm, address_display, is_primary, linked_at
        from wallet_identities where user_id = ${userId} and unlinked_at is null
       order by is_primary desc, linked_at, id`;
    return rows.map(toDto);
  }

  async me(ctx: AccountContext, wallets: WalletRow[] | null = null): Promise<MeResponse> {
    const walletDtos = wallets ? wallets.map(toDto) : await this.walletsOf(ctx.userId);
    const [auth] = await this.sql<{ email: string | null; email_confirmed_at: Date | null }[]>`
      select email, email_confirmed_at from auth.users where id = ${ctx.userId}`;
    const [ent] = await this.sql<
      { limits: Record<string, number>; features: Record<string, boolean> }[]
    >`
      select limits, features from entitlements where workspace_id = ${ctx.workspaceId}`;
    const [ws] = await this.sql<
      { plan: 'free' | 'pro' | 'team' }[]
    >`select plan from workspaces where id = ${ctx.workspaceId}`;
    const currentVersion = this.env.DISCLAIMER_VERSION;
    return {
      user: {
        id: ctx.userId,
        displayName: ctx.profile.displayName,
        locale: ctx.profile.locale,
        timezone: ctx.profile.timezone,
        createdAt: ctx.profile.createdAt.toISOString(),
      },
      wallets: walletDtos,
      email: auth?.email
        ? { address: auth.email, verified: auth.email_confirmed_at !== null }
        : null,
      workspace: { id: ctx.workspaceId, plan: ws?.plan ?? 'free' },
      entitlements: { limits: ent?.limits ?? {}, features: ent?.features ?? {} },
      disclaimer: {
        required: ctx.profile.disclaimerVersion !== currentVersion,
        currentVersion,
        acceptedVersion: ctx.profile.disclaimerVersion,
      },
      ageConfirmed: ctx.profile.ageConfirmedAt !== null,
    };
  }

  async emailStatus(userId: string): Promise<{ linked: boolean; verified: boolean }> {
    const [row] = await this.sql<{ email: string | null; email_confirmed_at: Date | null }[]>`
      select email, email_confirmed_at from auth.users where id = ${userId}`;
    return { linked: Boolean(row?.email), verified: row?.email_confirmed_at != null };
  }

  async patchMe(
    userId: string,
    patch: {
      displayName?: string | null | undefined;
      locale?: string | undefined;
      timezone?: string | undefined;
    },
  ): Promise<void> {
    if (patch.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: patch.timezone });
      } catch {
        throw new ApiProblemError('VALIDATION_FAILED', 'Unknown time zone.', {
          issues: [{ path: 'timezone', code: 'invalid', message: 'not an IANA time zone' }],
        });
      }
    }
    await this.sql`
      update profiles set
        display_name = case when ${patch.displayName !== undefined} then ${patch.displayName ?? null} else display_name end,
        locale = coalesce(${patch.locale ?? null}, locale),
        timezone = coalesce(${patch.timezone ?? null}, timezone)
       where id = ${userId}`;
  }

  async acceptDisclaimer(userId: string, version: string): Promise<void> {
    if (version !== this.env.DISCLAIMER_VERSION) {
      throw new ApiProblemError('CONFLICT', 'That is not the current disclaimer version.', {
        currentVersion: this.env.DISCLAIMER_VERSION,
      });
    }
    await this
      .sql`update profiles set disclaimer_accepted_at = now(), disclaimer_version = ${version} where id = ${userId}`;
  }

  async confirmAge(userId: string): Promise<void> {
    await this
      .sql`update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()) where id = ${userId}`;
  }

  // ---- wallets

  /** Refuses to remove the only way to sign in: another wallet, or an email/other provider identity, must remain. */
  async unlinkWallet(userId: string, walletId: string, ip: string | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      const [w] = await db<WalletRow[]>`
        select id, chain, address_norm, address_display, is_primary, linked_at
          from wallet_identities where id = ${walletId} and user_id = ${userId} and unlinked_at is null for update`;
      if (!w) throw new ApiProblemError('NOT_FOUND', 'No such wallet.');
      const [others] = await db<{ wallets: number; other_methods: number }[]>`
        select (select count(*)::int from wallet_identities where user_id = ${userId} and unlinked_at is null and id <> ${walletId}) as wallets,
               (select count(*)::int from auth.identities where user_id = ${userId} and provider not in ('web3', 'ethereum', 'solana')) as other_methods`;
      if ((others?.wallets ?? 0) + (others?.other_methods ?? 0) === 0) {
        throw new ApiProblemError('LAST_LOGIN_METHOD', 'This is the only way you can sign in.');
      }
      await db`update wallet_identities set unlinked_at = now(), is_primary = false where id = ${walletId}`;
      // The wallet must also stop being a sign-in method, or the next /v1/me would mirror it again.
      await db`
        delete from auth.identities
         where user_id = ${userId} and provider in ('web3', 'ethereum', 'solana')
           and (lower(coalesce(identity_data #>> '{custom_claims,address}', identity_data ->> 'address', '')) = ${w.address_norm.toLowerCase()}
                or coalesce(identity_data #>> '{custom_claims,address}', identity_data ->> 'address', '') = ${w.address_norm})`;
      if (w.is_primary) {
        await db`
          update wallet_identities set is_primary = true
           where id = (select id from wallet_identities where user_id = ${userId} and unlinked_at is null order by linked_at, id limit 1)`;
      }
      await this.audit(userId, null, 'wallet.unlink', w.chain, ip, {}, db);
    });
  }

  async setPrimary(userId: string, walletId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const db = tx as unknown as Sql;
      const [w] = await db<{ id: string }[]>`
        select id from wallet_identities where id = ${walletId} and user_id = ${userId} and unlinked_at is null for update`;
      if (!w) throw new ApiProblemError('NOT_FOUND', 'No such wallet.');
      await db`update wallet_identities set is_primary = false where user_id = ${userId} and is_primary`;
      await db`update wallet_identities set is_primary = true where id = ${walletId}`;
    });
  }
}
