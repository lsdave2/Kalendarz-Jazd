-- ============================================================
-- Ledger-based package credit system
-- ============================================================
alter table public.packages
  add column if not exists current_credits integer;

update public.packages
  set current_credits = credits
where current_credits is null;

alter table public.packages
  alter column current_credits set default 0,
  alter column current_credits set not null;

create table if not exists public.package_transactions (
  id          uuid        primary key default gen_random_uuid(),
  package_id  uuid        not null references public.packages(id) on delete cascade,
  type        text        not null
                check (type in ('purchase','manual_add','manual_deduct','lesson_use','lesson_cancel','correction')),
  amount      integer     not null,
  lesson_id   uuid        references public.lessons(id) on delete set null,
  lesson_date date,        -- for recurring lessons: specific occurrence date
  lesson_start_minute integer,
  note        text,
  created_at  timestamptz not null default timezone('utc', now()),
  created_by  text
);

alter table public.package_transactions
  add column if not exists lesson_start_minute integer;

-- Idempotency: one lesson_use per (package, lesson, occurrence date/time)
-- coalesce handles non-recurring lessons that have no lesson_date
drop index if exists public.uq_package_lesson_use;
create unique index if not exists uq_package_lesson_use
  on public.package_transactions (
    package_id,
    coalesce(lesson_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lesson_date, '1970-01-01'::date),
    coalesce(lesson_start_minute, -1)
  )
  where type = 'lesson_use';

create index if not exists idx_pkg_txn_package_id
  on public.package_transactions (package_id, created_at desc);

alter table public.package_transactions enable row level security;

drop policy if exists "Authenticated users have full access to package_transactions"
  on public.package_transactions;
create policy "Authenticated users have full access to package_transactions"
  on public.package_transactions for all to authenticated
  using (true) with check (true);

drop policy if exists "Public can read package_transactions"
  on public.package_transactions;
create policy "Public can read package_transactions"
  on public.package_transactions for select to public
  using (true);

do $$ begin
  begin
    alter publication supabase_realtime add table public.package_transactions;
  exception when duplicate_object then null;
  end;
end $$;

-- Historical transactions are created by the app's explicit
-- "migrate credit values" action after it freezes currently displayed credits.
