-- 0011_forex_enable.sql  (UPGRADE M10-B, not part of the MVP and NOT applied until gate G7 passes: a forex data licence you approved)
-- Purely additive except for one relaxed CHECK on venues.kind. Crypto rows, engine golden datasets and the licence view are untouched.
-- The provider id below is a PLACEHOLDER: replace 'FX_PROVIDER' / 'fx-provider' with the vendor chosen at G7 (A03 section 2.4).

-- 11.1 Allow a real forex data venue next to the disabled stub
alter table venues drop constraint if exists venues_kind_check;
alter table venues add constraint venues_kind_check check (kind in ('CEX','FX_STUB','FX_DATA'));

-- 11.2 Forex week calendar: open Sunday 17:00 New York to Friday 17:00 New York; the daily rollover follows New York time (DST-aware),
--      so it is a calendar rule, not the fixed UTC hour that day_rollover_hour can express. aggregate() reads this rule (B06 section 3).
insert into market_calendars (id, tz, definition) values
 ('FX_24_5', 'America/New_York',
  '{"type":"weekly","open":{"day":"SUN","time":"17:00"},"close":{"day":"FRI","time":"17:00"},"rollover":{"tz":"America/New_York","hour":17},"holidays":[]}')
on conflict (id) do nothing;

-- 11.3 The forex venue starts INTERNAL_ONLY like every other venue: no venue_terms row, no raw price egress.
insert into venues (id, name, kind, analysis_enabled, crosscheck_enabled, enabled, provider_id, notes) values
 ('FX_PROVIDER', 'Forex data provider (placeholder)', 'FX_DATA', false, false, false, 'fx-provider',
  'Enabled by the forex migration after gate G7; analysis_enabled flips on only when counsel and the licence allow')
on conflict (id) do nothing;

-- 11.4 Instruments (examples). Forex spot uses market_type SPOT; pip_size is set; volume is tick volume (see candles.volume_kind).
insert into instruments (venue_id, market_type, canonical, venue_symbol, display, asset_class, base, quote,
                         price_precision, tick_size, lot_size, pip_size, calendar_id, day_rollover_hour, license_class, attribution, active)
values
 ('FX_PROVIDER','SPOT','FX_PROVIDER:SPOT:EURUSD','EUR/USD','EUR/USD','FX','EUR','USD',5,0.00001,1000,0.0001,'FX_24_5',21,'INTERNAL_ONLY','Market data: provider',false),
 ('FX_PROVIDER','SPOT','FX_PROVIDER:SPOT:XAUUSD','XAU/USD','Gold / USD','FX','XAU','USD',2,0.01,1,0.1,'FX_24_5',21,'INTERNAL_ONLY','Market data: provider',false)
on conflict (canonical) do nothing;
-- day_rollover_hour = 21 is the winter UTC value only; DST-correct rollover comes from the calendar rule above.

-- 11.5 Feature flags: forex stays dark until the engine golden tests, outcome studies and licence are done
insert into feature_flags (key, enabled, rollout_pct) values ('fx.enabled', false, 0), ('engine.fx_templates', false, 0)
on conflict (key) do nothing;
