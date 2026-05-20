-- Make browser saves atomic and keep package credits ledger-derived.
--
-- The client sends one normalized application snapshot to this RPC. PostgreSQL
-- applies the related table changes inside the function call's transaction,
-- avoiding partial multi-table browser syncs.

create or replace function public.recompute_package_current_credits(target_package_id uuid)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.packages
  set current_credits = coalesce((
    select sum(amount)::integer
    from public.package_transactions
    where package_id = target_package_id
  ), 0)
  where id = target_package_id;
end;
$$;

create or replace function public.refresh_package_current_credits_from_tx()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.recompute_package_current_credits(new.package_id);
  end if;

  if tg_op = 'UPDATE' and old.package_id is distinct from new.package_id then
    perform public.recompute_package_current_credits(old.package_id);
  end if;

  if tg_op = 'DELETE' then
    perform public.recompute_package_current_credits(old.package_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists refresh_package_current_credits_after_tx on public.package_transactions;
create trigger refresh_package_current_credits_after_tx
after insert or update or delete on public.package_transactions
for each row execute function public.refresh_package_current_credits_from_tx();

create or replace function public.horsebook_apply_snapshot(snapshot jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  keep_horse_names text[] := array[]::text[];
  keep_instructor_names text[] := array[]::text[];
  keep_group_ids uuid[] := array[]::uuid[];
  keep_package_ids uuid[] := array[]::uuid[];
  keep_lesson_ids uuid[] := array[]::uuid[];
  keep_expense_ids uuid[] := array[]::uuid[];
  keep_income_ids uuid[] := array[]::uuid[];
  horse_name_value text;
  instructor_name_value text;
  package_id_value uuid;
  lesson_id_value uuid;
  source_key_value text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if snapshot is null or jsonb_typeof(snapshot) <> 'object' then
    raise exception 'Snapshot must be a JSON object';
  end if;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'horses', '[]'::jsonb))
  loop
    horse_name_value := btrim(item #>> '{}');
    if horse_name_value <> '' then
      keep_horse_names := array_append(keep_horse_names, horse_name_value);
      insert into public.horses(name)
      values (horse_name_value)
      on conflict (name) do nothing;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'instructors', '[]'::jsonb))
  loop
    instructor_name_value := btrim(coalesce(item ->> 'name', ''));
    if instructor_name_value <> '' then
      keep_instructor_names := array_append(keep_instructor_names, instructor_name_value);
      insert into public.instructors(name, color)
      values (instructor_name_value, coalesce(item ->> 'color', '#777777'))
      on conflict (name) do update set
        color = excluded.color;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'groups', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') <> '' and btrim(coalesce(item ->> 'name', '')) <> '' then
      keep_group_ids := array_append(keep_group_ids, (item ->> 'id')::uuid);
      insert into public.groups(id, name, color)
      values (
        (item ->> 'id')::uuid,
        btrim(item ->> 'name'),
        coalesce(item ->> 'color', '#777777')
      )
      on conflict (id) do update set
        name = excluded.name,
        color = excluded.color;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'packages', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') <> '' and btrim(coalesce(item ->> 'name', '')) <> '' then
      package_id_value := (item ->> 'id')::uuid;
      keep_package_ids := array_append(keep_package_ids, package_id_value);
      insert into public.packages(
        id,
        name,
        credits,
        current_credits,
        active,
        archived_at,
        history,
        custom_payment_rate,
        has_package_lessons
      )
      values (
        package_id_value,
        btrim(item ->> 'name'),
        coalesce((item ->> 'legacyCredits')::integer, (item ->> 'credits')::integer, 0),
        coalesce((item ->> 'currentCredits')::integer, (item ->> 'credits')::integer, 0),
        coalesce((item ->> 'active')::boolean, true),
        nullif(item ->> 'archivedAt', '')::timestamptz,
        '[]'::jsonb,
        nullif(item ->> 'customPaymentRate', '')::numeric,
        coalesce((item ->> 'hasPackageLessons')::boolean, false)
      )
      on conflict (id) do update set
        name = excluded.name,
        credits = excluded.credits,
        current_credits = excluded.current_credits,
        active = excluded.active,
        archived_at = excluded.archived_at,
        history = '[]'::jsonb,
        custom_payment_rate = excluded.custom_payment_rate,
        has_package_lessons = excluded.has_package_lessons;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'lessons', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') = '' then
      continue;
    end if;

    lesson_id_value := (item ->> 'id')::uuid;
    keep_lesson_ids := array_append(keep_lesson_ids, lesson_id_value);
    horse_name_value := nullif(btrim(coalesce(item ->> 'horse', '')), '');
    instructor_name_value := nullif(btrim(coalesce(item ->> 'instructor', '')), '');

    if horse_name_value is not null then
      keep_horse_names := array_append(keep_horse_names, horse_name_value);
      insert into public.horses(name)
      values (horse_name_value)
      on conflict (name) do nothing;
    end if;

    if instructor_name_value is not null then
      keep_instructor_names := array_append(keep_instructor_names, instructor_name_value);
      insert into public.instructors(name, color)
      values (instructor_name_value, '#777777')
      on conflict (name) do nothing;
    end if;

    insert into public.lessons(
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
      instance_overrides
    )
    values (
      lesson_id_value,
      coalesce(item ->> 'title', ''),
      (item ->> 'date')::date,
      coalesce((item ->> 'startMinute')::integer, 0),
      coalesce((item ->> 'durationMinutes')::integer, 0),
      (select id from public.horses where name = horse_name_value),
      horse_name_value,
      (select id from public.instructors where name = instructor_name_value),
      instructor_name_value,
      coalesce((item ->> 'recurring')::boolean, false),
      nullif(item ->> 'recurringParentId', '')::uuid,
      null,
      coalesce(item ->> 'lessonType', 'individual'),
      coalesce((item ->> 'packageMode')::boolean, true),
      nullif(item ->> 'groupName', ''),
      nullif(item ->> 'groupColor', ''),
      coalesce(item -> 'participants', '[]'::jsonb),
      coalesce(item -> 'cancelledDates', '[]'::jsonb),
      '[]'::jsonb,
      '{}'::jsonb
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
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'packageTransactions', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') = '' or coalesce(item ->> 'packageId', '') = '' then
      continue;
    end if;

    if not exists (
      select 1 from public.packages where id = (item ->> 'packageId')::uuid
    ) then
      continue;
    end if;

    source_key_value := nullif(item ->> 'sourceKey', '');

    if source_key_value is not null then
      insert into public.package_transactions(
        id,
        package_id,
        type,
        amount,
        lesson_id,
        lesson_date,
        lesson_start_minute,
        note,
        created_at,
        source_key
      )
      values (
        (item ->> 'id')::uuid,
        (item ->> 'packageId')::uuid,
        coalesce(item ->> 'type', 'correction'),
        coalesce((item ->> 'amount')::integer, 0),
        nullif(item ->> 'lessonId', '')::uuid,
        nullif(item ->> 'lessonDate', '')::date,
        nullif(item ->> 'lessonStartMinute', '')::integer,
        nullif(item ->> 'note', ''),
        coalesce(nullif(item ->> 'date', '')::timestamptz, timezone('utc', now())),
        source_key_value
      )
      on conflict (source_key) do nothing;
    else
      insert into public.package_transactions(
        id,
        package_id,
        type,
        amount,
        lesson_id,
        lesson_date,
        lesson_start_minute,
        note,
        created_at,
        source_key
      )
      values (
        (item ->> 'id')::uuid,
        (item ->> 'packageId')::uuid,
        coalesce(item ->> 'type', 'correction'),
        coalesce((item ->> 'amount')::integer, 0),
        nullif(item ->> 'lessonId', '')::uuid,
        nullif(item ->> 'lessonDate', '')::date,
        nullif(item ->> 'lessonStartMinute', '')::integer,
        nullif(item ->> 'note', ''),
        coalesce(nullif(item ->> 'date', '')::timestamptz, timezone('utc', now())),
        null
      )
      on conflict (id) do nothing;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'expenses', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') <> '' then
      keep_expense_ids := array_append(keep_expense_ids, (item ->> 'id')::uuid);
      insert into public.expenses(id, title, cost, date, description)
      values (
        (item ->> 'id')::uuid,
        coalesce(item ->> 'title', ''),
        coalesce((item ->> 'cost')::numeric, 0),
        coalesce(nullif(item ->> 'date', '')::date, current_date),
        coalesce(item ->> 'description', '')
      )
      on conflict (id) do update set
        title = excluded.title,
        cost = excluded.cost,
        date = excluded.date,
        description = excluded.description;
    end if;
  end loop;

  for item in
    select value from jsonb_array_elements(coalesce(snapshot -> 'incomes', '[]'::jsonb))
  loop
    if coalesce(item ->> 'id', '') <> '' then
      keep_income_ids := array_append(keep_income_ids, (item ->> 'id')::uuid);
      insert into public.incomes(id, title, amount, date, description)
      values (
        (item ->> 'id')::uuid,
        coalesce(item ->> 'title', ''),
        coalesce((item ->> 'cost')::numeric, 0),
        coalesce(nullif(item ->> 'date', '')::date, current_date),
        coalesce(item ->> 'description', '')
      )
      on conflict (id) do update set
        title = excluded.title,
        amount = excluded.amount,
        date = excluded.date,
        description = excluded.description;
    end if;
  end loop;

  insert into public.settings(key, value)
  values
    ('closed_dates', coalesce(snapshot -> 'closedDates', '[]'::jsonb)),
    ('credit_tracking_migrated_at', to_jsonb(coalesce(snapshot ->> 'creditTrackingMigratedAt', '2026-05-12T00:00:00.000Z'))),
    ('recurring_chain_migrated_at', coalesce(to_jsonb(snapshot ->> 'recurringChainMigratedAt'), 'null'::jsonb)),
    ('legacy_next_id', to_jsonb(coalesce((snapshot ->> 'nextId')::integer, 1))),
    ('legacy_next_group_id', to_jsonb(coalesce((snapshot ->> 'nextGroupId')::integer, 1)))
  on conflict (key) do update set
    value = excluded.value;

  delete from public.lessons
  where not (id = any(keep_lesson_ids));

  delete from public.groups
  where not (id = any(keep_group_ids));

  delete from public.expenses
  where not (id = any(keep_expense_ids));

  delete from public.incomes
  where not (id = any(keep_income_ids));

  delete from public.packages
  where not (id = any(keep_package_ids));

  delete from public.horses
  where not (name = any(keep_horse_names));

  delete from public.instructors
  where not (name = any(keep_instructor_names));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.horsebook_apply_snapshot(jsonb) from public;
grant execute on function public.horsebook_apply_snapshot(jsonb) to authenticated;
