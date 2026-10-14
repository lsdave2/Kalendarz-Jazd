-- Weekly batches are independent lessons. The final-lesson flag is informational.
alter table horsebook.lessons add column is_last_in_series boolean not null default false;

-- Detach old occurrences and record this conversion in audit history.
do $$ declare op uuid; begin
  if exists(select 1 from horsebook.lessons where series_id is not null) then
    op:=gen_random_uuid();
    insert into horsebook.operations(id,name,request,actor_id,actor_name)
      values(op,'migrate_standalone_lessons','{}','00000000-0000-0000-0000-000000000000','Database migration');
    perform set_config('horsebook.operation_id',op::text,true);
    update horsebook.lessons l set is_last_in_series=(not s.stopped and not exists(
      select 1 from horsebook.lessons later where later.series_id=l.series_id and later.occurrence_date>l.occurrence_date))
      from horsebook.series s where s.id=l.series_id;
    update horsebook.lessons set series_id=null,occurrence_date=null,revision=revision+1 where series_id is not null;
    update horsebook.operations set result='{"converted":true}' where id=op;
    perform set_config('horsebook.operation_id','',true);
  end if;
end $$;

alter function horsebook.save_lesson(integer,jsonb,uuid,date) rename to save_lesson_fields;
create function horsebook.save_lesson(expected integer,payload jsonb,target_series uuid default null,occurrence date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved jsonb; begin
  saved:=horsebook.save_lesson_fields(expected,payload);
  if payload ? 'is_last_in_series' then
    update horsebook.lessons set is_last_in_series=coalesce((payload->>'is_last_in_series')::boolean,false)
      where id=(saved->>'id')::uuid and is_last_in_series is distinct from coalesce((payload->>'is_last_in_series')::boolean,false);
  end if;
  return saved || jsonb_build_object('is_last_in_series',(select is_last_in_series from horsebook.lessons where id=(saved->>'id')::uuid));
end $$;
revoke all on function horsebook.save_lesson(integer,jsonb,uuid,date) from public,anon,authenticated;

create function public.hb_duplicate_lesson(p_operation_id uuid,p_expected_revision integer,p_lesson jsonb,p_weeks integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; saved jsonb; item jsonb; bookings jsonb; payload jsonb; d date;
  created jsonb := '[]'; copies integer; begin
  cached:=horsebook.begin_operation(p_operation_id,'duplicate_lesson',jsonb_build_object('revision',p_expected_revision,'lesson',p_lesson,'weeks',p_weeks));
  if cached is not null then return cached; end if;
  if p_weeks is null or p_weeks<1 or p_weeks>(case when p_expected_revision is null then 53 else 52 end) then
    raise exception 'Choose a valid whole number of weeks'; end if;
  saved:=horsebook.save_lesson(p_expected_revision,p_lesson || jsonb_build_object('is_last_in_series',p_expected_revision is null and p_weeks=1));
  copies:=case when p_expected_revision is null then p_weeks-1 else p_weeks end;
  if p_expected_revision is null then created:=jsonb_build_array(saved); end if;
  d:=(p_lesson->>'date')::date;
  for n in 1..copies loop
    d:=d+7; bookings:='[]';
    for item in select value from jsonb_array_elements(p_lesson->'bookings') loop
      bookings:=bookings || jsonb_build_array((item-'id'-'attendance') || jsonb_build_object('id',gen_random_uuid(),'attendance','unknown'));
    end loop;
    payload:=(p_lesson-'id') || jsonb_build_object('id',gen_random_uuid(),'date',d,'status','scheduled','bookings',bookings,'is_last_in_series',n=copies);
    created:=created || jsonb_build_array(horsebook.save_lesson(null,payload));
  end loop;
  return horsebook.finish_operation(p_operation_id,jsonb_build_object('lesson',saved,'lessons',created));
end $$;
revoke all on function public.hb_duplicate_lesson(uuid,integer,jsonb,integer) from public,anon,authenticated;
grant execute on function public.hb_duplicate_lesson(uuid,integer,jsonb,integer) to authenticated;

-- Older creation clients also receive independent lessons.
create or replace function public.hb_create_series(p_operation_id uuid,p_lesson jsonb,p_until date)
returns jsonb language plpgsql security definer set search_path = '' as $$ begin
  if p_until is null or p_until<(p_lesson->>'date')::date or p_until>(p_lesson->>'date')::date+366 then
    raise exception 'Weekly batch must end within one year'; end if;
  return public.hb_duplicate_lesson(p_operation_id,null,p_lesson,((p_until-(p_lesson->>'date')::date)/7)+1);
end $$;
revoke execute on function public.hb_stop_series(uuid,uuid,integer,date) from authenticated;
insert into horsebook.schema_version values(10);
