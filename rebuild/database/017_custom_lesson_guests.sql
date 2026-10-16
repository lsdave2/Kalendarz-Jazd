-- One-off custom participants belong to their lesson, never the client list.
alter table horsebook.bookings alter column client_id drop not null;
alter table horsebook.bookings add column guest_name text;
alter table horsebook.bookings add constraint booking_participant_identity check (
  (client_id is not null and guest_name is null) or
  (client_id is null and guest_name is not null and length(btrim(guest_name)) between 1 and 200 and billing_mode='cash')
);

create or replace function horsebook.save_lesson_fields(expected integer, payload jsonb, target_series uuid default null, occurrence date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare lid uuid; old_l horsebook.lessons; item jsonb; bid uuid; old_b horsebook.bookings;
  kept uuid[] := array[]::uuid[]; schedule_changed boolean; billing_changed boolean; begin
  lid := coalesce((payload->>'id')::uuid,gen_random_uuid());
  select * into old_l from horsebook.lessons where id=lid for update;
  if found then
    if expected is distinct from old_l.revision then raise exception 'Lesson changed; reload before saving' using errcode='40001'; end if;
    -- Historical time/date/duration corrections retain existing credit decisions.
    -- Recheck cancellation changes or an ended lesson moved to a future end time.
    schedule_changed := old_l.status is distinct from coalesce(payload->>'status','scheduled') or (
      ((old_l.date + make_interval(mins=>old_l.start_minute+old_l.duration_minutes)) at time zone 'Europe/Warsaw') <= now()
      and (((payload->>'date')::date + make_interval(mins=>(payload->>'start_minute')::integer+(payload->>'duration_minutes')::integer)) at time zone 'Europe/Warsaw') > now());
    update horsebook.lessons set date=(payload->>'date')::date,start_minute=(payload->>'start_minute')::integer,
      duration_minutes=(payload->>'duration_minutes')::integer,title=coalesce(payload->>'title',''),kind=payload->>'kind',
      instructor_id=(payload->>'instructor_id')::uuid,status=coalesce(payload->>'status','scheduled'),
      notes=coalesce(payload->>'notes',''),revision=revision+1 where id=lid;
  else
    if expected is not null then raise exception 'Lesson no longer exists' using errcode='40001'; end if;
    schedule_changed := false;
    insert into horsebook.lessons(id,date,start_minute,duration_minutes,title,kind,instructor_id,status,notes,series_id,occurrence_date)
      values(lid,(payload->>'date')::date,(payload->>'start_minute')::integer,(payload->>'duration_minutes')::integer,
        coalesce(payload->>'title',''),payload->>'kind',(payload->>'instructor_id')::uuid,
        coalesce(payload->>'status','scheduled'),coalesce(payload->>'notes',''),target_series,occurrence);
  end if;
  if jsonb_typeof(payload->'bookings') is distinct from 'array' or jsonb_array_length(payload->'bookings') not between 1 and 50 then
    raise exception 'A lesson needs between 1 and 50 participants'; end if;
  if payload->>'kind'='individual' and jsonb_array_length(payload->'bookings')<>1 then raise exception 'Individual lesson needs one participant'; end if;
  for item in select value from jsonb_array_elements(payload->'bookings') loop
    bid := coalesce((item->>'id')::uuid,gen_random_uuid());
    if bid=any(kept) then raise exception 'Duplicate booking ID'; end if;
    kept := array_append(kept,bid);
    select * into old_b from horsebook.bookings where id=bid for update;
    if found and old_b.lesson_id<>lid then raise exception 'Booking belongs to another lesson'; end if;
    -- A booking's client is immutable. Replacing a participant removes the old
    -- booking and creates a new one, keeping its financial history attributable.
    if old_b.id is not null and old_b.client_id is distinct from (item->>'client_id')::uuid then
      raise exception 'Replace the booking to change its client'; end if;
    if payload->>'kind'<>'custom' and old_b.id is null and not exists(select 1 from horsebook.clients where id=(item->>'client_id')::uuid and not archived) then
      raise exception 'Select an active client'; end if;
    if payload->>'kind'='custom' then
      if nullif(item->>'client_id','') is not null or coalesce(item->>'billing_mode','cash')<>'cash'
        or coalesce(length(btrim(item->>'guest_name')),0) not between 1 and 200 then
        raise exception 'Custom lessons require a guest name and cash billing'; end if;
    elsif nullif(item->>'client_id','') is null or item->>'guest_name' is not null then
      raise exception 'Select an active client';
    end if;
    billing_changed := schedule_changed or (old_b.billing_mode,old_b.units,old_b.attendance,old_b.removed) is distinct from
      (coalesce(item->>'billing_mode','package'),coalesce((item->>'units')::integer,1),coalesce(item->>'attendance','unknown'),false);
    if old_b.id is not null then
      update horsebook.bookings set guest_name=item->>'guest_name',horse_id=(item->>'horse_id')::uuid,instructor_id=(item->>'instructor_id')::uuid,
        billing_mode=coalesce(item->>'billing_mode','package'),units=coalesce((item->>'units')::integer,1),
        cash_amount=coalesce((item->>'cash_amount')::numeric,0),attendance=coalesce(item->>'attendance','unknown'),removed=false,
        review_status=case when billing_changed and last_decision_id is not null then 'needs_review' else review_status end,
        revision=revision+1 where id=bid;
    else
      insert into horsebook.bookings(id,lesson_id,client_id,guest_name,horse_id,instructor_id,billing_mode,units,cash_amount,attendance)
        values(bid,lid,(item->>'client_id')::uuid,item->>'guest_name',(item->>'horse_id')::uuid,(item->>'instructor_id')::uuid,
          coalesce(item->>'billing_mode','package'),coalesce((item->>'units')::integer,1),coalesce((item->>'cash_amount')::numeric,0),coalesce(item->>'attendance','unknown'));
    end if;
  end loop;
  update horsebook.bookings set removed=true,revision=revision+1,
    review_status=case when last_decision_id is not null then 'needs_review' else review_status end
    where lesson_id=lid and not (id=any(kept)) and not removed;
  return (select to_jsonb(l) || jsonb_build_object('bookings',(
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from horsebook.bookings b where lesson_id=lid)) from horsebook.lessons l where id=lid);
end $$;

create or replace function horsebook.save_lesson(expected integer,payload jsonb,target_series uuid default null,occurrence date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved jsonb; item jsonb; bookings jsonb := '[]'; client_name text; cid uuid; matches integer;
begin
  if jsonb_typeof(payload->'bookings') is distinct from 'array' or jsonb_array_length(payload->'bookings') not between 1 and 50 then
    raise exception 'A lesson needs between 1 and 50 participants'; end if;
  for item in select value from jsonb_array_elements(payload->'bookings') loop
    if payload->>'kind'='custom' then
      if item ? 'client_name' and coalesce(length(btrim(item->>'client_name')),0) not between 1 and 200 then
        raise exception 'Custom lessons require a guest name and cash billing'; end if;
      client_name:=coalesce(nullif(btrim(item->>'client_name'),''),nullif(btrim(item->>'guest_name'),''),
        (select name from horsebook.clients where id=nullif(item->>'client_id','')::uuid),
        (select coalesce(b.guest_name,c.name) from horsebook.bookings b left join horsebook.clients c on c.id=b.client_id
          where b.id=(item->>'id')::uuid and b.lesson_id=(payload->>'id')::uuid));
      -- An old linked participant gets a new booking, retaining its prior history.
      if exists(select 1 from horsebook.bookings where id=(item->>'id')::uuid and client_id is not null and lesson_id=(payload->>'id')::uuid) then
        item:=item || jsonb_build_object('id',gen_random_uuid());
      end if;
      item:=(item-'client_name') || jsonb_build_object('client_id',null,'guest_name',client_name,'billing_mode','cash');
    elsif nullif(item->>'client_id','') is null then
      client_name:=btrim(item->>'client_name');
      if coalesce(length(client_name),0) not between 1 and 200 then
        raise exception 'Name is required (maximum 200 characters)'; end if;
      select count(*),min(id::text)::uuid into matches,cid from horsebook.clients
        where lower(btrim(name))=lower(client_name) and not archived;
      if matches>1 then raise exception 'Several clients have this name; select an existing client'; end if;
      if matches=0 then
        if exists(select 1 from horsebook.clients where lower(btrim(name))=lower(client_name) and archived) then
          raise exception 'This client is archived; restore the client before adding a lesson'; end if;
        insert into horsebook.clients(name) values(client_name) returning id into cid;
        insert into horsebook.accounts(client_id) values(cid);
      end if;
      item:=(item-'client_name') || jsonb_build_object('client_id',cid);
    end if;
    bookings:=bookings || jsonb_build_array(item);
  end loop;
  saved:=horsebook.save_lesson_fields(expected,payload || jsonb_build_object('bookings',bookings));
  if payload ? 'is_last_in_series' then
    update horsebook.lessons set is_last_in_series=coalesce((payload->>'is_last_in_series')::boolean,false)
      where id=(saved->>'id')::uuid and is_last_in_series is distinct from coalesce((payload->>'is_last_in_series')::boolean,false);
  end if;
  return saved || jsonb_build_object('is_last_in_series',(select is_last_in_series from horsebook.lessons where id=(saved->>'id')::uuid));
end $$;
revoke all on function horsebook.save_lesson(integer,jsonb,uuid,date) from public,anon,authenticated;

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
        || jsonb_build_object('client_name',coalesce(b.guest_name,c.name),'horse_name',h.name,'instructor_name',bi.name)
        order by coalesce(b.guest_name,c.name),b.id),'[]') from horsebook.bookings b left join horsebook.clients c on c.id=b.client_id
          left join horsebook.horses h on h.id=b.horse_id left join horsebook.instructors bi on bi.id=b.instructor_id
        where b.lesson_id=l.id and (admin or not b.removed))) order by l.date,l.start_minute,l.id),'[]')
    from horsebook.lessons l left join horsebook.instructors i on i.id=l.instructor_id left join horsebook.series s on s.id=l.series_id
    where l.date between p_from and p_to),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.date,e.start_minute,e.id),'[]') from horsebook.events e where e.date between p_from and p_to),
    'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from horsebook.settings x));
end $$;


insert into horsebook.schema_version values(17);
