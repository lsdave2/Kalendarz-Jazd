-- Move recurring lesson materialization and completed-lesson credit deduction
-- into PostgreSQL so they no longer depend on an open admin browser session.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create or replace function public.horsebook_local_today(anchor timestamptz default now())
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (anchor at time zone 'Europe/Warsaw')::date;
$$;

create or replace function public.horsebook_recurring_fill_horizon(anchor_date date default public.horsebook_local_today())
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select anchor_date + 28;
$$;

create or replace function public.horsebook_credit_tracking_cutoff()
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  raw_value text;
begin
  select value #>> '{}'
  into raw_value
  from public.settings
  where key = 'credit_tracking_migrated_at';

  return coalesce(
    nullif(raw_value, '')::timestamptz,
    '2026-05-12T00:00:00.000Z'::timestamptz
  );
exception when others then
  return '2026-05-12T00:00:00.000Z'::timestamptz;
end;
$$;

create or replace function public.horsebook_lesson_credit_package_ids(lesson_row public.lessons)
returns table(package_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lesson_names as (
    select lower(btrim(lesson_row.title)) as package_name
    where lesson_row.lesson_type <> 'custom'
      and jsonb_array_length(coalesce(lesson_row.participants, '[]'::jsonb)) = 0
      and lesson_row.package_mode is not false
      and btrim(coalesce(lesson_row.title, '')) <> ''

    union

    select lower(btrim(coalesce(participant ->> 'packageName', participant ->> 'name', ''))) as package_name
    from jsonb_array_elements(coalesce(lesson_row.participants, '[]'::jsonb)) participant
    where lesson_row.lesson_type <> 'custom'
      and coalesce(nullif(participant ->> 'packageMode', '')::boolean, true) is true
      and btrim(coalesce(participant ->> 'packageName', participant ->> 'name', '')) <> ''
  )
  select distinct packages.id
  from lesson_names
  join public.packages on lower(btrim(packages.name)) = lesson_names.package_name;
$$;

create or replace function public.horsebook_lesson_credit_desired_net(
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

  if lesson_end_at >= anchor or lesson_end_at < public.horsebook_credit_tracking_cutoff() then
    return null;
  end if;

  if coalesce(lesson_row.cancelled_dates, '[]'::jsonb) ? lesson_row.date::text then
    return 0;
  end if;

  return -1;
end;
$$;

create or replace function public.horsebook_ensure_lesson_credit_net(
  target_package_id uuid,
  target_lesson_id uuid,
  target_lesson_date date,
  target_lesson_start_minute integer,
  desired_net integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  occurrence_base text;
  current_net integer;
  has_base_use boolean;
  next_type text;
  next_amount integer;
  next_note text;
  next_source_key text;
  ordinal integer;
  inserted_count integer;
begin
  if target_package_id is null
    or target_lesson_id is null
    or target_lesson_date is null
    or desired_net is null then
    return false;
  end if;

  occurrence_base := target_package_id::text
    || '|' || target_lesson_id::text
    || '|' || target_lesson_date::text
    || '|' || coalesce(target_lesson_start_minute::text, '');

  select
    coalesce(sum(amount), 0)::integer,
    coalesce(bool_or(type = 'lesson_use'), false)
  into current_net, has_base_use
  from public.package_transactions
  where package_id = target_package_id
    and lesson_id = target_lesson_id
    and lesson_date = target_lesson_date
    and coalesce(lesson_start_minute, -1) = coalesce(target_lesson_start_minute, -1)
    and (
      type in ('lesson_use', 'lesson_cancel')
      or (
        type = 'correction'
        and (
          source_key like ('lesson_restore|' || occurrence_base || '|%')
          or source_key like ('lesson_adjust|' || occurrence_base || '|%')
        )
      )
    );

  if current_net = desired_net then
    return false;
  end if;

  if desired_net = -1 and current_net = 0 and not has_base_use then
    next_type := 'lesson_use';
    next_amount := -1;
    next_note := 'Automatic deduction for completed lesson';
    next_source_key := 'lesson_use|' || occurrence_base;
  elsif desired_net = -1 and current_net = 0 and has_base_use then
    select count(*) + 1
    into ordinal
    from public.package_transactions
    where source_key like ('lesson_restore|' || occurrence_base || '|%');

    next_type := 'correction';
    next_amount := -1;
    next_note := 'Restore cancelled lesson occurrence';
    next_source_key := 'lesson_restore|' || occurrence_base || '|' || ordinal::text;
  elsif desired_net = 0 and current_net = -1 then
    select count(*) + 1
    into ordinal
    from public.package_transactions
    where source_key like ('lesson_cancel|' || occurrence_base || '|%');

    next_type := 'lesson_cancel';
    next_amount := 1;
    next_note := 'Reverse deduction for removed or cancelled lesson';
    next_source_key := 'lesson_cancel|' || occurrence_base || '|' || ordinal::text;
  else
    select count(*) + 1
    into ordinal
    from public.package_transactions
    where source_key like ('lesson_adjust|' || occurrence_base || '|%');

    next_type := 'correction';
    next_amount := desired_net - current_net;
    next_note := 'Automatic lesson credit reconciliation';
    next_source_key := 'lesson_adjust|' || occurrence_base || '|' || ordinal::text;
  end if;

  insert into public.package_transactions(
    package_id,
    type,
    amount,
    lesson_id,
    lesson_date,
    lesson_start_minute,
    note,
    source_key
  )
  values (
    target_package_id,
    next_type,
    next_amount,
    target_lesson_id,
    target_lesson_date,
    target_lesson_start_minute,
    next_note,
    next_source_key
  )
  on conflict (source_key) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count > 0;
end;
$$;

create or replace function public.horsebook_reconcile_lesson_credit_state(
  target_lesson_id uuid,
  forced_desired_net integer default null,
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

  desired_net := coalesce(forced_desired_net, public.horsebook_lesson_credit_desired_net(lesson_row, anchor));
  if desired_net is null then
    return 0;
  end if;

  for target_package_id in
    select package_id from public.horsebook_lesson_credit_package_ids(lesson_row)
  loop
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

create or replace function public.horsebook_reconcile_completed_lesson_credits(anchor timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lesson_record record;
  occurrence_record record;
  lesson_row public.lessons;
  desired_net integer;
  changed_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('horsebook_reconcile_completed_lesson_credits'));

  for lesson_record in
    select id from public.lessons
  loop
    changed_count := changed_count
      + public.horsebook_reconcile_lesson_credit_state(lesson_record.id, null, anchor);
  end loop;

  for occurrence_record in
    select distinct package_id, lesson_id, lesson_date, lesson_start_minute
    from public.package_transactions
    where lesson_id is not null
      and lesson_date is not null
      and lesson_date >= public.horsebook_credit_tracking_cutoff()::date
      and (
        type in ('lesson_use', 'lesson_cancel')
        or (
          type = 'correction'
          and (
            source_key like 'lesson_restore|%'
            or source_key like 'lesson_adjust|%'
          )
        )
      )
  loop
    select *
    into lesson_row
    from public.lessons
    where id = occurrence_record.lesson_id;

    desired_net := 0;

    if lesson_row.id is not null then
      desired_net := coalesce(public.horsebook_lesson_credit_desired_net(lesson_row, anchor), 0);

      if desired_net <> 0 and not exists (
        select 1
        from public.horsebook_lesson_credit_package_ids(lesson_row) expected
        where expected.package_id = occurrence_record.package_id
      ) then
        desired_net := 0;
      end if;
    end if;

    if public.horsebook_ensure_lesson_credit_net(
      occurrence_record.package_id,
      occurrence_record.lesson_id,
      occurrence_record.lesson_date,
      occurrence_record.lesson_start_minute,
      desired_net
    ) then
      changed_count := changed_count + 1;
    end if;
  end loop;

  return changed_count;
end;
$$;

create or replace function public.horsebook_fill_recurring_lessons(anchor_date date default public.horsebook_local_today())
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  horizon_date date := public.horsebook_recurring_fill_horizon(anchor_date);
  parent_row public.lessons;
  next_date date;
  attached_id uuid;
  changed_count integer := 0;
  max_iterations integer;
begin
  if current_setting('horsebook.filling_recurring_lessons', true) = 'on' then
    return 0;
  end if;

  perform set_config('horsebook.filling_recurring_lessons', 'on', true);
  perform pg_advisory_xact_lock(hashtext('horsebook_fill_recurring_lessons'));

  select greatest(
    coalesce(
      (
        ceil(
          greatest(horizon_date - min(date), 0)::numeric / 7
        )::integer + 2
      ) * greatest(count(*), 1),
      0
    ),
    256
  )
  into max_iterations
  from public.lessons
  where recurring is true
    and date + 7 <= horizon_date;

  for iteration in 1..max_iterations loop
    select *
    into parent_row
    from public.lessons parent
    where parent.recurring is true
      and parent.date + 7 <= horizon_date
      and not exists (
        select 1
        from public.lessons child
        where child.recurring_parent_id = parent.id
          and child.date = parent.date + 7
      )
    order by parent.date, parent.start_minute, parent.created_at, parent.id
    limit 1
    for update skip locked;

    if parent_row.id is null then
      exit;
    end if;

    next_date := parent_row.date + 7;
    attached_id := null;

    update public.lessons orphaned_child
    set recurring_parent_id = null
    where orphaned_child.recurring_parent_id = parent_row.id
      and orphaned_child.date <> next_date;

    update public.lessons existing
    set recurring = true,
        recurring_parent_id = parent_row.id,
        recurring_until = null
    where existing.id = (
      select candidate.id
      from public.lessons candidate
      where candidate.id <> parent_row.id
        and candidate.recurring_parent_id is null
        and candidate.date = next_date
        and coalesce(candidate.start_minute, 0) = coalesce(parent_row.start_minute, 0)
        and coalesce(candidate.duration_minutes, 0) = coalesce(parent_row.duration_minutes, 0)
        and coalesce(candidate.lesson_type, 'individual') = coalesce(parent_row.lesson_type, 'individual')
        and coalesce(candidate.title, '') = coalesce(parent_row.title, '')
        and coalesce(candidate.horse_name, '') = coalesce(parent_row.horse_name, '')
        and coalesce(candidate.instructor_name, '') = coalesce(parent_row.instructor_name, '')
        and coalesce(candidate.package_mode, true) = coalesce(parent_row.package_mode, true)
        and coalesce(candidate.group_name, '') = coalesce(parent_row.group_name, '')
        and coalesce(candidate.group_color, '') = coalesce(parent_row.group_color, '')
        and coalesce(candidate.participants, '[]'::jsonb) = coalesce(parent_row.participants, '[]'::jsonb)
      order by candidate.created_at, candidate.id
      limit 1
    )
    returning existing.id into attached_id;

    if attached_id is not null then
      changed_count := changed_count + 1;
      continue;
    end if;

    insert into public.lessons(
      id,
      legacy_id,
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
      instance_overrides
    )
    values (
      gen_random_uuid(),
      null,
      parent_row.title,
      next_date,
      parent_row.start_minute,
      parent_row.duration_minutes,
      parent_row.horse_id,
      parent_row.horse_name,
      parent_row.instructor_id,
      parent_row.instructor_name,
      true,
      parent_row.id,
      null,
      parent_row.lesson_type,
      parent_row.package_mode,
      parent_row.group_name,
      parent_row.group_color,
      coalesce(parent_row.participants, '[]'::jsonb),
      '[]'::jsonb,
      '[]'::jsonb,
      '{}'::jsonb
    );

    changed_count := changed_count + 1;
  end loop;

  perform set_config('horsebook.filling_recurring_lessons', 'off', true);
  return changed_count;
end;
$$;

create or replace function public.horsebook_reconcile_lesson_credit_cleanup(lesson_row public.lessons)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_package_id uuid;
  changed_count integer := 0;
begin
  if lesson_row.id is null then
    return 0;
  end if;

  for target_package_id in
    select package_id from public.horsebook_lesson_credit_package_ids(lesson_row)
    union
    select distinct package_id
    from public.package_transactions
    where lesson_id = lesson_row.id
      and package_id is not null
      and (
        type in ('lesson_use', 'lesson_cancel')
        or (
          type = 'correction'
          and (
            source_key like 'lesson_restore|%'
            or source_key like 'lesson_adjust|%'
          )
        )
      )
  loop
    if public.horsebook_ensure_lesson_credit_net(
      target_package_id,
      lesson_row.id,
      lesson_row.date,
      lesson_row.start_minute,
      0
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
begin
  if coalesce(current_setting('horsebook.filling_recurring_lessons', true), '') = 'on' then
    return new;
  end if;

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

  if tg_op = 'UPDATE'
    and (
      old.date is distinct from new.date
      or old.start_minute is distinct from new.start_minute
      or old.duration_minutes is distinct from new.duration_minutes
      or old.lesson_type is distinct from new.lesson_type
      or old.title is distinct from new.title
      or old.package_mode is distinct from new.package_mode
      or old.participants is distinct from new.participants
      or old.cancelled_dates is distinct from new.cancelled_dates
    )
  then
    perform public.horsebook_reconcile_lesson_credit_cleanup(old);
  end if;

  perform public.horsebook_reconcile_lesson_credit_state(new.id);
  return new;
end;
$$;

create or replace function public.horsebook_before_lesson_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.horsebook_reconcile_lesson_credit_cleanup(old);
  return old;
end;
$$;

create or replace function public.horsebook_after_lessons_delete_fill_recurring()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('horsebook.filling_recurring_lessons', true), '') <> 'on' then
    perform public.horsebook_fill_recurring_lessons();
  end if;
  return null;
end;
$$;

create or replace function public.horsebook_run_server_maintenance(anchor timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  local_date date := public.horsebook_local_today(anchor);
  filled_count integer := 0;
  credit_count integer := 0;
begin
  credit_count := public.horsebook_reconcile_completed_lesson_credits(anchor);
  filled_count := public.horsebook_fill_recurring_lessons(local_date);

  return jsonb_build_object(
    'recurringLessonsCreatedOrLinked', filled_count,
    'creditTransactionsCreated', credit_count
  );
end;
$$;

drop trigger if exists horsebook_lessons_after_write_server_maintenance on public.lessons;
create trigger horsebook_lessons_after_write_server_maintenance
after insert or update on public.lessons
for each row execute function public.horsebook_after_lesson_write();

drop trigger if exists horsebook_lessons_before_delete_credit_reconcile on public.lessons;
create trigger horsebook_lessons_before_delete_credit_reconcile
before delete on public.lessons
for each row execute function public.horsebook_before_lesson_delete();

drop trigger if exists horsebook_lessons_after_delete_fill_recurring on public.lessons;
create trigger horsebook_lessons_after_delete_fill_recurring
after delete on public.lessons
for each statement execute function public.horsebook_after_lessons_delete_fill_recurring();

-- Immediate deployment fill keeps active recurring chains copied weekly for
-- a rolling 28-day buffer.
select public.horsebook_fill_recurring_lessons();
select public.horsebook_reconcile_completed_lesson_credits();

do $do$
begin
  begin
    perform cron.unschedule('horsebook-server-maintenance');
  exception when others then
    null;
  end;

  perform cron.schedule(
    'horsebook-server-maintenance',
    '10 * * * *',
    $$select public.horsebook_run_server_maintenance();$$
  );
end;
$do$;

revoke all on function public.horsebook_fill_recurring_lessons(date) from public;
revoke all on function public.horsebook_reconcile_completed_lesson_credits(timestamptz) from public;
revoke all on function public.horsebook_run_server_maintenance(timestamptz) from public;
grant execute on function public.horsebook_fill_recurring_lessons(date) to authenticated;
grant execute on function public.horsebook_reconcile_completed_lesson_credits(timestamptz) to authenticated;
grant execute on function public.horsebook_run_server_maintenance(timestamptz) to authenticated;
