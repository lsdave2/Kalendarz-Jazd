-- Create a dedicated incomes table
create table if not exists public.incomes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  amount      numeric not null default 0,
  date        date not null default current_date,
  description text not null default '',
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now())
);

-- Updated-at trigger
drop trigger if exists set_incomes_updated_at on public.incomes;
create trigger set_incomes_updated_at
before update on public.incomes
for each row execute function public.set_updated_at();

-- RLS
alter table public.incomes enable row level security;

drop policy if exists "Authenticated users have full access to incomes" on public.incomes;
create policy "Authenticated users have full access to incomes"
on public.incomes
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Public can read incomes" on public.incomes;
create policy "Public can read incomes"
on public.incomes
for select
to public
using (true);

-- Realtime
do $$
begin
  begin
    alter publication supabase_realtime add table public.incomes;
  exception when duplicate_object then null;
  end;
end
$$;
