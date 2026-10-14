-- Delete erroneous lessons only before any billing decision has been recorded.
-- Existing DELETE audit triggers retain the complete lesson and booking rows.
create function public.hb_delete_lesson(p_operation_id uuid,p_lesson_id uuid,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; l horsebook.lessons; begin
  cached:=horsebook.begin_operation(p_operation_id,'delete_lesson',jsonb_build_object('id',p_lesson_id,'revision',p_expected_revision));
  if cached is not null then return cached; end if;
  select * into l from horsebook.lessons where id=p_lesson_id for update;
  if not found or l.revision is distinct from p_expected_revision then
    raise exception 'Lesson changed or no longer exists; reload before deleting' using errcode='40001';
  end if;
  -- Include removed participants and zero-credit decisions; neither can lose history.
  if exists(select 1 from horsebook.bookings b where b.lesson_id=l.id and (
    b.review_status<>'pending' or b.last_decision_id is not null
    or exists(select 1 from horsebook.decisions d where d.booking_id=b.id)
    or exists(select 1 from horsebook.credit_entries e where e.booking_id=b.id))) then
    raise exception 'Reviewed lessons cannot be deleted; cancel the lesson instead' using errcode='55000';
  end if;
  delete from horsebook.bookings where lesson_id=l.id;
  delete from horsebook.lessons where id=l.id;
  return horsebook.finish_operation(p_operation_id,jsonb_build_object('id',l.id,'deleted',true));
end $$;
revoke all on function public.hb_delete_lesson(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.hb_delete_lesson(uuid,uuid,integer) to authenticated;
insert into horsebook.schema_version values(5);
