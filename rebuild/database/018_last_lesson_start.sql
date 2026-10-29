-- Use the most recently created lesson, across calendar months and devices.
-- Its original audited start time keeps edits and drag moves out of the default.
create index lessons_created_idx on horsebook.lessons(created_at desc,id desc);
create index lesson_creation_audit_idx on horsebook.audit_events((after_row->>'id'))
  where table_name='lessons' and before_row is null;

create or replace function public.hb_references() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  return jsonb_build_object(
    'clients',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object(
      'account',to_jsonb(a),
      'has_credit_deduction',exists(select 1 from horsebook.credit_entries e where e.client_id=c.id and e.delta<0)
    ) order by c.name,c.id),'[]') from horsebook.clients c join horsebook.accounts a on a.client_id=c.id),
    'horses',(select coalesce(jsonb_agg(to_jsonb(h) order by name,id),'[]') from horsebook.horses h),
    'instructors',(select coalesce(jsonb_agg(to_jsonb(i) order by name,id),'[]') from horsebook.instructors i),
    'settings',(select coalesce(jsonb_agg(to_jsonb(s) order by key),'[]') from horsebook.settings s),
    'last_lesson_start_minute',(select coalesce((
      select (a.after_row->>'start_minute')::integer from horsebook.audit_events a
      where a.table_name='lessons' and a.before_row is null and a.after_row->>'id'=l.id::text
      order by a.created_at,a.id limit 1
    ),l.start_minute) from horsebook.lessons l order by l.created_at desc,l.id desc limit 1));
end $$;

insert into horsebook.schema_version values(18);
