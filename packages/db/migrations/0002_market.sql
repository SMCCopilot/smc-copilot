-- 0002_market.sql
-- Venues, licence terms, instruments (venue + market type + symbol), aliases, calendars, partitioned candles, data-quality tables
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.

create table venues (
  id            text primary key,                -- 'BINANCE','BYBIT','OKX','COINBASE','KRAKEN','FX_STUB'
  name          text not null,
  kind          text not null default 'CEX' check (kind in ('CEX','FX_STUB')),
  analysis_enabled boolean not null default false,   -- may a user session analyze charts on this venue?
  crosscheck_enabled boolean not null default false, -- used as a V7 cross-check source
  enabled       boolean not null default true,       -- kill switch (geo-block, terms problem)
  provider_id   text not null,                       -- adapter id in packages/market-data ('binance', ...)
  notes         text,
  created_at    timestamptz not null default now()
);

-- Evidence for the licence decision (A03 section 2.3, spike S5). No row => instruments stay INTERNAL_ONLY.
create table venue_terms (
  id            uuid primary key default gen_random_uuid(),
  venue_id      text not null references venues(id),
  url           text not null,
  retrieved_at  date not null,
  summary       text not null,
  decision      text not null check (decision in ('DISPLAY_OK','INTERNAL_ONLY','BYO_ONLY','PROHIBITED')),
  reviewer      text not null,
  reviewed_at   timestamptz not null default now(),
  counsel_reviewed boolean not null default false
);
create index on venue_terms (venue_id, reviewed_at desc);

create table market_calendars (
  id         text primary key,                  -- 'CRYPTO_24_7' (launch); 'FX_24_5' is added by the forex migration
  tz         text not null,
  definition jsonb not null                     -- weekly hours, maintenance windows, holidays
);

-- An instrument is a (venue, market type, symbol). BINANCE:SPOT:BTCUSDT and BINANCE:PERP:BTCUSDT are different series.
create table instruments (
  id              uuid primary key default gen_random_uuid(),
  venue_id        text not null references venues(id),
  market_type     text not null check (market_type in ('SPOT','PERP')),
  canonical       text not null unique,          -- 'BINANCE:PERP:BTCUSDT'
  venue_symbol    text not null,                 -- as the venue writes it: 'BTCUSDT','BTC-USD','BTC-USDT-SWAP','XBT/USD'
  display         text not null,                 -- 'BTC/USDT Perpetual'
  asset_class     text not null default 'CRYPTO' check (asset_class in ('CRYPTO','FX')),   -- FX is a seam, not served at launch
  base            text not null,
  quote           text not null,
  price_precision smallint not null,
  tick_size       numeric(20,10) not null,
  lot_size        numeric(24,10),
  pip_size        numeric(20,10),                -- forex seam, NULL for crypto
  calendar_id     text not null default 'CRYPTO_24_7' references market_calendars(id),
  day_rollover_hour smallint not null default 0 check (day_rollover_hour between 0 and 23),   -- UTC; crypto 1d opens 00:00 UTC
  license_class   text not null default 'INTERNAL_ONLY' check (license_class in ('INTERNAL_ONLY','DISPLAY_OK','BYO_ONLY')),
  attribution     text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (venue_id, market_type, venue_symbol)
);

-- Tick size / precision history: changed metadata writes a new row instead of editing history (A03 section 4.1)
create table instrument_versions (
  instrument_id   uuid not null references instruments(id) on delete cascade,
  valid_from      timestamptz not null,
  tick_size       numeric(20,10) not null,
  lot_size        numeric(24,10),
  price_precision smallint not null,
  primary key (instrument_id, valid_from)
);

-- Adapter routing: which provider serves an instrument (PRIMARY) and which peers cross-check it (CROSSCHECK, V7).
-- A CROSSCHECK row never writes candles; it names the peer venue symbol (same market type) to compare against.
create table instrument_aliases (
  id              uuid primary key default gen_random_uuid(),
  instrument_id   uuid not null references instruments(id) on delete cascade,
  provider_id     text not null,
  venue_symbol    text not null,
  market_type     text not null check (market_type in ('SPOT','PERP')),
  priority        smallint not null default 1,
  role            text not null default 'PRIMARY' check (role in ('PRIMARY','FALLBACK','CROSSCHECK')),
  unique (instrument_id, provider_id, role)
);
create index on instrument_aliases (instrument_id, role, priority);

-- Normalized strings from OCR / vision / manual input ('BTCUSDT', 'BTCUSDTP', 'XBTUSD', 'BITCOIN') used by the resolver (A03 section 4.2)
create table symbol_search_keys (
  key           text not null,
  instrument_id uuid not null references instruments(id) on delete cascade,
  weight        smallint not null default 1,
  primary key (key, instrument_id)
);

