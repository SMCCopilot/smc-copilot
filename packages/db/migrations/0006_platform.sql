-- 0006_platform.sql
-- Notifications, audit, flags, idempotency, setup displays, feedback, abuse flags
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id),
  channel      text not null check (channel in ('IN_APP','EMAIL','PUSH')),   -- EMAIL only if the user linked an email
  type         text not null,
  payload      jsonb not null,
  status       text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED','READ')),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index on notifications (user_id, status, created_at desc);

create table audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,
  workspace_id uuid,
  action       text not null,                      -- 'gate.confirm','wallet.link','wallet.unlink','exchange_key.add','plan.change','admin.flag','invoice.paid'
  target       text,
  ip           inet,
  detail       jsonb
);
create index on audit_log (workspace_id, at desc);

create table feature_flags (
  key        text primary key,
  enabled    boolean not null default false,
  rollout_pct smallint not null default 0 check (rollout_pct between 0 and 100),
  rules      jsonb,
  updated_at timestamptz not null default now()
);

create table idempotency_keys (                  -- A07 section 1; purge rows older than 24 h
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key          text not null,
  request_hash text not null,
  status       integer,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, key)
);
create index on idempotency_keys (created_at);

create table setup_displays (                    -- what base rate was shown with each setup (calibration input, migration 0007)
  setup_id   uuid not null references setups(id) on delete cascade,
  cohort_id  uuid not null references cohort_stats(id),
  rate       numeric(6,5) not null,
  ci_low     numeric(6,5) not null,
  ci_high    numeric(6,5) not null,
  shown_at   timestamptz not null default now(),
  primary key (setup_id, cohort_id)
);

create table user_feedback (
  id         uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id    uuid references profiles(id),
  target_type text not null,                        -- 'narrative','chat_message','setup'
  target_id  text not null,
  rating     smallint check (rating in (-1, 1)),
  comment    text,
  created_at timestamptz not null default now()
);


-- Temporary blocks from rate limiting and abuse detection. Subjects are HASHED (salted) values; raw IPs are not stored.
create table abuse_flags (
  id          bigserial primary key,
  subject_kind text not null check (subject_kind in ('IP_HASH','DEVICE_HASH','USER','WALLET')),
  subject_key text not null,
  reason      text not null,                      -- 'TURNSTILE_FAIL','SIGNUP_BURST','AI_BUDGET_ABUSE','SEED_PHRASE_PASTE_REPEAT'
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index on abuse_flags (subject_kind, subject_key, expires_at);
