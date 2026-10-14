create table horsebook.events (
  id uuid primary key default gen_random_uuid(),date date not null,
  start_minute integer not null check(start_minute between 0 and 1439),
  end_minute integer not null check(end_minute between 1 and 1440),
  description text not null check(length(btrim(description)) between 1 and 2000),
  revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),
  check(end_minute>start_minute)
);
create index events_date_idx on horsebook.events(date);
alter table horsebook.events enable row level security;
revoke all on horsebook.events from public,anon,authenticated;
create trigger audit_events_changes after insert or update or delete on horsebook.events
  for each row execute function horsebook.audit_change();

create function public.hb_save_event(p_operation_id uuid,p_expected_revision integer,p_event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; eid uuid; current_revision integer; saved horsebook.events; begin
  cached:=horsebook.begin_operation(p_operation_id,'save_event',jsonb_build_object('revision',p_expected_revision,'event',p_event));
  if cached is not null then return cached; end if;
  eid:=coalesce((p_event->>'id')::uuid,gen_random_uuid());
  select revision into current_revision from horsebook.events where id=eid for update;
  if found then
    if current_revision is distinct from p_expected_revision then raise exception 'Event changed; reload before saving' using errcode='40001'; end if;
    update horsebook.events set date=(p_event->>'date')::date,start_minute=(p_event->>'start_minute')::integer,
      end_minute=(p_event->>'end_minute')::integer,description=btrim(p_event->>'description'),revision=revision+1
      where id=eid returning * into saved;
  else
    if p_expected_revision is not null then raise exception 'Event no longer exists' using errcode='40001'; end if;
    insert into horsebook.events(id,date,start_minute,end_minute,description)
      values(eid,(p_event->>'date')::date,(p_event->>'start_minute')::integer,(p_event->>'end_minute')::integer,btrim(p_event->>'description'))
      returning * into saved;
  end if;
  return horsebook.finish_operation(p_operation_id,to_jsonb(saved));
end $$;

create function public.hb_move_event_time(p_operation_id uuid,p_event_id uuid,p_expected_revision integer,p_start_minute integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; e horsebook.events; saved horsebook.events; begin
  cached:=horsebook.begin_operation(p_operation_id,'move_event_time',jsonb_build_object('id',p_event_id,'revision',p_expected_revision,'start_minute',p_start_minute));
  if cached is not null then return cached; end if;
  select * into e from horsebook.events where id=p_event_id for update;
  if not found or e.revision is distinct from p_expected_revision then raise exception 'Event changed or no longer exists; reload before moving' using errcode='40001'; end if;
  saved:=e;
  if p_start_minute is distinct from e.start_minute then
    update horsebook.events set start_minute=p_start_minute,end_minute=p_start_minute+(e.end_minute-e.start_minute),revision=revision+1
      where id=e.id returning * into saved;
  end if;
  return horsebook.finish_operation(p_operation_id,to_jsonb(saved));
end $$;

create function public.hb_delete_event(p_operation_id uuid,p_event_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; e horsebook.events; begin
  cached:=horsebook.begin_operation(p_operation_id,'delete_event',jsonb_build_object('id',p_event_id,'revision',p_expected_revision));
  if cached is not null then return cached; end if;
  select * into e from horsebook.events where id=p_event_id for update;
  if not found or e.revision is distinct from p_expected_revision then raise exception 'Event changed or no longer exists; reload before deleting' using errcode='40001'; end if;
  delete from horsebook.events where id=e.id;
  return horsebook.finish_operation(p_operation_id,jsonb_build_object('id',e.id,'deleted',true));
end $$;
revoke all on function public.hb_save_event(uuid,integer,jsonb),public.hb_move_event_time(uuid,uuid,integer,integer),public.hb_delete_event(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.hb_save_event(uuid,integer,jsonb),public.hb_move_event_time(uuid,uuid,integer,integer),public.hb_delete_event(uuid,uuid,integer) to authenticated;

create or replace function public.hb_calendar(p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare admin boolean; begin
  if p_from is null or p_to is null or p_to<p_from or p_to>p_from+93 then raise exception 'Choose a date range of at most 94 days'; end if;
  admin:=exists(select 1 from horsebook.admin_members where user_id=auth.uid());
  return jsonb_build_object('lessons',(select coalesce(jsonb_agg(
    (case when admin then to_jsonb(l) else to_jsonb(l)-'notes' end)
    || jsonb_build_object('instructor_name',i.name,'instructor_color',i.color,'series_revision',s.revision,'bookings',(
      select coalesce(jsonb_agg((case when admin then to_jsonb(b) else
        jsonb_build_object('id',b.id,'client_id',b.client_id,'horse_id',b.horse_id,'removed',b.removed,'attendance',b.attendance) end)
        || jsonb_build_object('client_name',c.name,'horse_name',h.name,'instructor_name',bi.name)
        order by c.name,b.id),'[]') from horsebook.bookings b join horsebook.clients c on c.id=b.client_id
          left join horsebook.horses h on h.id=b.horse_id left join horsebook.instructors bi on bi.id=b.instructor_id
        where b.lesson_id=l.id and (admin or not b.removed))) order by l.date,l.start_minute,l.id),'[]')
    from horsebook.lessons l left join horsebook.instructors i on i.id=l.instructor_id left join horsebook.series s on s.id=l.series_id
    where l.date between p_from and p_to),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.date,e.start_minute,e.id),'[]') from horsebook.events e where e.date between p_from and p_to),
    'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from horsebook.settings x));
end $$;

create or replace function horsebook.snapshot() returns jsonb language sql stable set search_path = '' as $$
  select body || jsonb_build_object('schema_version',(select max(version) from horsebook.schema_version),
    'data',(body->'data') || jsonb_build_object('events',(select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from horsebook.events e)))
  from (select horsebook.snapshot_data() as body) base;
$$;
insert into horsebook.schema_version values(9);
