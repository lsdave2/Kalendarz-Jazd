-- Remove automatic duplicate lesson_use rows created when a pre-cutoff lesson
-- edit matched an already-migrated historical occurrence under another lesson id.

create or replace function public.horsebook_lesson_credit_desired_net_for_write(
  lesson_row public.lessons,
  anchor timestamptz default now()
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  lesson_end_at timestamptz;
begin
  if lesson_row.id is null or lesson_row.lesson_type = 'custom' then
    return null;
  end if;

  lesson_end_at := (
    lesson_row.date::timestamp
    + make_interval(mins => coalesce(lesson_row.start_minute, 0) + coalesce(lesson_row.duration_minutes, 0))
  ) at time zone 'Europe/Warsaw';

  if lesson_end_at >= anchor then
    return null;
  end if;

  if coalesce(lesson_row.cancelled_dates, '[]'::jsonb) ? lesson_row.date::text then
    return 0;
  end if;

  return -1;
end;
$$;

create or replace function public.horsebook_has_existing_lesson_credit_occurrence(
  target_package_id uuid,
  target_lesson_id uuid,
  target_lesson_date date,
  target_lesson_start_minute integer
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.package_transactions pt
    where pt.package_id = target_package_id
      and pt.lesson_date = target_lesson_date
      and coalesce(pt.lesson_start_minute, -1) = coalesce(target_lesson_start_minute, -1)
      and pt.lesson_id is distinct from target_lesson_id
      and pt.type = 'lesson_use'
      and pt.amount = -1
      and coalesce(pt.source_key, '') like 'lesson_use|%'
  );
$$;

create or replace function public.horsebook_reconcile_lesson_credit_state_for_write(
  target_lesson_id uuid,
  anchor timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lesson_row public.lessons;
  desired_net integer;
  target_package_id uuid;
  changed_count integer := 0;
begin
  select *
  into lesson_row
  from public.lessons
  where id = target_lesson_id;

  if lesson_row.id is null then
    return 0;
  end if;

  desired_net := public.horsebook_lesson_credit_desired_net_for_write(lesson_row, anchor);
  if desired_net is null then
    return 0;
  end if;

  for target_package_id in
    select package_id from public.horsebook_lesson_credit_package_ids(lesson_row)
  loop
    if desired_net = -1
      and lesson_row.date < public.horsebook_credit_tracking_cutoff()::date
      and public.horsebook_has_existing_lesson_credit_occurrence(
        target_package_id,
        lesson_row.id,
        lesson_row.date,
        lesson_row.start_minute
      )
    then
      continue;
    end if;

    if public.horsebook_ensure_lesson_credit_net(
      target_package_id,
      lesson_row.id,
      lesson_row.date,
      lesson_row.start_minute,
      desired_net
    ) then
      changed_count := changed_count + 1;
    end if;
  end loop;

  return changed_count;
end;
$$;

create or replace function public.horsebook_after_lesson_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lesson_credit_fields_changed boolean := false;
begin
  if coalesce(current_setting('horsebook.filling_recurring_lessons', true), '') = 'on' then
    return new;
  end if;

  lesson_credit_fields_changed := tg_op = 'UPDATE'
    and (
      old.date is distinct from new.date
      or old.start_minute is distinct from new.start_minute
      or old.duration_minutes is distinct from new.duration_minutes
      or old.lesson_type is distinct from new.lesson_type
      or old.title is distinct from new.title
      or old.package_mode is distinct from new.package_mode
      or old.participants is distinct from new.participants
      or old.cancelled_dates is distinct from new.cancelled_dates
    );

  if new.recurring is true
    and (
      tg_op = 'INSERT'
      or old.recurring is distinct from new.recurring
      or old.date is distinct from new.date
      or old.start_minute is distinct from new.start_minute
      or old.duration_minutes is distinct from new.duration_minutes
      or old.lesson_type is distinct from new.lesson_type
      or old.title is distinct from new.title
      or old.horse_name is distinct from new.horse_name
      or old.instructor_name is distinct from new.instructor_name
      or old.package_mode is distinct from new.package_mode
      or old.group_name is distinct from new.group_name
      or old.group_color is distinct from new.group_color
      or old.participants is distinct from new.participants
    )
  then
    perform public.horsebook_fill_recurring_lessons();
  end if;

  if lesson_credit_fields_changed then
    perform public.horsebook_reconcile_lesson_credit_cleanup(old);
  end if;

  if lesson_credit_fields_changed then
    perform public.horsebook_reconcile_lesson_credit_state_for_write(new.id);
  else
    perform public.horsebook_reconcile_lesson_credit_state(new.id);
  end if;

  return new;
end;
$$;

with cutoff as (
  select public.horsebook_credit_tracking_cutoff() as value
),
duplicate_lesson_uses as (
  select duplicate.id
  from public.package_transactions duplicate
  cross join cutoff
  where duplicate.type = 'lesson_use'
    and duplicate.amount = -1
    and duplicate.lesson_id is not null
    and duplicate.lesson_date < cutoff.value::date
    and duplicate.created_at >= cutoff.value
    and duplicate.note = 'Automatic deduction for completed lesson'
    and coalesce(duplicate.source_key, '') like 'lesson_use|%'
    and exists (
      select 1
      from public.change_log lesson_change
      where lesson_change.table_name = 'lessons'
        and lesson_change.row_id = duplicate.lesson_id
        and lesson_change.occurred_at >= cutoff.value
        and (
          lesson_change.action = 'INSERT'
          or lesson_change.changed_fields && array[
            'date',
            'start_minute',
            'duration_minutes',
            'lesson_type',
            'title',
            'package_mode',
            'participants',
            'cancelled_dates'
          ]::text[]
        )
    )
    and exists (
      select 1
      from public.package_transactions existing
      where existing.id <> duplicate.id
        and existing.package_id = duplicate.package_id
        and existing.lesson_date = duplicate.lesson_date
        and coalesce(existing.lesson_start_minute, -1) = coalesce(duplicate.lesson_start_minute, -1)
        and existing.lesson_id is distinct from duplicate.lesson_id
        and existing.type = 'lesson_use'
        and existing.amount = -1
        and existing.created_at < duplicate.created_at
        and coalesce(existing.source_key, '') like 'lesson_use|%'
    )
)
delete from public.package_transactions pt
using duplicate_lesson_uses duplicate
where pt.id = duplicate.id;
