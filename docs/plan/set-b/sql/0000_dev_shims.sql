-- 0000_dev_shims.sql
-- LOCAL / CI ONLY. Do NOT run on Supabase (it already provides auth.users and auth.uid()).
-- Lets the migrations run on a plain PostgreSQL 15+ instance (local Postgres, CI).
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb
);
create or replace function auth.uid() returns uuid
language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
