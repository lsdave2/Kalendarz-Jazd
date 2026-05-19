-- One-time migration from virtual weekly recurring lessons to concrete chains.
--
-- Run this manually after 20260514_recurring_lesson_chain.sql and before
-- deploying app code that assumes recurring lessons are already concrete.
--
-- Safety properties:
-- - Idempotent generated IDs: md5(source lesson id + occurrence date).
-- - Does not create or modify package_transactions.
-- - Keeps the original lesson row when its own date is one migrated occurrence.
-- - Clears old virtual recurrence fields after materializing required occurrences.

create extension if not exists pgcrypto;

begin;

alter table public.lessons
  add column if not exists recurring_parent_id uuid references public.lessons(id) on delete set null;

create index if not exists lessons_recurring_parent_id_idx
  on public.lessons(recurring_parent_id);

create unique index if not exists lessons_one_recurring_child_per_parent_idx
  on public.lessons(recurring_parent_id)
  where recurring_parent_id is not null;

create or replace function public.horsebook_stable_occurrence_uuid(source_id uuid, occurrence_date date)
returns uuid
language sql
immutable
as $$
  select (
    substr(hash, 1, 8) || '-' ||
    substr(hash, 9, 4) || '-' ||
    '5' || substr(hash, 14, 3) || '-' ||
    '8' || substr(hash, 18, 3) || '-' ||
    substr(hash, 21, 12)
  )::uuid
  from (
    select md5('horsebook-recurring-chain:' || source_id::text || ':' || occurrence_date::text) as hash
  ) hashed;
$$;

-- Adjust here for test/prod if you need a different cutoff. Occurrences before
-- cutoff_date become concrete non-repeating lessons. The first occurrence on or
-- after cutoff_date becomes the first repeating chain lesson.
create temp table recurring_chain_migration_params as
select current_date::date as cutoff_date;

create temp table recurring_chain_source as
select
  l.*,
  p.cutoff_date,
  greatest(coalesce(l.recurring_until, p.cutoff_date + 6)::date, p.cutoff_date + 6)::date as materialize_until_date,
  l.recurring_until::date as configured_until_date
from public.lessons l
cross join recurring_chain_migration_params p
where l.recurring = true
  and l.date <= greatest(coalesce(l.recurring_until, p.cutoff_date + 6)::date, p.cutoff_date + 6)::date
  and not exists (
    select 1
    from public.settings s
    where s.key = 'recurring_chain_migrated_at'
  );

create temp table recurring_chain_occurrences as
with generated as (
  select
    s.id as source_id,
    gs.occurrence_date::date as occurrence_date,
    s.cutoff_date,
    s.materialize_until_date,
    s.configured_until_date,
    s.title,
    s.start_minute,
    s.duration_minutes,
    s.horse_id,
    s.horse_name,
    s.instructor_id,
    s.instructor_name,
    s.lesson_type,
    s.package_mode,
    s.group_name,
    s.group_color,
    s.participants,
    s.cancelled_dates,
    s.instance_overrides,
    s.created_at
  from recurring_chain_source s
  cross join lateral generate_series(s.date, s.materialize_until_date, interval '7 days') as gs(occurrence_date)
),
ranked as (
  select
    g.*,
    min(g.occurrence_date) filter (where g.occurrence_date >= g.cutoff_date)
      over (partition by g.source_id) as first_future_date
  from generated g
)
select
  r.*,
  coalesce(r.instance_overrides -> r.occurrence_date::text, '{}'::jsonb) as occurrence_override,
  (r.occurrence_date = r.first_future_date) as should_repeat
from ranked r
where r.occurrence_date < r.cutoff_date
   or (
    r.occurrence_date = r.first_future_date
    and (r.configured_until_date is null or r.first_future_date <= r.configured_until_date)
   );

insert into public.lessons (
  id,
  title,
  date,
  start_minute,
  duration_minutes,
  horse_id,
  horse_name,
  instructor_id,
  instructor_name,
  recurring,
  recurring_parent_id,
  recurring_until,
  lesson_type,
  package_mode,
  group_name,
  group_color,
  participants,
  cancelled_dates,
  deducted_dates,
  instance_overrides,
  created_at
)
select
  public.horsebook_stable_occurrence_uuid(o.source_id, o.occurrence_date),
  coalesce(o.occurrence_override ->> 'title', o.title),
  o.occurrence_date,
  coalesce((o.occurrence_override ->> 'startMinute')::integer, (o.occurrence_override ->> 'start_minute')::integer, o.start_minute),
  coalesce((o.occurrence_override ->> 'durationMinutes')::integer, (o.occurrence_override ->> 'duration_minutes')::integer, o.duration_minutes),
  o.horse_id,
  coalesce(o.occurrence_override ->> 'horse', o.occurrence_override ->> 'horse_name', o.horse_name),
  o.instructor_id,
  coalesce(o.occurrence_override ->> 'instructor', o.occurrence_override ->> 'instructor_name', o.instructor_name),
  o.should_repeat,
  null,
  null,
  coalesce(o.occurrence_override ->> 'lessonType', o.occurrence_override ->> 'lesson_type', o.lesson_type),
  coalesce((o.occurrence_override ->> 'packageMode')::boolean, (o.occurrence_override ->> 'package_mode')::boolean, o.package_mode),
  coalesce(o.occurrence_override ->> 'groupName', o.occurrence_override ->> 'group_name', o.group_name),
  coalesce(o.occurrence_override ->> 'groupColor', o.occurrence_override ->> 'group_color', o.group_color),
  coalesce(o.occurrence_override -> 'participants', o.participants, '[]'::jsonb),
  case
    when o.cancelled_dates ? o.occurrence_date::text then jsonb_build_array(o.occurrence_date::text)
    else '[]'::jsonb
  end,
  '[]'::jsonb,
  '{}'::jsonb,
  o.created_at
