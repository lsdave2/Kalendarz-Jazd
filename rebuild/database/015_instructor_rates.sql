-- One hourly payment rate per instructor, shared by every lesson type.
alter table horsebook.instructors
  add column lesson_rate numeric(12,2) not null default 60
    check (lesson_rate >= 0 and lesson_rate <> 'NaN'::numeric);

create or replace function public.hb_save_reference(p_operation_id uuid, p_kind text, p_expected_revision integer, p_record jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; record_id uuid; row_data jsonb; current_revision integer; begin
  cached := horsebook.begin_operation(p_operation_id,'save_reference',jsonb_build_object('kind',p_kind,'revision',p_expected_revision,'record',p_record));
  if cached is not null then return cached; end if;
  if p_kind not in ('clients','horses','instructors') then raise exception 'Invalid reference kind'; end if;
  record_id := coalesce((p_record->>'id')::uuid,gen_random_uuid());
  if coalesce(length(btrim(p_record->>'name')),0) not between 1 and 200 then raise exception 'Name is required (maximum 200 characters)'; end if;
  execute format('select revision from horsebook.%I where id=$1 for update',p_kind) into current_revision using record_id;
  if current_revision is not null then
    if p_expected_revision is distinct from current_revision then raise exception 'Record changed; reload before saving' using errcode = '40001'; end if;
    execute format('update horsebook.%I set name=$2, archived=$3,revision=revision+1 where id=$1',p_kind)
      using record_id,btrim(p_record->>'name'),coalesce((p_record->>'archived')::boolean,false);
  else
    if p_expected_revision is not null then raise exception 'Record no longer exists' using errcode='40001'; end if;
    execute format('insert into horsebook.%I(id,name,archived) values($1,$2,$3)',p_kind)
      using record_id,btrim(p_record->>'name'),coalesce((p_record->>'archived')::boolean,false);
    if p_kind='clients' then insert into horsebook.accounts(client_id) values(record_id); end if;
  end if;
  if p_kind='instructors' then
    update horsebook.instructors set color=coalesce(p_record->>'color','#7c5cfc'),
      lesson_rate=case when p_record ? 'lesson_rate' then (p_record->>'lesson_rate')::numeric else lesson_rate end
      where id=record_id;
  elsif p_kind='clients' then
    update horsebook.clients set payment_rate=(p_record->>'payment_rate')::numeric,
      phone_number=case when p_record ? 'phone_number'
        then nullif(btrim(p_record->>'phone_number'),'') else phone_number end
      where id=record_id;
  end if;
  execute format('select to_jsonb(t) from horsebook.%I t where id=$1',p_kind) into row_data using record_id;
  return horsebook.finish_operation(p_operation_id,row_data);
end $$;

create or replace function public.hb_save_setting(p_operation_id uuid,p_key text,p_expected_revision integer,p_value jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; rev integer; rate_key text; begin
  cached:=horsebook.begin_operation(p_operation_id,'save_setting',jsonb_build_object('key',p_key,'revision',p_expected_revision,'value',p_value));
  if cached is not null then return cached; end if;
  if p_key='closed_dates' then
    if jsonb_typeof(p_value) is distinct from 'array' then raise exception 'Closed dates must be an array'; end if;
    perform (value#>>'{}')::date from jsonb_array_elements(p_value);
  elsif p_key='schedule_hours' then
    if jsonb_typeof(p_value) is distinct from 'object' or (p_value->>'start')::integer is null or (p_value->>'end')::integer is null
      or (p_value->>'start')::integer<0 or (p_value->>'end')::integer>24 or (p_value->>'start')::integer >= (p_value->>'end')::integer then
      raise exception 'Invalid schedule hours'; end if;
  elsif p_key='report_rates' then
    if jsonb_typeof(p_value) is distinct from 'object' then raise exception 'Report rates must be an object'; end if;
    foreach rate_key in array array['package_individual','package_group','revenue_individual','revenue_group','instructor_individual','instructor_group'] loop
      if rate_key not in ('package_individual','package_group') and not (p_value ? rate_key) then continue; end if;
      if jsonb_typeof(p_value->rate_key) is distinct from 'number' or (p_value->>rate_key)::numeric<0 or (p_value->>rate_key)::numeric>100000 then
        raise exception 'Report rates must be nonnegative numbers'; end if;
    end loop;
  else raise exception 'Unknown setting'; end if;
  select revision into rev from horsebook.settings where key=p_key for update;
  if rev is distinct from p_expected_revision then raise exception 'Setting changed; reload before saving' using errcode='40001'; end if;
  insert into horsebook.settings(key,value) values(p_key,p_value)
    on conflict(key) do update set value=excluded.value,revision=horsebook.settings.revision+1;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(s) from horsebook.settings s where key=p_key));
end $$;

insert into horsebook.schema_version values(15);
