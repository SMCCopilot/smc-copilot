-- LOCAL / CI ONLY (applied with --shims, never on Supabase): minimal stand-ins for the parts of Supabase Auth the API reads.
-- auth.identities holds the wallet a user signed in with; auth.users.email_confirmed_at says whether an email is verified.
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  identity_data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);
alter table auth.users add column if not exists email_confirmed_at timestamptz;
