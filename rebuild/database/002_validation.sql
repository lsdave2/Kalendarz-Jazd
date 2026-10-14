-- Additional restore/accounting checks and shared report-rate settings.
alter table horsebook.settings drop constraint settings_key_check;
alter table horsebook.settings add constraint settings_key_check
  check (key in ('closed_dates','schedule_hours','report_rates'));

create or replace function public.hb_save_setting(p_operation_id uuid,p_key text,p_expected_revision integer,p_value jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; rev integer; rate_key text; begin
  cached:=horsebook.begin_operation(p_operation_id,'save_setting',jsonb_build_object('key',p_key,'revision',p_expected_revision,'value',p_value));
  if cached is not null then return cached; end if;
  if p_key='closed_dates' then
    if jsonb_typeof(p_value) is distinct from 'array' then raise exception 'Closed dates must be an array'; end if;
    perform (value#>>'{}')::date from jsonb_array_elements(p_value);
  elsif p_key='schedule_hours' then
    if jsonb_typeof(p_value) is distinct from 'object' or (p_value->>'start')::integer is null or (p_value->>'end')::integer is null
      or (p_value->>'start')::integer<0 or (p_value->>'end')::integer>24 or (p_value->>'start')::integer >= (p_value->>'end')::integer then
      raise exception 'Invalid schedule hours'; end if;
  elsif p_key='report_rates' then
    if jsonb_typeof(p_value) is distinct from 'object' then raise exception 'Report rates must be an object'; end if;
    foreach rate_key in array array['instructor_individual','instructor_group','package_individual','package_group'] loop
      if jsonb_typeof(p_value->rate_key) is distinct from 'number' or (p_value->>rate_key)::numeric<0 or (p_value->>rate_key)::numeric>100000 then
        raise exception 'Report rates must be nonnegative numbers'; end if;
    end loop;
  else raise exception 'Unknown setting'; end if;
  select revision into rev from horsebook.settings where key=p_key for update;
  if rev is distinct from p_expected_revision then raise exception 'Setting changed; reload before saving' using errcode='40001'; end if;
  insert into horsebook.settings(key,value) values(p_key,p_value)
    on conflict(key) do update set value=excluded.value,revision=horsebook.settings.revision+1;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(s) from horsebook.settings s where key=p_key));
end $$;

create or replace function horsebook.integrity() returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(problem),'[]') from (
    select jsonb_build_object('type','balance','client_id',a.client_id,'stored',a.balance,'ledger',coalesce(sum(e.delta),0)) as problem
      from horsebook.accounts a left join horsebook.credit_entries e on e.client_id=a.client_id
      group by a.client_id,a.balance,a.revision having a.balance<>coalesce(sum(e.delta),0) or a.revision<>count(e.id)
    union all
    select jsonb_build_object('type','missing_account','client_id',c.id) from horsebook.clients c
      where not exists(select 1 from horsebook.accounts a where a.client_id=c.id)
    union all
    select jsonb_build_object('type','entry_chain','entry_id',id) from (
      select *,sum(delta) over(partition by client_id order by account_revision) as running,
        row_number() over(partition by client_id order by account_revision) as ordinal from horsebook.credit_entries) x
      where balance_after<>running or account_revision<>ordinal
    union all
    select jsonb_build_object('type','entry_reference','entry_id',e.id) from horsebook.credit_entries e
      left join horsebook.bookings b on b.id=e.booking_id left join horsebook.decisions d on d.id=e.decision_id
      where (e.booking_id is not null and (e.client_id<>b.client_id or e.decision_id is null or d.booking_id<>e.booking_id or d.operation_id<>e.operation_id))
        or (e.booking_id is null and e.decision_id is not null)
    union all
    select jsonb_build_object('type','review_net','booking_id',b.id) from horsebook.bookings b
      where b.review_status in ('charged','waived') and (select coalesce(sum(delta),0) from horsebook.credit_entries where booking_id=b.id)
        <>case when b.review_status='charged' then -b.units else 0 end
    union all
    select jsonb_build_object('type','decision_reference','booking_id',b.id) from horsebook.bookings b
      left join horsebook.decisions d on d.id=b.last_decision_id where
        (b.last_decision_id is not null and d.booking_id<>b.id)
        or (b.review_status<>'pending' and b.last_decision_id is null)
        or (b.review_status='charged' and d.action<>'charge') or (b.review_status='waived' and d.action<>'waive')
    union all
    select jsonb_build_object('type','decision_chain','decision_id',d.id) from horsebook.decisions d
      join horsebook.decisions prior on prior.id=d.previous_decision_id
      where prior.booking_id<>d.booking_id or prior.booking_revision>=d.booking_revision
    union all
    select jsonb_build_object('type','incomplete_operation','operation_id',id) from horsebook.operations where result is null
  ) problems;
$$;
insert into horsebook.schema_version values(2);
revoke all on function public.hb_save_setting(uuid,text,integer,jsonb) from public,anon;
grant execute on function public.hb_save_setting(uuid,text,integer,jsonb) to authenticated;
