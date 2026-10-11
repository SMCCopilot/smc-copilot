-- 0010_full_product_additions.sql  (UPGRADE, not part of the MVP)
-- Adds the Set A tables the MVP omitted: crypto billing, multi-worker stream leases, exchange read-only connections, outbox.
-- Purely additive: no changes to MVP tables. Apply at milestone M6 (public launch; see B06). RLS is enabled for the new tables as in 0008.

-- 10.1 Subscriptions: prepaid periods paid in stablecoin (no card processor, no auto-renew; A08 section 7)
create table subscriptions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  plan             text not null check (plan in ('pro','team')),
  status           text not null check (status in ('ACTIVE','EXPIRED','CANCELED','COMPED')),
  source           text not null default 'CRYPTO' check (source in ('CRYPTO','COMP')),
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  last_invoice_id  uuid,
  created_at       timestamptz not null default now(),
  check (period_end > period_start)
);
create index on subscriptions (workspace_id, period_end desc);

-- 10.2 Invoices. Matching (A08 section 7):
--   EVM:    one treasury address per chain (a wallet you control; no private key on the server) + an invoice-specific EXACT amount
--           (price plus a unique sub-cent suffix), unique among OPEN invoices (index below).
--   Solana: Solana Pay style reference key on one receiving address.   [verify both in spike S6]
--   derivation_index is reserved for a later per-invoice-address design if volume ever needs it; it stays NULL at launch.
create table invoices (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  user_id          uuid not null references profiles(id),
  plan             text not null check (plan in ('pro','team')),
  period_months    smallint not null check (period_months between 1 and 12),
  amount_usd       numeric(12,2) not null check (amount_usd > 0),
  chain_id         text not null,                   -- CAIP-2: 'eip155:8453' (Base), 'eip155:42161', 'solana:mainnet', ...
  asset            text not null check (asset in ('USDC','USDT')),
  asset_contract   text not null,                   -- token contract / mint address (pinned per chain in config)
  amount_atomic    numeric(38,0) not null check (amount_atomic > 0),
  pay_to           text not null,                   -- treasury / receiving address for the chain
  reference        text,                            -- Solana Pay reference public key
  derivation_index integer,                         -- reserved (NULL at launch)
  status           text not null default 'OPEN' check (status in ('OPEN','PAID','EXPIRED','UNDERPAID','OVERPAID','MANUAL_REVIEW')),
  expires_at       timestamptz not null,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (chain_id, pay_to, reference),
  unique (chain_id, derivation_index)
);
create index on invoices (workspace_id, created_at desc);
create index on invoices (status, expires_at);
create unique index invoices_open_amount_uq on invoices (chain_id, pay_to, amount_atomic) where status = 'OPEN';   -- two open invoices can never share an exact amount

create table onchain_payments (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid references invoices(id),    -- NULL = unmatched transfer, kept for manual review
  chain_id         text not null,
  tx_hash          text not null,
  log_index        integer not null default 0,      -- EVM Transfer log index; Solana instruction index
  from_address     text,
  to_address       text not null,
  asset_contract   text not null,
  amount_atomic    numeric(38,0) not null,
  block_number     bigint,
  block_time       timestamptz,
  confirmations    integer not null default 0,
  status           text not null default 'SEEN' check (status in ('SEEN','CONFIRMED','REORGED','IGNORED')),
  seen_at          timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);
create index on onchain_payments (invoice_id);

create table chain_cursors (                         -- watcher progress per chain, for restart and reorg handling
  chain_id        text primary key,
  last_block      bigint not null,
  last_block_hash text,
  updated_at      timestamptz not null default now()
);

alter table subscriptions add constraint subscriptions_last_invoice_fk foreign key (last_invoice_id) references invoices(id);

-- 10.3 Multi-worker ownership of market streams (A03 section 8)
create table stream_leases (
  stream_key  text primary key,                     -- 'BINANCE:PERP:BTCUSDT:1m'
  owner_id    text not null,
  expires_at  timestamptz not null
);

-- 10.4 L1 read-only exchange connections (A04 section 11). Read-only keys only; trade-only keys arrive with L2 (M9).
create table exchange_connections (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  venue_id         text not null references venues(id),
  scope            text not null check (scope in ('READ','TRADE')),
  label            text,
  secret_ciphertext bytea not null,                 -- envelope-encrypted (A08 section 2); decrypted only inside the worker
  key_id           text not null,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);
create index on exchange_connections (workspace_id) where revoked_at is null;

-- 10.5 Outbox (reliable event publishing from DB transactions; worker polls)
create table outbox (
  id         bigserial primary key,
  topic      text not null,
  key        text,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index on outbox (created_at) where processed_at is null;

-- RLS: server-only unless a tenant policy is added
alter table subscriptions        enable row level security;
alter table invoices             enable row level security;
alter table onchain_payments     enable row level security;
alter table chain_cursors        enable row level security;
alter table stream_leases        enable row level security;
alter table exchange_connections enable row level security;
alter table outbox               enable row level security;

create policy sub_read on subscriptions for select using (is_member(workspace_id));
create policy inv_read on invoices      for select using (is_member(workspace_id) and user_id = auth.uid());
