-- 0007_maintenance.sql
-- Partition maintenance and retention (called daily by the worker via pg-boss; no pg_cron needed)
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.


create or replace function maintain_partitions(months_ahead int default 3) returns void
language plpgsql as $$
declare n int;
begin
  for n in 0..months_ahead loop
    perform ensure_candle_partition(date_trunc('month', now() + (n || ' month')::interval)::date);
    perform ensure_ai_calls_partition(date_trunc('month', now() + (n || ' month')::interval)::date);
  end loop;
end $$;

-- Retention (A06 section 10; durations are defaults, product decisions in A09). Returns counts for logging. ai_calls partitions older than 90 days are dropped whole.
create or replace function retention_purge() returns jsonb
language plpgsql as $$
declare
  r record; d_events int; d_quar int; d_idem int; d_voice int; d_explain int; d_chat int; d_audit int; d_abuse int; dropped text[] := '{}';
  upper_bound timestamptz;
begin
  delete from session_events where created_at < now() - interval '7 days';
  get diagnostics d_events = row_count;
  delete from candle_quarantine where received_at < now() - interval '30 days';
  get diagnostics d_quar = row_count;
  delete from idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics d_idem = row_count;
  delete from voice_events where at < now() - interval '30 days';
  get diagnostics d_voice = row_count;
  delete from explain_requests where created_at < now() - interval '90 days';
  get diagnostics d_explain = row_count;
  delete from chat_messages where created_at < now() - interval '90 days';
  get diagnostics d_chat = row_count;
  delete from chat_threads t where t.created_at < now() - interval '90 days'
    and not exists (select 1 from chat_messages m where m.thread_id = t.id);
  delete from audit_log where at < now() - interval '1 year';
  get diagnostics d_audit = row_count;
  delete from abuse_flags where expires_at < now() - interval '7 days';
  get diagnostics d_abuse = row_count;

  for r in
    select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'ai_calls'
  loop
    -- bound text looks like: FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')
    upper_bound := ((regexp_match(r.bound, 'TO \(''([^'']+)''\)'))[1])::timestamptz;
    if upper_bound < now() - interval '90 days' then
      execute format('drop table %I', r.relname);
      dropped := dropped || r.relname::text;
    end if;
  end loop;

  return jsonb_build_object('session_events', d_events, 'candle_quarantine', d_quar,
                            'idempotency_keys', d_idem, 'voice_events', d_voice, 'explain_requests', d_explain,
                            'chat_messages', d_chat, 'audit_log', d_audit, 'abuse_flags', d_abuse,
                            'dropped_ai_calls_partitions', dropped);
end $$;
