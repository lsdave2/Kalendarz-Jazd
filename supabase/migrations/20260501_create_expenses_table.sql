-- Create a dedicated expenses table (migrating from settings JSON blob)
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  cost        numeric not null default 0,
  date        date not null default current_date,
  description text not null default '',
  category    text not null default 'other',
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now())
);

-- Updated-at trigger
drop trigger if exists set_expenses_updated_at on public.expenses;
create trigger set_expenses_updated_at
before update on public.expenses
for each row execute function public.set_updated_at();

-- RLS
alter table public.expenses enable row level security;

drop policy if exists "Authenticated users have full access to expenses" on public.expenses;
create policy "Authenticated users have full access to expenses"
on public.expenses
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Public can read expenses" on public.expenses;
create policy "Public can read expenses"
on public.expenses
for select
to public
using (true);

-- Realtime
do $$
begin
  begin
    alter publication supabase_realtime add table public.expenses;
  exception when duplicate_object then null;
  end;
end
$$;
