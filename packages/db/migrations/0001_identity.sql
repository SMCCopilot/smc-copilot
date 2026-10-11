-- 0001_identity.sql
-- Profiles, wallet identities, workspaces, membership, entitlements, invites, address blocklist, signup trigger
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.

-- 1.1 Users. Supabase Auth owns auth.users (wallet sign-in creates the row; email is optional and may be NULL).
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,                          -- NULL for wallet-only users; UI shows a shortened address
  locale        text not null default 'en',
  timezone      text not null default 'UTC',
  disclaimer_accepted_at timestamptz,          -- A09: must be set before first session
  disclaimer_version     text,
  age_confirmed_at       timestamptz,          -- 18+ self-attestation (A09 section 4.3)
  invite_redeemed_at     timestamptz,          -- closed-beta / Sybil gate; API refuses feature endpoints until set
  blocked_at    timestamptz,                   -- sanctions or abuse block (A09, A08 section 2)
  block_reason  text,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- 1.2 Wallets mirrored from Supabase Auth so identity is portable and queryable (A01 section 5.4).
-- Written by the API on first authenticated request after verifying the Supabase JWT/identity (idempotent upsert).
create table wallet_identities (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  chain         text not null check (chain in ('evm','solana')),
  address_norm  text not null,                 -- evm: lowercase 0x + 40 hex; solana: base58 as-is (case-sensitive)
  address_display text not null,               -- EIP-55 checksum form for evm; same as norm for solana
  is_primary    boolean not null default false,
  linked_at     timestamptz not null default now(),
  last_login_at timestamptz,
  unlinked_at   timestamptz,
  check (
    (chain = 'evm'    and address_norm ~ '^0x[0-9a-f]{40}$') or
    (chain = 'solana' and address_norm ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  )
);
create unique index wallet_identities_addr_uq on wallet_identities (chain, address_norm) where unlinked_at is null;
create unique index wallet_identities_one_primary on wallet_identities (user_id) where is_primary and unlinked_at is null;
create index on wallet_identities (user_id);

-- 1.3 Sanctions / abuse blocklist (public lists such as OFAC SDN digital-currency addresses are loaded by a job; A09)
create table address_blocklist (
  chain         text not null check (chain in ('evm','solana')),
  address_norm  text not null,
  source        text not null,                 -- 'OFAC_SDN','MANUAL'
  listed_at     timestamptz not null default now(),
  note          text,
  primary key (chain, address_norm)
);

create table workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'personal' check (kind in ('personal','team')),
  owner_id   uuid not null references profiles(id),
  plan       text not null default 'free' check (plan in ('free','pro','team')),
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','admin','member')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on workspace_members (user_id);

-- Feature entitlements resolved from plan + overrides (read by API on session start)
create table entitlements (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  limits       jsonb not null default '{}',     -- see handle_new_user for the free-tier defaults
  features     jsonb not null default '{}',
  updated_at   timestamptz not null default now()
);

-- Helper used by RLS policies
create or replace function is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

-- Auto-create profile + personal workspace on signup (wallet sign-in has no email; that is fine)
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into profiles (id, display_name)
  values (new.id, nullif(coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email,''),'@',1)), ''));
  insert into workspaces (name, kind, owner_id) values ('Personal', 'personal', new.id) returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  insert into entitlements (workspace_id, limits, features) values (ws,
    '{"session_hours_per_month":30,"chat_per_day":40,"explain_per_day":3,"voice_per_day":60,"daily_ai_budget_usd":0.05,"max_instruments":4,"concurrent_sessions":1}',
    '{"beta":true,"voice":true,"explain":true,"approx_mode":true,"exchange_readonly":false}');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- 1.4 Closed-beta invite codes (first Sybil defense; A08 section 2)
create table invite_codes (
  code        text primary key,
  note        text,
  max_uses    integer not null default 1 check (max_uses > 0),
  uses        integer not null default 0 check (uses >= 0),
  expires_at  timestamptz,
  grants      jsonb not null default '{"daily_ai_budget_usd":1.00}',   -- merged into the redeemer's personal entitlements.limits (invited testers need more than the tiny public free budget)
  created_at  timestamptz not null default now(),
  check (uses <= max_uses)
);
create table invite_redemptions (
  code        text not null references invite_codes(code),
  user_id     uuid not null references profiles(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

-- Atomic redemption used by POST /v1/me/invite. Returns true if redeemed (or already redeemed by this user).
create or replace function redeem_invite(p_code text, p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean := false;
begin
  if exists (select 1 from invite_redemptions where code = p_code and user_id = p_user) then
    return true;
  end if;
  update invite_codes set uses = uses + 1
   where code = p_code and uses < max_uses and (expires_at is null or expires_at > now())
   returning true into ok;
  if coalesce(ok, false) then
    insert into invite_redemptions (code, user_id) values (p_code, p_user);
    update profiles set invite_redeemed_at = now() where id = p_user;
    update entitlements e set limits = e.limits || (select grants from invite_codes where code = p_code), updated_at = now()
      from workspaces w where w.id = e.workspace_id and w.owner_id = p_user and w.kind = 'personal';
    return true;
  end if;
  return false;
end $$;
