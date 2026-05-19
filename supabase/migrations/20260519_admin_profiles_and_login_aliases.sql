-- Admin display names and short login aliases.
--
-- Supabase password auth still signs in with email, so short names are resolved
-- to emails by a tightly-scoped SECURITY DEFINER function. The audit log keeps
-- storing changed_by_user_id as the immutable source of truth.

create extension if not exists citext;

create table if not exists public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login_name citext not null unique,
  display_name text not null,
  email citext not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists set_admin_profiles_updated_at on public.admin_profiles;
create trigger set_admin_profiles_updated_at
before update on public.admin_profiles
for each row execute function public.set_updated_at();

alter table public.admin_profiles enable row level security;

drop policy if exists "Authenticated users can read admin profiles" on public.admin_profiles;
create policy "Authenticated users can read admin profiles"
on public.admin_profiles
for select
to authenticated
using (true);

drop policy if exists "Users can update their own admin profile" on public.admin_profiles;
create policy "Users can update their own admin profile"
on public.admin_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.resolve_admin_login_email(login_identifier text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.email::text
  from public.admin_profiles p
  where lower(p.login_name::text) = lower(trim(login_identifier))
  limit 1;
$$;

revoke all on function public.resolve_admin_login_email(text) from public;
grant execute on function public.resolve_admin_login_email(text) to anon, authenticated;

comment on table public.admin_profiles is
  'Admin login aliases and display names used by the app UI. user_id remains the audit source of truth.';

comment on function public.resolve_admin_login_email(text) is
  'Resolves a short admin login name to its Supabase Auth email for password sign-in.';
