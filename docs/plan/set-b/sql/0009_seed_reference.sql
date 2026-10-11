-- 0009_seed_reference.sql
-- Reference data: calendar, venues, instruments, aliases, search keys, first strategy version, flags, sample invite
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.


-- Calendar (crypto trades 24/7; the FX calendar arrives with the forex migration) ------------------------------
insert into market_calendars (id, tz, definition) values
 ('CRYPTO_24_7', 'UTC', '{"type":"always_open"}')
on conflict (id) do nothing;

-- Venues. Everything starts INTERNAL_ONLY: no venue_terms row exists until spike S5 records a decision (A03 section 2.3).
insert into venues (id, name, kind, analysis_enabled, crosscheck_enabled, provider_id, notes) values
 ('BINANCE',  'Binance',  'CEX', true,  true,  'binance',  'Primary. Use data-stream.binance.vision; blocks US IPs, host outside the US'),
 ('BYBIT',    'Bybit',    'CEX', false, true,  'bybit',    'Cross-check at MVP; analysis venue promoted at public launch if users chart there'),
 ('OKX',      'OKX',      'CEX', false, false, 'okx',      'Cross-check, adapter arrives in M6 (set crosscheck_enabled = true then); verify candle WS host in spike S2'),
 ('COINBASE', 'Coinbase', 'CEX', false, false, 'coinbase', 'USD spot cross-check, adapter arrives in M6; 1m candles come from REST polling'),
 ('KRAKEN',   'Kraken',   'CEX', false, false, 'kraken',   'USD spot cross-check, adapter arrives in M6; XBT is BTC'),
 ('FX_STUB',  'Forex (not enabled)', 'FX_STUB', false, false, 'fx-stub', 'Seam only: adapter throws NOT_ENABLED')
on conflict (id) do nothing;
update venues set enabled = false where id = 'FX_STUB';

-- Core universe at MVP: BTC, ETH, SOL on Binance spot and perp, plus Bybit as the one MVP cross-check venue for BTC and ETH perps.
-- Coinbase, Kraken and OKX rows exist so the seam is visible, but their adapters (and crosscheck_enabled) arrive in M6.
-- voice.server_stt and explain.approximate are OFF in the MVP (A10 section 1.1) and switch on when those features ship.
-- tick_size / precision below are placeholders: the worker overwrites them from each venue's instruments endpoint at boot [verify per venue].
insert into instruments (venue_id, market_type, canonical, venue_symbol, display, base, quote, price_precision, tick_size, lot_size, license_class, attribution) values
 ('BINANCE','SPOT','BINANCE:SPOT:BTCUSDT','BTCUSDT','BTC/USDT',        'BTC','USDT',2,0.01,0.00001,'DISPLAY_OK','Market data: Binance'),
 ('BINANCE','PERP','BINANCE:PERP:BTCUSDT','BTCUSDT','BTC/USDT Perpetual','BTC','USDT',1,0.1, 0.001,  'DISPLAY_OK','Market data: Binance'),
 ('BINANCE','SPOT','BINANCE:SPOT:ETHUSDT','ETHUSDT','ETH/USDT',        'ETH','USDT',2,0.01,0.0001, 'DISPLAY_OK','Market data: Binance'),
 ('BINANCE','PERP','BINANCE:PERP:ETHUSDT','ETHUSDT','ETH/USDT Perpetual','ETH','USDT',2,0.01,0.001,  'DISPLAY_OK','Market data: Binance'),
 ('BINANCE','SPOT','BINANCE:SPOT:SOLUSDT','SOLUSDT','SOL/USDT',        'SOL','USDT',2,0.01,0.001,  'DISPLAY_OK','Market data: Binance'),
 ('BINANCE','PERP','BINANCE:PERP:SOLUSDT','SOLUSDT','SOL/USDT Perpetual','SOL','USDT',3,0.001,0.1,  'DISPLAY_OK','Market data: Binance'),
 ('BYBIT','PERP','BYBIT:PERP:BTCUSDT','BTCUSDT','BTC/USDT Perpetual','BTC','USDT',2,0.1,0.001,'INTERNAL_ONLY','Market data: Bybit'),
 ('BYBIT','PERP','BYBIT:PERP:ETHUSDT','ETHUSDT','ETH/USDT Perpetual','ETH','USDT',2,0.01,0.01,'INTERNAL_ONLY','Market data: Bybit'),
 ('COINBASE','SPOT','COINBASE:SPOT:BTC-USD','BTC-USD','BTC/USD','BTC','USD',2,0.01,0.00000001,'INTERNAL_ONLY','Market data: Coinbase'),
 ('COINBASE','SPOT','COINBASE:SPOT:ETH-USD','ETH-USD','ETH/USD','ETH','USD',2,0.01,0.00000001,'INTERNAL_ONLY','Market data: Coinbase'),
 ('KRAKEN','SPOT','KRAKEN:SPOT:XBT/USD','XBT/USD','BTC/USD','BTC','USD',1,0.1,0.00000001,'INTERNAL_ONLY','Market data: Kraken')
