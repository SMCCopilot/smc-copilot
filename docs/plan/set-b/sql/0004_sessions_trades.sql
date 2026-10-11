-- 0004_sessions_trades.sql
-- Risk profile, sessions, Explain requests, voice metadata, execution gate, trades, journal
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.
-- NOTHING in this file can hold a screen frame, an uploaded image or audio: there is no bytea/blob column for them (A02 section 3.5).

create table risk_profiles (
  workspace_id          uuid primary key references workspaces(id) on delete cascade,
  account_currency      text not null default 'USD',      -- display unit for sizing; stablecoin accounts use USD
  balance               numeric(16,2),
  risk_per_trade_pct    numeric(5,2) not null default 1.00 check (risk_per_trade_pct > 0 and risk_per_trade_pct <= 10),
  max_risk_per_trade_pct numeric(5,2) not null default 2.00,
  daily_loss_limit_pct  numeric(5,2),
  weekly_loss_limit_pct numeric(5,2),
  max_open_risk_pct     numeric(5,2),
  default_leverage      numeric(6,2) check (default_leverage is null or default_leverage >= 1),   -- perps; drives LIQUIDATION_BEFORE_STOP (A04)
  taker_fee_bps         numeric(6,2) not null default 5.00 check (taker_fee_bps >= 0),
  updated_at            timestamptz not null default now()
);

create table copilot_sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references profiles(id),
  instrument_id uuid references instruments(id),
  tf            text,
  strategy_version_id uuid references strategy_versions(id),
  mode          text not null default 'FEED' check (mode in ('FEED','APPROX')),
  context_source text not null default 'MANUAL' check (context_source in ('MANUAL','OCR','VISION')),
  capture_surface text check (capture_surface in ('TAB','WINDOW','SCREEN','NONE')),
  state         text not null default 'CREATED' check (state in ('CREATED','ACTIVE','PAUSED','ENDED')),
  last_seq      bigint not null default 0,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  end_reason    text,
  -- counters only (no frames, no audio are ever stored)
  frames_sampled   integer not null default 0,
  ocr_hints        integer not null default 0,
  explain_count    integer not null default 0,
  voice_utterances integer not null default 0,
  ai_calls_count   integer not null default 0,
  ai_cost_usd      numeric(10,4) not null default 0,
  client_info   jsonb                              -- UA family, WebGPU yes/no, STT engine chosen; no fingerprinting fields
);
create index on copilot_sessions (workspace_id, started_at desc);
create index on copilot_sessions (user_id, state);

create table session_events (                    -- ordered event log for resume (A02 section 4); 7-day retention
  session_id uuid not null references copilot_sessions(id) on delete cascade,
  seq        bigint not null,
  type       text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);

create table session_setup_views (               -- what this user was actually shown (journal basis)
  session_id    uuid not null references copilot_sessions(id) on delete cascade,
  setup_id      uuid not null references setups(id),
  first_shown_at timestamptz not null default now(),
  last_state    text not null,
  primary key (session_id, setup_id)
);

-- "Explain this chart" requests (A02 section 3.4-3.6, A05 section 8). Metadata and the text answer only; never the image.
create table explain_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references profiles(id),
  session_id    uuid references copilot_sessions(id) on delete set null,   -- NULL for one-shot POST /v1/explain
  source        text not null check (source in ('SHARE','UPLOAD')),
  mode          text not null check (mode in ('GROUNDED','APPROXIMATE')),
  input_mode    text not null default 'TEXT' check (input_mode in ('TEXT','VOICE')),
  instrument_id uuid references instruments(id),
  symbol_text   text,                              -- what the chart said, as read (e.g. 'BTCUSDT.P'); short text
  tf            text,
  resolved_by   text check (resolved_by in ('OCR','PICKER','VISION')),
  feed_match    text check (feed_match in ('MATCH','MISMATCH','UNVERIFIED')),
  feed_delta_pct numeric(8,4),
  image_bytes   integer,                           -- size only
  image_width   smallint,
  image_height  smallint,
  question      text,                              -- optional user question (typed or voice transcript)
  facts_hash    text,
  output        jsonb,                             -- ExplainOutput after id->number substitution (A05 section 5); 90-day retention
  read_call_id  uuid,                              -- ai_calls.id for J1 (no FK: ai_calls is partitioned and expires sooner)
  write_call_id uuid,                              -- ai_calls.id for J7
  cost_usd      numeric(10,6) not null default 0,
  latency_ms    integer,
  outcome       text not null check (outcome in ('OK','OK_APPROXIMATE','NOT_A_CHART','FEED_MISMATCH','BUDGET_BLOCKED','RATE_LIMITED','GUARDRAIL_REJECTED','ERROR','TIMEOUT')),
  created_at    timestamptz not null default now()
);
create index on explain_requests (workspace_id, created_at desc);
create index on explain_requests (created_at);

