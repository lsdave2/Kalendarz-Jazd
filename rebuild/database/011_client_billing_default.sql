-- Derive the lesson default from immutable credit history, independently of
-- today's balance. Refunding a deduction does not erase its history.
create index credit_entries_client_deduction_idx
  on horsebook.credit_entries(client_id) where delta < 0;

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
    'settings',(select coalesce(jsonb_agg(to_jsonb(s) order by key),'[]') from horsebook.settings s));
end $$;

insert into horsebook.schema_version values(11);
