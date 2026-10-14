-- Expose the actual lesson type for review labels, independent of its title.
create or replace function public.hb_review_queue(p_through date,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  if p_through is null or p_limit not between 1 and 200 or p_offset<0 or p_limit is null or p_offset is null then raise exception 'Invalid pagination'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(q) order by date,start_minute,id),'[]') from (
    select b.*,l.date,l.start_minute,l.duration_minutes,l.status as lesson_status,l.title,l.kind as lesson_kind,
      c.name as client_name,a.balance,
      (select coalesce(sum(delta),0)::integer from horsebook.credit_entries where booking_id=b.id) as posted_net,
      (case when b.billing_mode='package' and not b.removed then -b.units else 0 end) as proposed_net
    from horsebook.reviewable_bookings(p_through) b join horsebook.lessons l on l.id=b.lesson_id
      join horsebook.clients c on c.id=b.client_id join horsebook.accounts a on a.client_id=c.id
    order by l.date,l.start_minute,b.id limit p_limit offset p_offset) q);
end $$;
revoke all on function public.hb_review_queue(date,integer,integer) from public,anon,authenticated;
grant execute on function public.hb_review_queue(date,integer,integer) to authenticated;
insert into horsebook.schema_version values(7);
