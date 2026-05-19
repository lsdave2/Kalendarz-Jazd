-- Do not record audit entries when an UPDATE only changes updated_at.
-- The set_updated_at trigger intentionally touches updated_at on every write,
-- but those rows add noise without representing a business data change.

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
  visible_changed text[];
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

    select array_agg(field_name order by field_name)
      into visible_changed
    from unnest(changed) as field_name
    where field_name <> 'updated_at';

    if coalesce(array_length(visible_changed, 1), 0) = 0 then
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

comment on function public.log_row_change() is
  'Trigger function that records actual INSERT, UPDATE, and DELETE row mutations with auth.uid() attribution, ignoring updated_at-only updates.';