on conflict (canonical) do nothing;
-- NOTE: Binance rows say DISPLAY_OK as the *intent*; the view instrument_license downgrades them to INTERNAL_ONLY until a
-- venue_terms row with decision DISPLAY_OK exists. Raw-price egress follows the view, never this column on its own.

-- Adapter routing. PRIMARY = the instrument's own venue adapter. CROSSCHECK = same market type on another venue (rule V7).
insert into instrument_aliases (instrument_id, provider_id, venue_symbol, market_type, priority, role)
select i.id, v.provider_id, i.venue_symbol, i.market_type, 1, 'PRIMARY'
from instruments i join venues v on v.id = i.venue_id;

insert into instrument_aliases (instrument_id, provider_id, venue_symbol, market_type, priority, role)
select i.id, x.provider_id, x.venue_symbol, x.market_type, 2, 'CROSSCHECK'
from (values
  ('BINANCE:PERP:BTCUSDT','bybit','BTCUSDT','PERP'),
  ('BINANCE:PERP:ETHUSDT','bybit','ETHUSDT','PERP'),
  ('BINANCE:PERP:BTCUSDT','okx','BTC-USDT-SWAP','PERP'),
  ('BINANCE:PERP:ETHUSDT','okx','ETH-USDT-SWAP','PERP'),
  ('BINANCE:SPOT:BTCUSDT','coinbase','BTC-USD','SPOT'),
  ('BINANCE:SPOT:ETHUSDT','coinbase','ETH-USD','SPOT'),
  ('BINANCE:SPOT:BTCUSDT','kraken','XBT/USD','SPOT')
) as x(canonical, provider_id, venue_symbol, market_type)
join instruments i on i.canonical = x.canonical
on conflict (instrument_id, provider_id, role) do nothing;

-- Search keys for the resolver: uppercase, no separators, no venue prefix (A03 section 4.2). The resolver also scores venue text,
-- perp markers ('.P', 'PERP', 'Perpetual Contract') and last-price proximity; these keys only produce candidates.
insert into symbol_search_keys (key, instrument_id, weight)
select k.key, i.id, k.weight
from (values
  ('BTCUSDT','BINANCE:SPOT:BTCUSDT',10),('BTCUSD','BINANCE:SPOT:BTCUSDT',6),('BTC','BINANCE:SPOT:BTCUSDT',4),('BITCOIN','BINANCE:SPOT:BTCUSDT',4),
  ('BTCUSDT','BINANCE:PERP:BTCUSDT',9),('BTCUSDTP','BINANCE:PERP:BTCUSDT',10),('BTCPERP','BINANCE:PERP:BTCUSDT',8),('XBTUSDT','BINANCE:PERP:BTCUSDT',5),
  ('ETHUSDT','BINANCE:SPOT:ETHUSDT',10),('ETHUSD','BINANCE:SPOT:ETHUSDT',6),('ETH','BINANCE:SPOT:ETHUSDT',4),('ETHEREUM','BINANCE:SPOT:ETHUSDT',4),
  ('ETHUSDT','BINANCE:PERP:ETHUSDT',9),('ETHUSDTP','BINANCE:PERP:ETHUSDT',10),
  ('SOLUSDT','BINANCE:SPOT:SOLUSDT',10),('SOL','BINANCE:SPOT:SOLUSDT',4),('SOLANA','BINANCE:SPOT:SOLUSDT',4),
  ('SOLUSDT','BINANCE:PERP:SOLUSDT',9),('SOLUSDTP','BINANCE:PERP:SOLUSDT',10),
  ('BTCUSDT','BYBIT:PERP:BTCUSDT',8),('BTCUSDTP','BYBIT:PERP:BTCUSDT',9),
  ('ETHUSDT','BYBIT:PERP:ETHUSDT',8),('ETHUSDTP','BYBIT:PERP:ETHUSDT',9),
  ('BTCUSD','COINBASE:SPOT:BTC-USD',10),('ETHUSD','COINBASE:SPOT:ETH-USD',10),
  ('XBTUSD','KRAKEN:SPOT:XBT/USD',10),('BTCUSD','KRAKEN:SPOT:XBT/USD',7)
) as k(key, canonical, weight)
join instruments i on i.canonical = k.canonical
on conflict (key, instrument_id) do nothing;

