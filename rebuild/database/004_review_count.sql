-- One eligibility query drives both the review panel and its calendar badge.
create function horsebook.reviewable_bookings(p_through date)
returns setof horsebook.bookings language sql stable set search_path = '' as $$
  select b.* from horsebook.bookings b join horsebook.lessons l on l.id=b.lesson_id
  where b.review_status in ('pending','needs_review') and l.date<=p_through
    and (b.billing_mode='package' and not b.removed or b.last_decision_id is not null)
    and ((l.date + make_interval(mins=>l.start_minute+l.duration_minutes)) at time zone 'Europe/Warsaw' <= now()
      or b.review_status='needs_review');
$$;
revoke all on function horsebook.reviewable_bookings(date) from public,anon,authenticated;

create or replace function public.hb_review_queue(p_through date,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  if p_through is null or p_limit not between 1 and 200 or p_offset<0 or p_limit is null or p_offset is null then raise exception 'Invalid pagination'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(q) order by date,start_minute,id),'[]') from (
    select b.*,l.date,l.start_minute,l.duration_minutes,l.status as lesson_status,l.title,
      c.name as client_name,a.balance,
      (select coalesce(sum(delta),0)::integer from horsebook.credit_entries where booking_id=b.id) as posted_net,
      (case when b.billing_mode='package' and not b.removed then -b.units else 0 end) as proposed_net
    from horsebook.reviewable_bookings(p_through) b join horsebook.lessons l on l.id=b.lesson_id
      join horsebook.clients c on c.id=b.client_id join horsebook.accounts a on a.client_id=c.id
    order by l.date,l.start_minute,b.id limit p_limit offset p_offset) q);
end $$;

create function public.hb_review_count(p_through date)
returns integer language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  if p_through is null then raise exception 'Review date is required'; end if;
  return (select count(*)::integer from horsebook.reviewable_bookings(p_through));
end $$;
revoke all on function public.hb_review_count(date) from public,anon,authenticated;
grant execute on function public.hb_review_count(date) to authenticated;
insert into horsebook.schema_version values(4);
