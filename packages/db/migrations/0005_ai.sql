-- 0005_ai.sql
-- AI calls (partitioned), shared narratives, chat, budget ledger, eval runs
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.

create table ai_calls (
  id            uuid not null default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  workspace_id  uuid references workspaces(id) on delete set null,
  user_id       uuid,
  session_id    uuid,
  correlation_id text,
  job           text not null check (job in ('J1_IMAGE_READ','J2_NARRATIVE','J3_CHAT','J4_REJECT_EXPLAIN','J5_REVIEW','J6_ROUTER','J7_EXPLAIN','J8_EVAL_JUDGE')),
  data_class    text not null default 'D0' check (data_class in ('D0','D1','D2')),   -- A05 section 12.2: decides which providers may see the request
  provider      text not null,
  model         text not null,
  prompt_version text not null,
  facts_hash    text,
  tokens_in     integer, tokens_out integer, tokens_cached_in integer, tokens_cache_write integer,
  cost_usd      numeric(10,6) not null default 0,
  latency_ms    integer,
  outcome       text not null check (outcome in ('OK','SCHEMA_RETRY','TEMPLATE_FALLBACK','GUARDRAIL_REJECTED','PROVIDER_BLOCKED_BY_POLICY','ERROR','TIMEOUT','RATE_LIMITED','BUDGET_BLOCKED')),
  error_code    text,
  primary key (id, created_at)
) partition by range (created_at);
create index on ai_calls (workspace_id, created_at desc);
create index on ai_calls (job, created_at desc);
-- monthly partitions, retention 90 days (drop old partitions)
create or replace function ensure_ai_calls_partition(month_start date) returns void
language plpgsql as $$
declare
  part_name text := format('ai_calls_%s', to_char(month_start, 'YYYY_MM'));
  next_month date := (month_start + interval '1 month')::date;
begin
  if to_regclass(part_name) is null then
    execute format('create table %I partition of ai_calls for values from (%L) to (%L)',
                   part_name, month_start, next_month);
    execute format('alter table %I enable row level security', part_name);
  end if;
end $$;
select ensure_ai_calls_partition(date_trunc('month', now() + (n || ' month')::interval)::date)
from generate_series(0, 3) n;

create table narratives (                        -- shared across users (A05 section 9.1)
  id             uuid primary key default gen_random_uuid(),
  instrument_id  uuid not null references instruments(id),
  facts_hash     text not null,
  prompt_version text not null,
  language       text not null default 'en',
  source         text not null check (source in ('LLM','TEMPLATE')),
  model          text,
  content        jsonb not null,                 -- NarrativeOutput after substitution
  created_at     timestamptz not null default now(),
  unique (instrument_id, facts_hash, prompt_version, language)
);

create table chat_threads (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id),
  session_id   uuid references copilot_sessions(id) on delete set null,
  title        text,
  summary      text,                             -- rolling summary (A05 section 7)
  created_at   timestamptz not null default now()
);
create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_threads(id) on delete cascade,
  role        text not null check (role in ('user','assistant','system_note')),
  content     text not null,
  meta        jsonb,                              -- ChatMeta, refs_used, scope
  facts_hash  text,
  input_mode  text not null default 'TEXT' check (input_mode in ('TEXT','VOICE')),
  stt_engine  text check (stt_engine in ('whisper-web','moonshine-web','parakeet-server','whispercpp-server','typed')),
  stt_confidence real check (stt_confidence is null or (stt_confidence >= 0 and stt_confidence <= 1)),
  created_at  timestamptz not null default now(),
  retracted   boolean not null default false
);
create index on chat_messages (thread_id, created_at);

create table ai_budget_ledger (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day          date not null,
  cost_usd     numeric(10,4) not null default 0,
  calls        integer not null default 0,
  primary key (workspace_id, day)
);

create table eval_runs (
  id          uuid primary key default gen_random_uuid(),
  suite       text not null,                      -- 'ocr','stt','image_read','narrative','explain','chat_redteam','latency'
  git_sha     text,
  prompt_version text,
  model       text,
  metrics     jsonb not null,
  passed      boolean not null,
  created_at  timestamptz not null default now()
);


-- Hard backstop against free-account abuse (A05 section 9.3, A08 section 2): one row per UTC day
create table ai_global_ledger (
  day         date primary key,
  cost_usd    numeric(12,4) not null default 0,
  calls       integer not null default 0,
  cap_usd     numeric(12,2) not null,            -- copied from config at first write of the day
  tripped_at  timestamptz                         -- when the cap was hit; AI features degrade to templates until the next UTC day
);