-- Effective licence: an instrument is only as open as its venue's recorded terms allow (A03 section 2.3)
create view instrument_license as
select i.id as instrument_id,
       case
         when v.enabled is false then 'INTERNAL_ONLY'
         when t.decision is null or t.decision = 'PROHIBITED' then 'INTERNAL_ONLY'
         when i.license_class = 'DISPLAY_OK' and t.decision = 'DISPLAY_OK' then 'DISPLAY_OK'
         when i.license_class = 'BYO_ONLY'   and t.decision in ('DISPLAY_OK','BYO_ONLY') then 'BYO_ONLY'
         else 'INTERNAL_ONLY'
       end as effective_class,
       (t.decision = 'PROHIBITED') as venue_prohibited
from instruments i
join venues v on v.id = i.venue_id
left join lateral (
  select decision from venue_terms vt where vt.venue_id = i.venue_id order by reviewed_at desc limit 1
) t on true;

-- Candles: shared scope uses the nil uuid; BYO-feed rows (forex later) use workspace_id as scope_id
create table candles (
  instrument_id uuid not null references instruments(id),
  tf            text not null check (tf in ('1m','5m','15m','30m','1h','4h','1d')),
  open_time     timestamptz not null,
  scope_id      uuid not null default '00000000-0000-0000-0000-000000000000',
  o numeric(20,8) not null, h numeric(20,8) not null, l numeric(20,8) not null, c numeric(20,8) not null,
  v             numeric(28,8),                  -- base-asset volume
  vq            numeric(28,8),                  -- quote-asset volume where the venue provides it
  volume_kind   text not null default 'REAL' check (volume_kind in ('REAL','TICK','NONE')),
  provider_id   text not null,
  status        text not null default 'CLOSED' check (status in ('CLOSED','INCOMPLETE')),
  flags         integer not null default 0,     -- bitmask: 1 SPIKE_SUSPECT, 2 CROSSCHECK_DIVERGENCE, 4 FLAT, 8 GAP_PRICE, 16 BACKFILLED
  ingested_at   timestamptz not null default now(),
  primary key (instrument_id, tf, scope_id, open_time),
  check (l <= least(o, c) and h >= greatest(o, c) and l > 0)
) partition by range (open_time);

-- Monthly partitions, created ahead by the worker (maintain_partitions in 0007); pg_cron is optional
create or replace function ensure_candle_partition(month_start date) returns void
language plpgsql as $$
declare
  part_name text := format('candles_%s', to_char(month_start, 'YYYY_MM'));
  next_month date := (month_start + interval '1 month')::date;
begin
  if to_regclass(part_name) is null then
    execute format('create table %I partition of candles for values from (%L) to (%L)',
                   part_name, month_start, next_month);
    execute format('alter table %I enable row level security', part_name);   -- partitions are tables too
  end if;
end $$;

-- Bootstrap: current month plus 3 ahead
select ensure_candle_partition(date_trunc('month', now() + (n || ' month')::interval)::date)
from generate_series(0, 3) n;

create table candle_quarantine (
  id            bigserial primary key,
  instrument_id uuid references instruments(id),
  provider_id   text not null,
  reason        text not null,                  -- BAD_OHLC, MISALIGNED, FUTURE_TS, CONFLICTING_DUPLICATE ...
  raw           jsonb not null,
  received_at   timestamptz not null default now()
);
create index on candle_quarantine (received_at);

create table candle_gaps (
  id            bigserial primary key,
  instrument_id uuid not null references instruments(id),
  tf            text not null,
  from_time     timestamptz not null,
  to_time       timestamptz not null,
  status        text not null default 'OPEN' check (status in ('OPEN','BACKFILLING','RESOLVED','UNRESOLVABLE')),
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  unique (instrument_id, tf, from_time, to_time)
);

create table dq_incidents (
  id            bigserial primary key,
  instrument_id uuid references instruments(id),
  venue_id      text references venues(id),
  rule          text not null,                  -- V1..V9, FEED_STALE, GEO_BLOCKED, WS_ROTATION_FAILED, ...
  details       jsonb,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz
);
create index on dq_incidents (opened_at desc);

create table feed_usage (                       -- audit for rate limits and terms questions (A03 section 2.3 rule 6)
  day         date not null,
  venue_id    text not null references venues(id),
  rest_requests integer not null default 0,
  ws_connects integer not null default 0,
  rate_limit_hits integer not null default 0,
  symbols     integer not null default 0,
  primary key (day, venue_id)
);
