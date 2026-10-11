-- 0008_rls.sql
-- Row-level security as a second lock (the API is the primary enforcement point)
-- SMC Copilot MVP schema (Set B03, v2). Subset of Set A06; names and columns are identical so Set A upgrades are additive.


-- 1) RLS on every table in public. Tables without policies are unreachable by anon/authenticated (global data stays server-only).
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', r.tablename);
  end loop;
end $$;

-- 2) Tenant policies (only matter if PostgREST/Supabase client is ever exposed to browsers; MVP is API-only)
create policy ws_read on workspaces        for select using (is_member(id));
create policy wm_read on workspace_members for select using (user_id = auth.uid() or is_member(workspace_id));
create policy rp_all  on risk_profiles     for all    using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy cs_read on copilot_sessions  for select using (is_member(workspace_id));
create policy je_all  on journal_entries   for all    using (is_member(workspace_id) and user_id = auth.uid())
                                                    with check (is_member(workspace_id) and user_id = auth.uid());
create policy tr_all  on trade_records     for all    using (is_member(workspace_id) and user_id = auth.uid())
                                                    with check (is_member(workspace_id) and user_id = auth.uid());
create policy ct_all  on chat_threads      for all    using (is_member(workspace_id) and user_id = auth.uid())
                                                    with check (is_member(workspace_id) and user_id = auth.uid());
create policy nt_read on notifications     for select using (user_id = auth.uid());
create policy wi_read on wallet_identities for select using (user_id = auth.uid());
create policy ex_read on explain_requests  for select using (is_member(workspace_id) and user_id = auth.uid());
create policy ve_read on voice_events      for select using (is_member(workspace_id) and user_id = auth.uid());

-- 3) Supabase only: API-only access means the browser roles should have no table privileges at all.
--    (Skipped automatically on plain Postgres where these roles do not exist.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables    in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    alter default privileges in schema public revoke all on tables    from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end $$;
