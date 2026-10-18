#!/usr/bin/env node
// Read-only report on who can reach what in the public schema: row-level security, policies, and the table
// privileges held by the API roles Supabase exposes (anon, authenticated). Prints names and counts, never data.
//   DATABASE_URL_SESSION=... node tools/spikes/src/rls-report.mjs
import { createClient } from '@smc/db';

const url = process.env.DATABASE_URL_SESSION || process.env.DATABASE_URL;
if (!url) {
  console.error('set DATABASE_URL_SESSION or DATABASE_URL');
  process.exit(2);
}
const sql = createClient(url, { max: 1 });
const roles =
  await sql`select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1`;
const tables = await sql`
  select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
         (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
   order by 1`;
const grants = await sql`
  select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
   group by 1, 2 order by 1, 2`;
const definers = await sql`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef order by 1`;
const execGrants = await sql`
  select routine_name, grantee from information_schema.routine_privileges
   where routine_schema = 'public' and grantee in ('anon', 'authenticated') order by 1`;
await sql.end();
const noRls = tables.filter((t) => !t.rls).map((t) => t.relname);
const withPolicies = tables.filter((t) => t.policies > 0).map((t) => `${t.relname}(${t.policies})`);
console.log(
  JSON.stringify(
    {
      roles: roles.map((r) => r.rolname),
      tables: tables.length,
      tablesWithoutRls: noRls,
      tablesWithPolicies: withPolicies,
      tablesDeniedToApiRoles: tables.filter((t) => t.rls && t.policies === 0).length,
      tableGrantsToApiRoles: grants.map((g) => `${g.grantee}:${g.table_name}:${g.privs}`),
      securityDefinerFunctions: definers.map((d) => d.proname),
      functionExecuteGrantedToApiRoles: execGrants.map((g) => `${g.grantee}:${g.routine_name}`),
    },
    null,
    1,
  ),
);
