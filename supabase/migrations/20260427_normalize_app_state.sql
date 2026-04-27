create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.horses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.instructors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  credits integer not null default 0,
  active boolean not null default true,
  archived_at timestamptz,
  has_package_lessons boolean not null default false,
  history jsonb not null default '[]'::jsonb,
  custom_payment_rate numeric,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  title text not null default '',
  date date not null,
  start_minute integer not null default 0,
  duration_minutes integer not null default 0,
  horse_id uuid references public.horses(id) on delete set null,
  horse_name text,
  instructor_id uuid references public.instructors(id) on delete set null,
  instructor_name text,
  recurring boolean not null default false,
  recurring_until date,
  lesson_type text not null default 'individual',
  package_mode boolean not null default true,
  group_name text,
  group_color text,
  participants jsonb not null default '[]'::jsonb,
  cancelled_dates jsonb not null default '[]'::jsonb,
  deducted_dates jsonb not null default '[]'::jsonb,
  instance_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists set_horses_updated_at on public.horses;
create trigger set_horses_updated_at
before update on public.horses
for each row execute function public.set_updated_at();

drop trigger if exists set_instructors_updated_at on public.instructors;
create trigger set_instructors_updated_at
before update on public.instructors
for each row execute function public.set_updated_at();

drop trigger if exists set_groups_updated_at on public.groups;
create trigger set_groups_updated_at
before update on public.groups
for each row execute function public.set_updated_at();

drop trigger if exists set_packages_updated_at on public.packages;
create trigger set_packages_updated_at
before update on public.packages
for each row execute function public.set_updated_at();

drop trigger if exists set_lessons_updated_at on public.lessons;
create trigger set_lessons_updated_at
before update on public.lessons
for each row execute function public.set_updated_at();

drop trigger if exists set_settings_updated_at on public.settings;
create trigger set_settings_updated_at
before update on public.settings
for each row execute function public.set_updated_at();

alter table public.horses enable row level security;
alter table public.instructors enable row level security;
alter table public.groups enable row level security;
alter table public.packages enable row level security;
alter table public.lessons enable row level security;
alter table public.settings enable row level security;

drop policy if exists "Authenticated users have full access to horses" on public.horses;
create policy "Authenticated users have full access to horses"
on public.horses
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users have full access to instructors" on public.instructors;
create policy "Authenticated users have full access to instructors"
on public.instructors
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users have full access to groups" on public.groups;
create policy "Authenticated users have full access to groups"
on public.groups
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users have full access to packages" on public.packages;
create policy "Authenticated users have full access to packages"
on public.packages
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users have full access to lessons" on public.lessons;
create policy "Authenticated users have full access to lessons"
on public.lessons
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated users have full access to settings" on public.settings;
create policy "Authenticated users have full access to settings"
on public.settings
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Public can read horses" on public.horses;
create policy "Public can read horses"
on public.horses
for select
to public
using (true);

drop policy if exists "Public can read instructors" on public.instructors;
create policy "Public can read instructors"
on public.instructors
for select
to public
using (true);

drop policy if exists "Public can read groups" on public.groups;
create policy "Public can read groups"
on public.groups
for select
to public
using (true);

drop policy if exists "Public can read packages" on public.packages;
create policy "Public can read packages"
on public.packages
for select
to public
using (true);

drop policy if exists "Public can read lessons" on public.lessons;
create policy "Public can read lessons"
on public.lessons
for select
to public
using (true);

drop policy if exists "Public can read settings" on public.settings;
create policy "Public can read settings"
on public.settings
for select
to public
using (true);

do $$
begin
  begin
    alter publication supabase_realtime add table public.horses;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.instructors;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.groups;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.packages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.lessons;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.settings;
  exception when duplicate_object then null;
  end;
end
$$;

insert into public.settings(key, value)
values
  ('closed_dates', '[]'::jsonb),
  ('legacy_next_id', '1'::jsonb),
  ('legacy_next_group_id', '1'::jsonb)
on conflict (key) do nothing;