-- Voice metadata (A02 section 6). No audio, no transcript text here: the transcript, if kept, is a chat message.
create table voice_events (
  id            bigserial primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references profiles(id),
  session_id    uuid references copilot_sessions(id) on delete set null,
  at            timestamptz not null default now(),
  engine        text not null check (engine in ('whisper-web','moonshine-web','parakeet-server','whispercpp-server','typed')),
  duration_ms   integer,
  latency_ms    integer,
  confidence    real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  language      text,
  outcome       text not null check (outcome in ('OK','LOW_CONFIDENCE','NO_SPEECH','FORBIDDEN_BY_VOICE','CLARIFY','ERROR')),
  route         text check (route in ('COMMAND','QUESTION','EXPLAIN')),
  command_id    text,                              -- e.g. 'explain_chart','mute','next_setup'
  error_code    text
);
create index on voice_events (workspace_id, at desc);
create index on voice_events (at);

create table gate_decisions (                    -- A04 section 11.1: single-use, 60 s, plan-hash-bound
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id),
  plan_id      uuid not null references trade_plans(id),
  plan_hash    text not null,
  token_hash   text not null unique,             -- store hash only, never the token
  action       text not null default 'ISSUED' check (action in ('ISSUED','CONFIRMED','DECLINED','EXPIRED','VOIDED')),
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  decided_at   timestamptz,
  confirmed_via text check (confirmed_via = 'UI_TAP'),   -- the database itself refuses any other channel: voice can never confirm
  void_reason  text,
  check (expires_at <= issued_at + interval '120 seconds'),
  check (action <> 'CONFIRMED' or coalesce(confirmed_via = 'UI_TAP' and decided_at is not null, false))   -- NULL-safe: CONFIRMED needs a UI tap and a decision time
);
create index on gate_decisions (plan_id);

create table trade_records (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references profiles(id),
  plan_id       uuid references trade_plans(id),
  setup_id      uuid references setups(id),
  gate_id       uuid references gate_decisions(id),
  source        text not null default 'MANUAL' check (source in ('MANUAL','EXCHANGE_READONLY','ONCHAIN_READONLY','ROUTED')),
  wallet_id     uuid references wallet_identities(id),      -- for ONCHAIN_READONLY / wallet-signed routing
  external_ref  text,                                       -- exchange order id or tx hash
  instrument_id uuid not null references instruments(id),
  direction     text not null check (direction in ('LONG','SHORT')),
  leverage      numeric(6,2),
  stop_price    numeric(20,8),
  targets       numeric(20,8)[],
  status        text not null default 'OPEN' check (status in ('OPEN','CLOSED','CANCELLED')),
  close_reason  text check (close_reason in ('TP','SL','MANUAL','LIQUIDATED','EXPIRED','UNKNOWN')),
  realized_r    numeric(8,3),
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  notes         text
);
create index on trade_records (workspace_id, status, opened_at desc);

create table trade_fills (
  id        bigserial primary key,
  trade_id  uuid not null references trade_records(id) on delete cascade,
  side      text not null check (side in ('ENTRY','EXIT')),
  fill_time timestamptz not null,
  price     numeric(20,8) not null,
  size      numeric(24,8) not null,
  fee       numeric(24,8),
  fee_asset text
);

create table position_events (
  id        bigserial primary key,
  trade_id  uuid not null references trade_records(id) on delete cascade,
  type      text not null,                       -- near_stop, near_target, tp_hit, sl_hit, thesis_degraded, invalidated, stale_data, liquidation_risk
  at_candle timestamptz,
  payload   jsonb,
  created_at timestamptz not null default now()
);

create table journal_entries (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id),
  session_id   uuid references copilot_sessions(id) on delete set null,
  setup_id     uuid references setups(id) on delete set null,
  plan_id      uuid references trade_plans(id) on delete set null,
  trade_id     uuid references trade_records(id) on delete set null,
  explain_id   uuid references explain_requests(id) on delete set null,
  kind         text not null check (kind in ('SETUP_SHOWN','SETUP_REJECTED','GATE','TRADE','NOTE','AI_REVIEW','EXPLAIN')),
  notes        text,
  tags         text[] not null default '{}',
  payload      jsonb,                            -- plan snapshot, reason codes. Never an image or audio reference (zero retention)
  created_at   timestamptz not null default now()
);
create index on journal_entries (workspace_id, created_at desc);
create index on journal_entries using gin (tags);