from recurring_chain_occurrences o
where o.occurrence_date <> (
  select s.date from recurring_chain_source s where s.id = o.source_id
)
on conflict (id) do update set
  title = excluded.title,
  date = excluded.date,
  start_minute = excluded.start_minute,
  duration_minutes = excluded.duration_minutes,
  horse_id = excluded.horse_id,
  horse_name = excluded.horse_name,
  instructor_id = excluded.instructor_id,
  instructor_name = excluded.instructor_name,
  recurring = excluded.recurring,
  recurring_parent_id = excluded.recurring_parent_id,
  recurring_until = excluded.recurring_until,
  lesson_type = excluded.lesson_type,
  package_mode = excluded.package_mode,
  group_name = excluded.group_name,
  group_color = excluded.group_color,
  participants = excluded.participants,
  cancelled_dates = excluded.cancelled_dates,
  deducted_dates = excluded.deducted_dates,
  instance_overrides = excluded.instance_overrides;

update public.lessons l
set
  title = coalesce(o.occurrence_override ->> 'title', l.title),
  start_minute = coalesce((o.occurrence_override ->> 'startMinute')::integer, (o.occurrence_override ->> 'start_minute')::integer, l.start_minute),
  duration_minutes = coalesce((o.occurrence_override ->> 'durationMinutes')::integer, (o.occurrence_override ->> 'duration_minutes')::integer, l.duration_minutes),
  horse_name = coalesce(o.occurrence_override ->> 'horse', o.occurrence_override ->> 'horse_name', l.horse_name),
  instructor_name = coalesce(o.occurrence_override ->> 'instructor', o.occurrence_override ->> 'instructor_name', l.instructor_name),
  recurring = o.should_repeat,
  recurring_parent_id = null,
  recurring_until = null,
  lesson_type = coalesce(o.occurrence_override ->> 'lessonType', o.occurrence_override ->> 'lesson_type', l.lesson_type),
  package_mode = coalesce((o.occurrence_override ->> 'packageMode')::boolean, (o.occurrence_override ->> 'package_mode')::boolean, l.package_mode),
  group_name = coalesce(o.occurrence_override ->> 'groupName', o.occurrence_override ->> 'group_name', l.group_name),
  group_color = coalesce(o.occurrence_override ->> 'groupColor', o.occurrence_override ->> 'group_color', l.group_color),
  participants = coalesce(o.occurrence_override -> 'participants', l.participants, '[]'::jsonb),
  cancelled_dates = case
    when o.cancelled_dates ? o.occurrence_date::text then jsonb_build_array(o.occurrence_date::text)
    else '[]'::jsonb
  end,
  deducted_dates = '[]'::jsonb,
  instance_overrides = '{}'::jsonb
from recurring_chain_occurrences o
where l.id = o.source_id
  and l.date = o.occurrence_date;

-- Original recurring rows whose original date was not retained as a concrete
-- occurrence are left as a non-repeating concrete lesson on their original date
-- so existing package_transactions.lesson_id references are not broken.
update public.lessons l
set
  recurring = false,
  recurring_parent_id = null,
  recurring_until = null,
  instance_overrides = '{}'::jsonb,
  cancelled_dates = case
    when l.cancelled_dates ? l.date::text then jsonb_build_array(l.date::text)
    else '[]'::jsonb
  end,
  deducted_dates = '[]'::jsonb
from recurring_chain_source s
where l.id = s.id
  and not exists (
    select 1
    from recurring_chain_occurrences o
    where o.source_id = s.id
      and o.occurrence_date = s.date
  );

insert into public.settings(key, value)
values
  ('recurring_chain_migrated_at', to_jsonb((select cutoff_date from recurring_chain_migration_params))),
  ('credit_tracking_migrated_at', to_jsonb((select cutoff_date from recurring_chain_migration_params)::text))
on conflict (key) do update set
  value = excluded.value;

drop function public.horsebook_stable_occurrence_uuid(uuid, date);

commit;
