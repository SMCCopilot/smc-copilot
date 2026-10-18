-- Smoke test for the v2 MVP schema (local only: inserts auth.users rows). Run after apply.sh --with-shims [--with-upgrade].
-- Each block prints what it expects. Statements marked "EXPECT ERROR" must fail.
\set ON_ERROR_STOP off
\echo '--- 1 signup trigger: wallet-only user (no email) and email user both get profile + workspace + entitlements'
insert into auth.users(id,email,raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111',null,null),
 ('22222222-2222-2222-2222-222222222222','bob@x.co','{"name":"Bob"}');
select p.display_name, w.kind, e.limits->>'explain_per_day' explain_pd, e.limits->>'daily_ai_budget_usd' budget, e.features->>'voice' voice
from profiles p join workspace_members m on m.user_id=p.id join workspaces w on w.id=m.workspace_id join entitlements e on e.workspace_id=w.id order by p.id;

\echo '--- 2 wallet_identities: valid evm + solana ok; bad address, duplicate address, second primary must fail'
insert into wallet_identities(user_id,chain,address_norm,address_display,is_primary) values
 ('11111111-1111-1111-1111-111111111111','evm','0x52908400098527886e0f7030069857d2e4169ee7','0x52908400098527886E0F7030069857D2E4169EE7',true),
 ('11111111-1111-1111-1111-111111111111','solana','7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV','7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',false);
\echo 'EXPECT ERROR (bad evm)'
insert into wallet_identities(user_id,chain,address_norm,address_display) values ('11111111-1111-1111-1111-111111111111','evm','0xZZ','0xZZ');
\echo 'EXPECT ERROR (duplicate address on another user)'
insert into wallet_identities(user_id,chain,address_norm,address_display) values ('22222222-2222-2222-2222-222222222222','evm','0x52908400098527886e0f7030069857d2e4169ee7','x');
\echo 'EXPECT ERROR (second primary for same user)'
insert into wallet_identities(user_id,chain,address_norm,address_display,is_primary) values ('11111111-1111-1111-1111-111111111111','evm','0x00000000000000000000000000000000000000aa','x',true);
\echo 'after unlinking, the address can be linked by someone else'
update wallet_identities set unlinked_at=now() where chain='solana';
insert into wallet_identities(user_id,chain,address_norm,address_display) values ('22222222-2222-2222-2222-222222222222','solana','7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV','x');
select user_id::text like '2222%' as bob_has_it, count(*) from wallet_identities where chain='solana' and unlinked_at is null group by 1;

\echo '--- 4 seeds: venues, instruments, aliases'
select count(*) venues from venues;
select venue_id, market_type, count(*) from instruments group by 1,2 order by 1,2;
select i.canonical, a.provider_id, a.role from instrument_aliases a join instruments i on i.id=a.instrument_id where i.canonical='BINANCE:PERP:BTCUSDT' order by a.role, a.provider_id;

\echo '--- 5 licence view: no venue_terms => everything INTERNAL_ONLY; after DISPLAY_OK terms => Binance DISPLAY_OK, Bybit stays INTERNAL_ONLY; PROHIBITED forces INTERNAL_ONLY'
select effective_class, count(*) from instrument_license group by 1;
insert into venue_terms(venue_id,url,retrieved_at,summary,decision,reviewer) values ('BINANCE','https://example.invalid/terms',current_date,'test','DISPLAY_OK','t');
select i.venue_id, l.effective_class, count(*) from instrument_license l join instruments i on i.id=l.instrument_id group by 1,2 order by 1;
insert into venue_terms(venue_id,url,retrieved_at,summary,decision,reviewer,reviewed_at) values ('BINANCE','https://example.invalid/terms2',current_date,'test','PROHIBITED','t', now()+interval '1 second');
select distinct effective_class, venue_prohibited from instrument_license l join instruments i on i.id=l.instrument_id where i.venue_id='BINANCE';
delete from venue_terms;

\echo '--- 6 candles: valid, bad OHLC fails, scope, upsert, partition routing, far future fails'
insert into candles(instrument_id,tf,open_time,o,h,l,c,v,vq,provider_id) select id,'1m',date_trunc('minute',now()),100,101,99,100.5,5,500,'binance' from instruments where canonical='BINANCE:SPOT:BTCUSDT';
\echo 'EXPECT ERROR (bad ohlc)'
insert into candles(instrument_id,tf,open_time,o,h,l,c,provider_id) select id,'1m',date_trunc('minute',now()),100,99,98,100.5,'binance' from instruments where canonical='BINANCE:SPOT:BTCUSDT';
insert into candles(instrument_id,tf,open_time,scope_id,o,h,l,c,provider_id) select id,'1m',date_trunc('minute',now()),'11111111-1111-1111-1111-111111111111',100,101,99,100.2,'byo' from instruments where canonical='BINANCE:SPOT:BTCUSDT';
insert into candles(instrument_id,tf,open_time,o,h,l,c,provider_id) select id,'1m',date_trunc('minute',now()),100,101,99,100.7,'binance' from instruments where canonical='BINANCE:SPOT:BTCUSDT' on conflict (instrument_id,tf,scope_id,open_time) do update set c=excluded.c;
select tableoid::regclass, tf, scope_id, c from candles order by scope_id;
\echo 'EXPECT ERROR (no partition for 2030)'
insert into candles(instrument_id,tf,open_time,o,h,l,c,provider_id) select id,'1m','2030-01-01',1,2,1,1,'binance' from instruments limit 1;

\echo '--- 7 strategy_versions: hash set; config update blocked; status update ok; v2 gets a different hash'
select name, version, status, length(config_hash) hash_len, config->'swings'->'external'->>'L' ext_L, config->'context'->>'sessionsTz' tz from strategy_versions;
\echo 'EXPECT ERROR (immutable)'
update strategy_versions set config = config || '{"x":1}'::jsonb where version=1;
update strategy_versions set notes='ok' where version=1;
insert into strategy_versions(name,version,schema_version,config) values ('smc-core',2,1,'{"a":1}');
select version, config_hash<>(select config_hash from strategy_versions where version=1) as differs from strategy_versions where version=2;

\echo '--- 8 setup/outcome/cohort flow (fees_r, segment) and Wilson interval'
with i as (select id from instruments where canonical='BINANCE:PERP:BTCUSDT'), s as (select id from strategy_versions where version=1)
insert into setups(setup_key,strategy_version_id,instrument_id,template,direction,entry_tf,bias_tf,state,grade,score,components,poi,invalidation,created_at)
select 'k'||g, s.id, i.id, 'T1', case when g%2=0 then 'LONG' else 'SHORT' end, '15m','4h','RESOLVED','B',60,'[]','{}','{}', now() from i,s,generate_series(1,40) g;
insert into setup_outcomes(setup_id,outcome_rules_version,outcome,filled,fees_r,realized_r) select id,'v1', case when right(setup_key,1) in ('1','2','3','4') then 'TP1_FIRST' else 'SL_FIRST' end, true, 0.04, 1.2 from setups;
with c as (
  select count(*) filter (where o.filled) n, count(*) filter (where o.outcome='TP1_FIRST') wins from setups s join setup_outcomes o on o.setup_id=s.id)
select n, wins, round(wins::numeric/n,3) rate,
 round(((wins+1.9208)/(n+3.8416) - 1.96/(n+3.8416)*sqrt(wins::float*(n-wins)/n+0.9604))::numeric,3) ci_low,
 round(((wins+1.9208)/(n+3.8416) + 1.96/(n+3.8416)*sqrt(wins::float*(n-wins)/n+0.9604))::numeric,3) ci_high from c;
insert into cohort_stats(strategy_version_id,asset_class,template,grade,direction,source,window_from,window_to,n,wins,rate,ci_low,ci_high,sufficient) select id,'CRYPTO','T1','B',null,'BACKTEST',now()-interval '1 year',now(),40,16,0.4,0.26,0.56,true from strategy_versions where version=1;
\echo 'EXPECT ERROR (duplicate cohort incl. NULL direction)'
insert into cohort_stats(strategy_version_id,asset_class,template,grade,direction,source,window_from,window_to,n,wins,rate,ci_low,ci_high,sufficient) select id,'CRYPTO','T1','B',null,'BACKTEST',now()-interval '1 year',now(),41,16,0.4,0.26,0.56,true from strategy_versions where version=1;
\echo 'a different segment is allowed'
insert into cohort_stats(strategy_version_id,asset_class,segment,template,grade,direction,source,window_from,window_to,n,wins,rate,ci_low,ci_high,sufficient) select id,'CRYPTO','PERP','T1','B',null,'BACKTEST',now()-interval '1 year',now(),41,16,0.4,0.26,0.56,true from strategy_versions where version=1;

\echo '--- 9 gate: voice can never confirm (database-level)'
insert into trade_plans(setup_id,plan,plan_hash) select id,'{}','h1' from setups limit 1;
insert into gate_decisions(workspace_id,user_id,plan_id,plan_hash,token_hash,expires_at) select m.workspace_id,m.user_id,p.id,'h1','t-ok',now()+interval '60 seconds' from trade_plans p, workspace_members m where m.user_id='11111111-1111-1111-1111-111111111111' limit 1;
\echo 'EXPECT ERROR (confirm without UI tap)'
update gate_decisions set action='CONFIRMED', decided_at=now() where token_hash='t-ok';
\echo 'EXPECT ERROR (confirmed_via voice)'
update gate_decisions set action='CONFIRMED', confirmed_via='VOICE', decided_at=now() where token_hash='t-ok';
update gate_decisions set action='CONFIRMED', confirmed_via='UI_TAP', decided_at=now() where token_hash='t-ok';
select action, confirmed_via from gate_decisions;
\echo 'EXPECT ERROR (token valid longer than 120 s)'
insert into gate_decisions(workspace_id,user_id,plan_id,plan_hash,token_hash,expires_at) select m.workspace_id,m.user_id,p.id,'h1','t-long',now()+interval '10 minutes' from trade_plans p, workspace_members m where m.user_id='11111111-1111-1111-1111-111111111111' limit 1;

\echo '--- 10 explain_requests + voice_events + chat voice fields'
insert into copilot_sessions(workspace_id,user_id,instrument_id,context_source,capture_surface) select m.workspace_id,m.user_id,i.id,'OCR','TAB' from workspace_members m, instruments i where m.user_id='11111111-1111-1111-1111-111111111111' and i.canonical='BINANCE:PERP:BTCUSDT';
insert into explain_requests(workspace_id,user_id,session_id,source,mode,instrument_id,symbol_text,tf,resolved_by,feed_match,feed_delta_pct,image_bytes,image_width,image_height,output,outcome,cost_usd)
select s.workspace_id,s.user_id,s.id,'SHARE','GROUNDED',s.instrument_id,'BTCUSDT.P','15m','OCR','MATCH',0.01,812345,1600,900,'{"summary":"x"}','OK',0.012 from copilot_sessions s;
insert into explain_requests(workspace_id,user_id,source,mode,outcome) select workspace_id,user_id,'UPLOAD','APPROXIMATE','OK_APPROXIMATE' from copilot_sessions;
\echo 'EXPECT ERROR (bad outcome)'
insert into explain_requests(workspace_id,user_id,source,mode,outcome) select workspace_id,user_id,'UPLOAD','APPROXIMATE','WHATEVER' from copilot_sessions;
insert into voice_events(workspace_id,user_id,session_id,engine,duration_ms,latency_ms,confidence,language,outcome,route,command_id) select workspace_id,user_id,id,'whisper-web',2300,640,0.93,'en','OK','COMMAND','explain_chart' from copilot_sessions;
\echo 'EXPECT ERROR (unknown engine)'
insert into voice_events(workspace_id,user_id,engine,outcome) select workspace_id,user_id,'cloud-magic','OK' from copilot_sessions;
select (select count(*) from explain_requests) explains, (select count(*) from voice_events) voice;
select column_name from information_schema.columns where table_schema='public' and (column_name ~* '(image|frame|audio|blob)' and column_name not in ('image_bytes','image_width','image_height','frames_sampled')) ;

\echo '--- 11 partitions + retention (voice 30d, explain 90d, chat 90d, ai_calls partitions, session_events 7d)'
select maintain_partitions(5);
select count(*) as candle_parts from pg_inherits i join pg_class p on p.oid=i.inhparent where p.relname='candles';
create table ai_calls_2025_01 partition of ai_calls for values from ('2025-01-01') to ('2025-02-01');
insert into ai_calls(created_at,job,provider,model,prompt_version,outcome) values ('2025-01-15','J3_CHAT','a','m','1','OK'), (now(),'J3_CHAT','a','m','1','OK');
\echo 'EXPECT ERROR (old job id)'
insert into ai_calls(job,provider,model,prompt_version,outcome) values ('VISION','a','m','1','OK');
update voice_events set at = now() - interval '31 days';
update explain_requests set created_at = now() - interval '91 days' where mode='APPROXIMATE';
insert into chat_threads(workspace_id,user_id) select workspace_id,user_id from copilot_sessions;
insert into chat_messages(thread_id,role,content,input_mode,stt_engine,stt_confidence,created_at) select id,'user','hello','VOICE','whisper-web',0.9, now()-interval '91 days' from chat_threads;
select retention_purge();
select (select count(*) from ai_calls) ai_rows_left, (select count(*) from explain_requests) explains_left, (select count(*) from voice_events) voice_left, (select count(*) from chat_messages) chat_left;

select to_regclass('public.invoices') is not null as has_billing \gset
\if :has_billing
\echo '--- 12 upgrade tables (only if 0010 applied): exact-amount uniqueness among OPEN invoices, payment idempotency'
insert into invoices(workspace_id,user_id,plan,period_months,amount_usd,chain_id,asset,asset_contract,amount_atomic,pay_to,expires_at)
select m.workspace_id,m.user_id,'pro',1,19.00,'eip155:8453','USDC','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',19000731,'0xaaaa000000000000000000000000000000000001',now()+interval '1 hour' from workspace_members m where m.user_id='11111111-1111-1111-1111-111111111111';
\echo 'EXPECT ERROR (same exact amount, same chain and address, both OPEN)'
insert into invoices(workspace_id,user_id,plan,period_months,amount_usd,chain_id,asset,asset_contract,amount_atomic,pay_to,expires_at)
select m.workspace_id,m.user_id,'pro',1,19.00,'eip155:8453','USDC','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',19000731,'0xaaaa000000000000000000000000000000000001',now()+interval '1 hour' from workspace_members m where m.user_id='22222222-2222-2222-2222-222222222222';
\echo 'a different suffix is fine'
insert into invoices(workspace_id,user_id,plan,period_months,amount_usd,chain_id,asset,asset_contract,amount_atomic,pay_to,expires_at)
select m.workspace_id,m.user_id,'pro',1,19.00,'eip155:8453','USDC','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',19000732,'0xaaaa000000000000000000000000000000000001',now()+interval '1 hour' from workspace_members m where m.user_id='22222222-2222-2222-2222-222222222222';
\echo 'once the first invoice is no longer OPEN its amount can be reused'
update invoices set status='EXPIRED' where amount_atomic=19000731;
insert into invoices(workspace_id,user_id,plan,period_months,amount_usd,chain_id,asset,asset_contract,amount_atomic,pay_to,expires_at)
select m.workspace_id,m.user_id,'pro',1,19.00,'eip155:8453','USDC','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',19000731,'0xaaaa000000000000000000000000000000000001',now()+interval '1 hour' from workspace_members m where m.user_id='22222222-2222-2222-2222-222222222222';
insert into onchain_payments(invoice_id,chain_id,tx_hash,log_index,to_address,asset_contract,amount_atomic) select id,chain_id,'0xtx',3,pay_to,asset_contract,amount_atomic from invoices where amount_atomic=19000732;
\echo 'EXPECT ERROR (same transfer seen twice)'
insert into onchain_payments(invoice_id,chain_id,tx_hash,log_index,to_address,asset_contract,amount_atomic) select id,chain_id,'0xtx',3,pay_to,asset_contract,amount_atomic from invoices where amount_atomic=19000732;

\endif

\echo '--- 13 RLS: role simulating an authenticated browser client'
do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
grant usage on schema public, auth to authenticated;
grant select, insert on journal_entries, workspaces, workspace_members, candles, wallet_identities, explain_requests, instruments to authenticated;
grant execute on function is_member(uuid), auth.uid() to authenticated;
insert into journal_entries(workspace_id,user_id,kind,notes) select w.id, m.user_id,'NOTE','alice note' from workspaces w join workspace_members m on m.workspace_id=w.id where m.user_id='11111111-1111-1111-1111-111111111111';
insert into journal_entries(workspace_id,user_id,kind,notes) select w.id, m.user_id,'NOTE','bob note' from workspaces w join workspace_members m on m.workspace_id=w.id where m.user_id='22222222-2222-2222-2222-222222222222';
select workspace_id as alice_ws from workspace_members where user_id='11111111-1111-1111-1111-111111111111' \gset
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select notes as journal_visible_to_alice from journal_entries;
select count(*) as candles_visible_to_alice from candles;
select count(*) as instruments_visible_to_alice from instruments;
select count(*) as own_wallets_visible_to_alice from wallet_identities;
select count(*) as explains_visible_to_alice from explain_requests;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select notes as journal_visible_to_bob from journal_entries;
select count(*) as explains_visible_to_bob from explain_requests;
select address_norm like '0x5290%' as bob_sees_alices_wallet from wallet_identities;
\echo 'EXPECT ERROR (Bob writes a row as Alice into Alice workspace)'
insert into journal_entries(workspace_id,user_id,kind,notes) values (:'alice_ws','11111111-1111-1111-1111-111111111111','NOTE','forged');
\echo 'EXPECT ERROR (Bob writes his own row into Alice workspace)'
insert into journal_entries(workspace_id,user_id,kind,notes) values (:'alice_ws','22222222-2222-2222-2222-222222222222','NOTE','intrusion');
reset role;
