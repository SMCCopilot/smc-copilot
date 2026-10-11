-- 0003_engine.sql
-- Strategy versions, engine snapshots/events, setups, plans, outcomes, cohort stats
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.

create table strategy_versions (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,                 -- 'smc-core'
  version        integer not null,
  schema_version integer not null,
  config         jsonb not null,
  config_hash    text not null unique,
  status         text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','RETIRED')),
  notes          text,
  created_at     timestamptz not null default now(),
  unique (name, version)
);

-- Immutability: config can never change after insert
create or replace function forbid_config_update() returns trigger language plpgsql as $$
begin
  if new.config is distinct from old.config or new.config_hash is distinct from old.config_hash then
    raise exception 'strategy_versions.config is immutable; create a new version';
  end if;
  return new;
end $$;
create trigger strategy_versions_immutable before update on strategy_versions
  for each row execute function forbid_config_update();

create table engine_snapshots (
  instrument_id       uuid not null references instruments(id),
  strategy_version_id uuid not null references strategy_versions(id),
  as_of               timestamptz not null,
  state               jsonb not null,
  state_hash          text not null,
  created_at          timestamptz not null default now(),
  primary key (instrument_id, strategy_version_id, as_of)
);

create table engine_events (
  event_id            text primary key,         -- sha1(instrument|tf|type|anchor|strategy)
  instrument_id       uuid not null references instruments(id),
  strategy_version_id uuid not null references strategy_versions(id),
  tf                  text not null,
  type                text not null,            -- SWING_CONFIRMED, BOS_UP, CHOCH_DOWN, FVG_CREATED, OB_CREATED, LIQ_SWEEP, ...
  anchor_time         timestamptz not null,
  event_time          timestamptz not null,     -- candle close time when the event became known
  confirmed_at        timestamptz not null,
  payload             jsonb not null,
  revision            integer not null default 0,
  retracted           boolean not null default false,
  created_at          timestamptz not null default now()
);
create index on engine_events (instrument_id, strategy_version_id, event_time desc);
create index on engine_events (instrument_id, type, event_time desc);

create table setups (
  id                  uuid primary key default gen_random_uuid(),
  setup_key           text not null,            -- deterministic hash from A04 section 8.2
  strategy_version_id uuid not null references strategy_versions(id),
  instrument_id       uuid not null references instruments(id),
  template            text not null check (template in ('T1','T2','T3')),
  direction           text not null check (direction in ('LONG','SHORT')),
  entry_tf            text not null,
  bias_tf             text not null,
  state               text not null check (state in ('CANDIDATE','REJECTED','ARMED','TRIGGERED','EXPIRED','INVALIDATED','RESOLVED')),
  grade               text check (grade in ('A','B','C')),
  score               numeric(6,2),
  features            jsonb,                    -- per-feature contributions
  reason_codes        text[] not null default '{}',
  components          jsonb not null,           -- ids of swings/zones/pools used
  poi                 jsonb not null,
  invalidation        jsonb not null,
  data_provider_id    text,
  data_revised        boolean not null default false,
  created_at          timestamptz not null,     -- candle close time (not wall clock)
  armed_at            timestamptz,
  triggered_at        timestamptz,
  closed_at           timestamptz,
  unique (strategy_version_id, setup_key)
);
create index on setups (instrument_id, state, created_at desc);
create index on setups (strategy_version_id, template, grade, created_at desc);

create table setup_transitions (
  id          bigserial primary key,
  setup_id    uuid not null references setups(id) on delete cascade,
  from_state  text,
  to_state    text not null,
  at_candle   timestamptz not null,
  reason_codes text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index on setup_transitions (setup_id, at_candle);

create table trade_plans (
  id            uuid primary key default gen_random_uuid(),
  setup_id      uuid not null references setups(id) on delete cascade,
  plan_version  integer not null default 1,
  plan          jsonb not null,                 -- TradePlan (A04 section 10.2)
  plan_hash     text not null,                  -- used by gate token binding
  created_at    timestamptz not null default now(),
  unique (setup_id, plan_version)
);

create table setup_outcomes (                   -- shadow outcome for every ARMED setup (A04 section 13.2)
  setup_id              uuid primary key references setups(id) on delete cascade,
  outcome_rules_version text not null,
  outcome               text not null check (outcome in ('TP1_FIRST','SL_FIRST','INVALIDATED_BEFORE_FILL','EXPIRED_OPEN','NO_FILL')),
  filled                boolean not null,
  fill_time             timestamptz,
  fill_price            numeric(20,8),
  resolution_time       timestamptz,
  r_tp1                 numeric(8,3),
  r_tp2                 numeric(8,3),
  fees_r                numeric(8,3),            -- round-trip taker fees expressed in R (A04 section 13.2)
  realized_r            numeric(8,3),            -- net of fees_r
  mfe_r                 numeric(8,3),
  mae_r                 numeric(8,3),
  bars_to_resolution    integer,
  ambiguous_intrabar    boolean not null default false,
  data_revised          boolean not null default false,
  computed_at           timestamptz not null default now()
);

create table cohort_stats (                     -- base rates shown to users (A04 section 8.4)
  id                  uuid primary key default gen_random_uuid(),
  strategy_version_id uuid not null references strategy_versions(id),
  asset_class         text not null,
  template            text not null,
  grade               text not null,
  direction           text,                     -- null = both
  segment             text not null default 'ALL',  -- 'ALL' at launch; 'SPOT'/'PERP' once n allows splitting
  source              text not null check (source in ('LIVE_SHADOW','BACKTEST')),
  window_from         timestamptz not null,
  window_to           timestamptz not null,
  n                   integer not null,
  wins                integer not null,
  rate                numeric(6,5) not null,
  ci_low              numeric(6,5) not null,
  ci_high             numeric(6,5) not null,
  avg_r               numeric(8,3),
  median_mae_r        numeric(8,3),
  median_mfe_r        numeric(8,3),
  sufficient          boolean not null,
  status              text not null default 'ACTIVE' check (status in ('ACTIVE','UNDER_REVIEW')),
  computed_at         timestamptz not null default now(),
  unique nulls not distinct (strategy_version_id, asset_class, segment, template, grade, direction, source)   -- PG15+
);

create table calibration_reports (
  id                  uuid primary key default gen_random_uuid(),
  strategy_version_id uuid not null references strategy_versions(id),
  computed_at         timestamptz not null default now(),
  report              jsonb not null            -- reliability bins, Brier, log loss, drift vs backtest
);

create table backtest_runs (
  id                  uuid primary key default gen_random_uuid(),
  strategy_version_id uuid not null references strategy_versions(id),
  instrument_ids      uuid[] not null,
  data_from           timestamptz not null,
  data_to             timestamptz not null,
  split               jsonb not null,           -- tune / validate / final-test ranges
  trials_count        integer not null,         -- parameter variants tried (multiple-testing disclosure)
  criteria            jsonb not null,           -- pre-registered acceptance criteria
  results             jsonb,
  status              text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','DONE','FAILED')),
  created_at          timestamptz not null default now()
);


-- config_hash is computed by the database so the app and DB can never disagree (sha256 of jsonb text form)
create or replace function set_config_hash() returns trigger language plpgsql as $$
begin
  new.config_hash := encode(sha256(convert_to(new.config::text, 'UTF8')), 'hex');
  return new;
end $$;
create trigger strategy_versions_hash before insert on strategy_versions
  for each row execute function set_config_hash();
