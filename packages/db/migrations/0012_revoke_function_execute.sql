-- 0012: close the function-call hole 0008 left open.
-- Postgres grants EXECUTE on every new function to PUBLIC, and anon/authenticated inherit it, so the revoke in 0008
-- (which named only those two roles) changed nothing. On Supabase that let anyone holding the public anon key call
-- the SECURITY DEFINER function redeem_invite through /rest/v1/rpc, guessing invite codes and redeeming them for any
-- user id with no Turnstile check and no rate limit. The API connects as the database owner and does not need the
-- browser roles to run any function, except that row-level-security policies call is_member() as the signed-in role.
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on all functions in schema public from anon, authenticated;
    alter default privileges in schema public revoke execute on functions from anon, authenticated;
    grant execute on function is_member(uuid) to authenticated;
  end if;
end $$;
