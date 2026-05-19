-- Production database audit trail for actual row-level mutations.
-- This records what Postgres inserted, updated, or deleted, independent of
-- local/client action logs.

create extension if not exists pgcrypto;

create table if not exists public.change_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default timezone('utc', now()),
  schema_name text not null,
  table_name text not null,
  row_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by_user_id uuid,
  old_row jsonb,
  new_row jsonb,
  changed_fields text[],
  source text not null default 'db_trigger'
);

create index if not exists change_log_occurred_at_idx
  on public.change_log (occurred_at desc);

create index if not exists change_log_table_occurred_at_idx
  on public.change_log (table_name, occurred_at desc);

create index if not exists change_log_row_idx
  on public.change_log (table_name, row_id, occurred_at desc)
  where row_id is not null;

alter table public.change_log enable row level security;

drop policy if exists "Authenticated users can read change_log" on public.change_log;
create policy "Authenticated users can read change_log"
on public.change_log
for select
to authenticated
using (true);

drop policy if exists "No direct inserts to change_log" on public.change_log;
drop policy if exists "No direct updates to change_log" on public.change_log;
drop policy if exists "No direct deletes from change_log" on public.change_log;

create or replace function public.log_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_json jsonb;
  new_json jsonb;
  changed text[];
  raw_row_id text;
  row_uuid uuid;
begin
  if tg_op = 'INSERT' then
    old_json := null;
    new_json := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    old_json := to_jsonb(old);
    new_json := to_jsonb(new);

    select array_agg(field_name order by field_name)
      into changed
    from (
      select key as field_name
      from jsonb_object_keys(old_json || new_json) as keys(key)
      where (old_json -> key) is distinct from (new_json -> key)
    ) changed_keys;

    if coalesce(array_length(changed, 1), 0) = 0 then
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    old_json := to_jsonb(old);
    new_json := null;
  else
    raise exception 'Unsupported audit trigger operation: %', tg_op;
  end if;

  raw_row_id := coalesce(new_json ->> 'id', old_json ->> 'id');
  if raw_row_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    row_uuid := raw_row_id::uuid;
  else
    row_uuid := null;
  end if;

  insert into public.change_log (
    schema_name,
    table_name,
    row_id,
    action,
    changed_by_user_id,
    old_row,
    new_row,
    changed_fields,
    source
  )
  values (
    tg_table_schema,
    tg_table_name,
    row_uuid,
    tg_op,
    auth.uid(),
    old_json,
    new_json,
    changed,
    'db_trigger'
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare
  audit_table text;
  audit_tables text[] := array[
    'lessons',
    'packages',
    'package_transactions',
    'horses',
    'instructors',
    'groups',
    'settings',
    'expenses',
    'incomes'
  ];
begin
  foreach audit_table in array audit_tables loop
    if to_regclass(format('public.%I', audit_table)) is not null then
      execute format(
        'drop trigger if exists %I on public.%I',
        'audit_' || audit_table || '_row_change',
        audit_table
      );
      execute format(
        'create trigger %I after insert or update or delete on public.%I for each row execute function public.log_row_change()',
        'audit_' || audit_table || '_row_change',
        audit_table
      );
    end if;
  end loop;
end
$$;

comment on table public.change_log is
  'Row-level audit trail populated by database triggers for production diagnostics and recovery.';

comment on function public.log_row_change() is
  'Trigger function that records actual INSERT, UPDATE, and DELETE row mutations with auth.uid() attribution.';