-- First immutable strategy version (A04 section 2.2 defaults; every rule is a HYPOTHESIS until backtested) ---
-- config_hash is filled by the trigger from migration 0003.
insert into strategy_versions (name, version, schema_version, status, notes, config) values (
 'smc-core', 1, 1, 'ACTIVE', 'MVP defaults from A04. All rules HYPOTHESIS. Tune only by creating version 2.',
 $cfg$
 {
  "schemaVersion": 1,
  "timeframes": { "analysis": ["5m","15m","1h","4h","1d"], "bias": ["4h","1d"], "entry": ["5m","15m"] },
  "swings": { "internal": { "L": 3, "R": 3 }, "external": { "L": 10, "R": 10 } },
  "atr": { "period": 14 },
  "break": { "requireCloseBeyond": true, "bufferAtrMult": 0 },
  "displacement": { "bodyAtrMult": 1.5, "requireFvg": false },
  "fvg": { "minSizeAtrMult": 0.1, "mitigation": "TOUCH" },
  "ob": { "zoneBasis": "WICK", "requireDisplacement": true, "maxAgeBars": 300 },
  "liquidity": { "equalTolAtrMult": 0.1, "sweepMinAtrMult": 0.05, "sweepConfirmBars": 3 },
  "range": { "basis": "EXTERNAL_LEG", "oteLow": 0.62, "oteHigh": 0.79 },
  "sessions": [
    { "id": "ASIA",   "tz": "UTC", "start": "00:00", "end": "08:00" },
    { "id": "LONDON", "tz": "UTC", "start": "07:00", "end": "16:00", "killzone": { "start": "07:00", "end": "10:00" } },
    { "id": "NY_AM",  "tz": "UTC", "start": "12:00", "end": "21:00", "killzone": { "start": "12:00", "end": "15:00" } }
  ],
  "context": { "openLevels": ["1d","1w","1M"], "openLevelsAsTargets": false, "weekendLiquidityWeight": -3, "sessionsTz": "UTC" },
  "setups": { "enabled": ["T1","T2"], "expiryBars": { "5m": 96, "15m": 64, "1h": 48, "4h": 30, "1d": 20 } },
  "filters": { "requireDataOk": true, "requirePoiFresh": true, "enforcePdSideT1": false, "enforcePdSideT2": true,
               "maxSpreadAtrMult": 0.2, "volExtremePercentile": 98, "newsWindow": false },
  "scoring": {
    "weights": { "htfAlignment": 20, "sweepPresent": 15, "displacementStrength": 15, "fvgConfluence": 10, "obFreshness": 10,
                 "killzone": 10, "rrQuality": 10, "zoneSize": 5, "targetClarity": 5, "gapBreakPenalty": -10 },
    "gradeCuts": [50, 70]
  },
  "risk": { "takerFeeBps": 5, "minRR": 1.5, "stopBufferAtrMult": 0.1, "maxStopAtrMult": 3.0, "minStopAtrMult": 0.3 },
  "rules": {
    "swing_internal": { "status": "HYPOTHESIS" }, "swing_external": { "status": "HYPOTHESIS" },
    "bos": { "status": "HYPOTHESIS" }, "choch": { "status": "HYPOTHESIS" },
    "fvg": { "status": "HYPOTHESIS" }, "ob": { "status": "HYPOTHESIS" },
    "eq_liquidity": { "status": "HYPOTHESIS" }, "sweep": { "status": "HYPOTHESIS" },
    "premium_discount": { "status": "HYPOTHESIS" }, "mtf_bias": { "status": "HYPOTHESIS" },
    "killzone": { "status": "HYPOTHESIS" }, "open_levels": { "status": "HYPOTHESIS" }, "weekend_liquidity": { "status": "HYPOTHESIS" }, "T1": { "status": "HYPOTHESIS" }, "T2": { "status": "HYPOTHESIS" }
  }
 }
 $cfg$::jsonb
) on conflict (name, version) do nothing;

-- Feature flags / kill switches (A07 section 9) -------------------------------------------------------------
insert into feature_flags (key, enabled, rollout_pct) values
 ('ai.image_read', true, 100), ('ai.explain', true, 100), ('ai.narrative', true, 100), ('ai.chat', true, 100), ('ai.router', true, 100),
 ('voice.enabled', true, 100), ('voice.server_stt', false, 0), ('explain.enabled', true, 100), ('explain.approximate', false, 0),
 ('engine.t1', true, 100), ('engine.t2', true, 100),
 ('sessions.new', true, 100), ('signup.open', false, 0), ('payments.enabled', false, 0)
on conflict (key) do nothing;

-- DEV ONLY sample invite code. Delete before any real beta:  delete from invite_codes where code = 'DEV-BETA-0001';
insert into invite_codes (code, note, max_uses) values ('DEV-BETA-0001', 'dev only', 5) on conflict (code) do nothing;
