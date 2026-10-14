-- A calendar drag changes only this occurrence's time and review revisions.
-- It never replays participants, removes bookings, or posts package credits.
create function public.hb_move_lesson_time(p_operation_id uuid,p_lesson_id uuid,p_expected_revision integer,p_start_minute integer)
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
    -- A stale pending review must fail; previous decisions remain immutable and
    -- need an explicit corrective review. Removed participants stay removed.
    update horsebook.bookings set revision=revision+1,
      review_status=case when last_decision_id is not null then 'needs_review' else review_status end
      where lesson_id=l.id and not removed;
  end if;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(x)||jsonb_build_object('bookings',(
    select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from horsebook.bookings b where lesson_id=l.id))
    from horsebook.lessons x where id=l.id));
end $$;
revoke all on function public.hb_move_lesson_time(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.hb_move_lesson_time(uuid,uuid,integer,integer) to authenticated;
insert into horsebook.schema_version values(6);
