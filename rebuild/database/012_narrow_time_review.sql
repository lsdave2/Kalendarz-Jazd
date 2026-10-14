-- Keep immutable decisions and balances when correcting an ended lesson's time.
-- Existing needs_review flags are retained: their original trigger may be a
-- cancellation, attendance or billing change and must not be silently cleared.
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
    if old_b.id is not null and old_b.client_id<>(item->>'client_id')::uuid then
      raise exception 'Replace the booking to change its client'; end if;
    if old_b.id is null and not exists(select 1 from horsebook.clients where id=(item->>'client_id')::uuid and not archived) then
      raise exception 'Select an active client'; end if;
    billing_changed := schedule_changed or (old_b.billing_mode,old_b.units,old_b.attendance,old_b.removed) is distinct from
      (coalesce(item->>'billing_mode','package'),coalesce((item->>'units')::integer,1),coalesce(item->>'attendance','unknown'),false);
    if old_b.id is not null then
      update horsebook.bookings set horse_id=(item->>'horse_id')::uuid,instructor_id=(item->>'instructor_id')::uuid,
        billing_mode=coalesce(item->>'billing_mode','package'),units=coalesce((item->>'units')::integer,1),
        cash_amount=coalesce((item->>'cash_amount')::numeric,0),attendance=coalesce(item->>'attendance','unknown'),removed=false,
        review_status=case when billing_changed and last_decision_id is not null then 'needs_review' else review_status end,
        revision=revision+1 where id=bid;
    else
      insert into horsebook.bookings(id,lesson_id,client_id,horse_id,instructor_id,billing_mode,units,cash_amount,attendance)
        values(bid,lid,(item->>'client_id')::uuid,(item->>'horse_id')::uuid,(item->>'instructor_id')::uuid,
          coalesce(item->>'billing_mode','package'),coalesce((item->>'units')::integer,1),coalesce((item->>'cash_amount')::numeric,0),coalesce(item->>'attendance','unknown'));
    end if;
  end loop;
  update horsebook.bookings set removed=true,revision=revision+1,
    review_status=case when last_decision_id is not null then 'needs_review' else review_status end
    where lesson_id=lid and not (id=any(kept)) and not removed;
  return (select to_jsonb(l) || jsonb_build_object('bookings',(
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from horsebook.bookings b where lesson_id=lid)) from horsebook.lessons l where id=lid);
end $$;

create or replace function public.hb_move_lesson_time(p_operation_id uuid,p_lesson_id uuid,p_expected_revision integer,p_start_minute integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; l horsebook.lessons; begin
  cached:=horsebook.begin_operation(p_operation_id,'move_lesson_time',jsonb_build_object('id',p_lesson_id,'revision',p_expected_revision,'start_minute',p_start_minute));
  if cached is not null then return cached; end if;
  select * into l from horsebook.lessons where id=p_lesson_id for update;
  if not found or l.revision is distinct from p_expected_revision then
    raise exception 'Lesson changed or no longer exists; reload before moving' using errcode='40001';
  end if;
  if l.status='cancelled' then raise exception 'Cancelled lessons cannot be dragged'; end if;
  if p_start_minute is null or p_start_minute<0 or p_start_minute+l.duration_minutes>1440 then
    raise exception 'Lesson start must keep the lesson within its day';
  end if;
  if p_start_minute<>l.start_minute then
    update horsebook.lessons set start_minute=p_start_minute,revision=revision+1 where id=l.id;
    -- Increment revisions so stale reviews still fail, without invalidating
    -- decisions for ordinary historical time adjustments.
    update horsebook.bookings set revision=revision+1,
      review_status=case when last_decision_id is not null
        and ((l.date + make_interval(mins=>l.start_minute+l.duration_minutes)) at time zone 'Europe/Warsaw') <= now()
        and ((l.date + make_interval(mins=>p_start_minute+l.duration_minutes)) at time zone 'Europe/Warsaw') > now()
        then 'needs_review' else review_status end
      where lesson_id=l.id and not removed;
  end if;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(x)||jsonb_build_object('bookings',(
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from horsebook.bookings b where lesson_id=l.id))
    from horsebook.lessons x where id=l.id));
end $$;

insert into horsebook.schema_version values(12);
