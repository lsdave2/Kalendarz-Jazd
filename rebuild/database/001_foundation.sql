-- Clean install ONLY. This migration must never be applied to the legacy DB.
create schema horsebook;
revoke all on schema horsebook from public, anon, authenticated;

create table horsebook.schema_version (version integer primary key);
insert into horsebook.schema_version values (1);
create table horsebook.admin_members (
  user_id uuid primary key, display_name text not null check (btrim(display_name) <> '')
);
create table horsebook.operations (
  id uuid primary key, name text not null, request jsonb not null,
  actor_id uuid not null, actor_name text not null,
  result jsonb, created_at timestamptz not null default now()
);
create table horsebook.clients (
  id uuid primary key default gen_random_uuid(), name text not null check (btrim(name) <> ''),
  archived boolean not null default false, payment_rate numeric(12,2) check (payment_rate >= 0),
  revision integer not null default 1 check (revision > 0), created_at timestamptz not null default now()
);
create table horsebook.horses (
  id uuid primary key default gen_random_uuid(), name text not null check (btrim(name) <> ''),
  archived boolean not null default false, revision integer not null default 1,
  created_at timestamptz not null default now()
);
create table horsebook.instructors (
  id uuid primary key default gen_random_uuid(), name text not null check (btrim(name) <> ''),
  color text not null default '#7c5cfc' check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived boolean not null default false, revision integer not null default 1,
  created_at timestamptz not null default now()
);
create table horsebook.accounts (
  client_id uuid primary key references horsebook.clients(id),
  balance integer not null default 0, revision integer not null default 0 check (revision >= 0)
);
create table horsebook.series (
  id uuid primary key default gen_random_uuid(), template jsonb not null,
  first_date date not null, last_date date not null, stopped boolean not null default false,
  revision integer not null default 1, check (last_date >= first_date and last_date <= first_date + 366)
);
create table horsebook.lessons (
  id uuid primary key default gen_random_uuid(), date date not null,
  start_minute integer not null check (start_minute between 0 and 1439),
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  title text not null default '', kind text not null check (kind in ('individual','group','custom')),
  instructor_id uuid references horsebook.instructors(id), status text not null default 'scheduled'
    check (status in ('scheduled','cancelled')),
  notes text not null default '', series_id uuid references horsebook.series(id),
  occurrence_date date, revision integer not null default 1,
  created_at timestamptz not null default now(),
  unique (series_id, occurrence_date),
  check (start_minute + duration_minutes <= 1440),
  check ((series_id is null) = (occurrence_date is null))
);
create index lessons_date_idx on horsebook.lessons(date);
create table horsebook.bookings (
  id uuid primary key default gen_random_uuid(), lesson_id uuid not null references horsebook.lessons(id),
  client_id uuid not null references horsebook.clients(id), horse_id uuid references horsebook.horses(id),
  instructor_id uuid references horsebook.instructors(id),
  billing_mode text not null default 'package' check (billing_mode in ('package','cash')),
  units integer not null default 1 check (units between 1 and 100),
  cash_amount numeric(12,2) not null default 0 check (cash_amount >= 0),
  attendance text not null default 'unknown' check (attendance in ('unknown','attended','no_show','cancelled')),
  removed boolean not null default false,
  review_status text not null default 'pending' check (review_status in ('pending','charged','waived','needs_review')),
  revision integer not null default 1, last_decision_id uuid,
  unique (lesson_id, client_id)
);
create index bookings_lesson_idx on horsebook.bookings(lesson_id);
create index bookings_review_idx on horsebook.bookings(review_status);
create table horsebook.decisions (
  id uuid primary key default gen_random_uuid(), operation_id uuid not null references horsebook.operations(id),
  booking_id uuid not null references horsebook.bookings(id), booking_revision integer not null,
  action text not null check (action in ('charge','waive')), reason text not null,
  facts jsonb not null, previous_decision_id uuid references horsebook.decisions(id),
  actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now(),
  unique (booking_id, booking_revision)
);
alter table horsebook.bookings add constraint booking_last_decision_fk
  foreign key (last_decision_id) references horsebook.decisions(id) deferrable initially deferred;
create table horsebook.credit_entries (
  id uuid primary key default gen_random_uuid(), operation_id uuid not null references horsebook.operations(id),
  client_id uuid not null references horsebook.accounts(client_id),
  booking_id uuid references horsebook.bookings(id), decision_id uuid references horsebook.decisions(id),
  delta integer not null check (delta <> 0), balance_after integer not null,
  account_revision integer not null check (account_revision > 0),
  reason text not null check (btrim(reason) <> ''),
  actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now(),
  unique (client_id, account_revision)
);
create index credit_entries_booking_idx on horsebook.credit_entries(booking_id);
create table horsebook.settings (
  key text primary key check (key in ('closed_dates','schedule_hours')),
  value jsonb not null, revision integer not null default 1
);
create table horsebook.finance_entries (
  id uuid primary key default gen_random_uuid(), kind text not null check (kind in ('income','expense')),
  title text not null check (btrim(title) <> ''), amount numeric(12,2) not null check (amount > 0),
  date date not null, notes text not null default '', archived boolean not null default false,
  revision integer not null default 1
);
create table horsebook.audit_events (
  id uuid primary key default gen_random_uuid(), operation_id uuid not null references horsebook.operations(id),
  table_name text not null, record_id text not null, before_row jsonb, after_row jsonb,
  actor_id uuid not null, actor_name text not null, created_at timestamptz not null default now()
);
create index audit_events_created_idx on horsebook.audit_events(created_at desc, id);

-- All application tables are private. The only browser interface is public.hb_*.
do $$ declare t text; begin
  foreach t in array array['schema_version','admin_members','operations','clients','horses','instructors',
    'accounts','series','lessons','bookings','decisions','credit_entries','settings','finance_entries','audit_events'] loop
    execute format('alter table horsebook.%I enable row level security', t);
  end loop;
end $$;
revoke all on all tables in schema horsebook from public, anon, authenticated;

create function horsebook.require_admin() returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from horsebook.admin_members where user_id = auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- A short transaction-level writer lock keeps this small multi-admin app simple:
-- all business writes serialize; reads continue normally. No long-running work
-- or external network calls belong inside these operations.
create function horsebook.begin_operation(op uuid, op_name text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid; existing horsebook.operations; begin
  actor := horsebook.require_admin();
  if op is null then raise exception 'Operation ID is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('horsebook.business-write', 0));
  select * into existing from horsebook.operations where id = op;
  if found then
    if existing.name <> op_name or existing.request <> payload or existing.actor_id <> actor then
      raise exception 'Operation ID was reused with a different request' using errcode = '22023';
    end if;
    if existing.result is null then raise exception 'Incomplete operation'; end if;
    return existing.result;
  end if;
  insert into horsebook.operations(id,name,request,actor_id,actor_name)
    select op,op_name,payload,actor,display_name from horsebook.admin_members where user_id = actor;
  perform set_config('horsebook.operation_id', op::text, true);
  return null;
end $$;
create function horsebook.finish_operation(op uuid, response jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
  update horsebook.operations set result = response where id = op;
  return response;
end $$;

create function horsebook.audit_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare old_row jsonb; new_row jsonb; op uuid; begin
  if current_setting('horsebook.restoring', true) = 'on' then return new; end if;
  old_row := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  new_row := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  op := nullif(current_setting('horsebook.operation_id', true),'')::uuid;
  if op is null then raise exception 'Writes must use a business operation'; end if;
  insert into horsebook.audit_events(operation_id,table_name,record_id,before_row,after_row,actor_id,actor_name)
    select op,tg_table_name,coalesce(new_row->>'id',old_row->>'id',new_row->>'client_id',new_row->>'key'),
      old_row,new_row,actor_id,actor_name from horsebook.operations where id = op;
  return new;
end $$;
create function horsebook.reject_mutation() returns trigger language plpgsql set search_path = '' as $$ begin
  raise exception 'Posted accounting and audit records cannot be edited or deleted' using errcode = '42501';
end $$;
do $$ declare t text; begin
  foreach t in array array['clients','horses','instructors','accounts','series','lessons','bookings','settings','finance_entries'] loop
    execute format('create trigger audit_write after insert or update or delete on horsebook.%I for each row execute function horsebook.audit_change()',t);
  end loop;
  foreach t in array array['credit_entries','decisions','audit_events'] loop
    execute format('create trigger immutable_record before update or delete on horsebook.%I for each row execute function horsebook.reject_mutation()',t);
  end loop;
end $$;

create function public.hb_health() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('schema_version',1,'admin',exists(
    select 1 from horsebook.admin_members where user_id = auth.uid()));
$$;

create function public.hb_save_reference(p_operation_id uuid, p_kind text, p_expected_revision integer, p_record jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; record_id uuid; row_data jsonb; current_revision integer; begin
  cached := horsebook.begin_operation(p_operation_id,'save_reference',jsonb_build_object('kind',p_kind,'revision',p_expected_revision,'record',p_record));
  if cached is not null then return cached; end if;
  if p_kind not in ('clients','horses','instructors') then raise exception 'Invalid reference kind'; end if;
  record_id := coalesce((p_record->>'id')::uuid,gen_random_uuid());
  if coalesce(length(btrim(p_record->>'name')),0) not between 1 and 200 then raise exception 'Name is required (maximum 200 characters)'; end if;
  execute format('select revision from horsebook.%I where id=$1 for update',p_kind) into current_revision using record_id;
  if current_revision is not null then
    if p_expected_revision is distinct from current_revision then raise exception 'Record changed; reload before saving' using errcode = '40001'; end if;
    execute format('update horsebook.%I set name=$2, archived=$3,revision=revision+1 where id=$1',p_kind)
      using record_id,btrim(p_record->>'name'),coalesce((p_record->>'archived')::boolean,false);
  else
    if p_expected_revision is not null then raise exception 'Record no longer exists' using errcode='40001'; end if;
    execute format('insert into horsebook.%I(id,name,archived) values($1,$2,$3)',p_kind)
      using record_id,btrim(p_record->>'name'),coalesce((p_record->>'archived')::boolean,false);
    if p_kind='clients' then insert into horsebook.accounts(client_id) values(record_id); end if;
  end if;
  if p_kind='instructors' then
    update horsebook.instructors set color=coalesce(p_record->>'color','#7c5cfc') where id=record_id;
  elsif p_kind='clients' then
    update horsebook.clients set payment_rate=(p_record->>'payment_rate')::numeric where id=record_id;
  end if;
  execute format('select to_jsonb(t) from horsebook.%I t where id=$1',p_kind) into row_data using record_id;
  return horsebook.finish_operation(p_operation_id,row_data);
end $$;

-- Internal lesson save: payload contains only this lesson and its participants.
create function horsebook.save_lesson(expected integer, payload jsonb, target_series uuid default null, occurrence date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare lid uuid; old_l horsebook.lessons; item jsonb; bid uuid; old_b horsebook.bookings;
  kept uuid[] := array[]::uuid[]; schedule_changed boolean; billing_changed boolean; begin
  lid := coalesce((payload->>'id')::uuid,gen_random_uuid());
  select * into old_l from horsebook.lessons where id=lid for update;
  if found then
    if expected is distinct from old_l.revision then raise exception 'Lesson changed; reload before saving' using errcode='40001'; end if;
    schedule_changed := (old_l.date,old_l.start_minute,old_l.duration_minutes,old_l.status) is distinct from
      ((payload->>'date')::date,(payload->>'start_minute')::integer,(payload->>'duration_minutes')::integer,coalesce(payload->>'status','scheduled'));
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

create function public.hb_save_lesson(p_operation_id uuid,p_expected_revision integer,p_lesson jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; begin
  cached := horsebook.begin_operation(p_operation_id,'save_lesson',jsonb_build_object('revision',p_expected_revision,'lesson',p_lesson));
  if cached is not null then return cached; end if;
  return horsebook.finish_operation(p_operation_id,horsebook.save_lesson(p_expected_revision,p_lesson));
end $$;

create function public.hb_cancel_lesson(p_operation_id uuid,p_lesson_id uuid,p_expected_revision integer,p_cancelled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; l horsebook.lessons; begin
  cached := horsebook.begin_operation(p_operation_id,'cancel_lesson',jsonb_build_object('id',p_lesson_id,'revision',p_expected_revision,'cancelled',p_cancelled));
  if cached is not null then return cached; end if;
  select * into l from horsebook.lessons where id=p_lesson_id for update;
  if not found or l.revision is distinct from p_expected_revision then raise exception 'Lesson changed; reload before saving' using errcode='40001'; end if;
  if p_cancelled is null then raise exception 'Cancellation choice is required'; end if;
  update horsebook.lessons set status=case when p_cancelled then 'cancelled' else 'scheduled' end,revision=revision+1 where id=l.id;
  update horsebook.bookings set revision=revision+1,
    review_status=case when last_decision_id is not null then 'needs_review' else review_status end where lesson_id=l.id;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(x) from horsebook.lessons x where id=l.id));
end $$;

create function public.hb_create_series(p_operation_id uuid,p_lesson jsonb,p_until date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; sid uuid; d date; item jsonb; bookings jsonb; lesson_payload jsonb; created jsonb := '[]'; begin
  cached := horsebook.begin_operation(p_operation_id,'create_series',jsonb_build_object('lesson',p_lesson,'until',p_until));
  if cached is not null then return cached; end if;
  if p_until is null or p_until < (p_lesson->>'date')::date or p_until > (p_lesson->>'date')::date + 366 then
    raise exception 'Weekly series must end within one year'; end if;
  sid:=gen_random_uuid();
  insert into horsebook.series(id,template,first_date,last_date) values(sid,p_lesson,(p_lesson->>'date')::date,p_until);
  d:=(p_lesson->>'date')::date;
  while d<=p_until loop
    bookings:='[]';
    for item in select value from jsonb_array_elements(p_lesson->'bookings') loop
      bookings:=bookings || jsonb_build_array((item-'id') || jsonb_build_object('id',gen_random_uuid()));
    end loop;
    lesson_payload := (p_lesson-'id') || jsonb_build_object('id',gen_random_uuid(),'date',d,'bookings',bookings);
    created:=created || jsonb_build_array(horsebook.save_lesson(null,lesson_payload,sid,d));
    d:=d+7;
  end loop;
  return horsebook.finish_operation(p_operation_id,jsonb_build_object('series_id',sid,'lessons',created));
end $$;

create function public.hb_stop_series(p_operation_id uuid,p_series_id uuid,p_expected_revision integer,p_from date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; s horsebook.series; begin
  cached:=horsebook.begin_operation(p_operation_id,'stop_series',jsonb_build_object('id',p_series_id,'revision',p_expected_revision,'from',p_from));
  if cached is not null then return cached; end if;
  select * into s from horsebook.series where id=p_series_id for update;
  if not found or s.revision is distinct from p_expected_revision then raise exception 'Series changed; reload before saving' using errcode='40001'; end if;
  if p_from is null then raise exception 'A start date is required'; end if;
  update horsebook.series set stopped=true,revision=revision+1 where id=s.id;
  update horsebook.lessons set status='cancelled',revision=revision+1 where series_id=s.id and date>=p_from and status<>'cancelled';
  update horsebook.bookings b set revision=revision+1,review_status=case when last_decision_id is not null then 'needs_review' else review_status end
    from horsebook.lessons l where l.id=b.lesson_id and l.series_id=s.id and l.date>=p_from;
  return horsebook.finish_operation(p_operation_id,jsonb_build_object('series_id',s.id,'stopped',true));
end $$;

create function horsebook.post_credit(op uuid, cid uuid, amount integer, note text, bid uuid default null, did uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a horsebook.accounts; entry horsebook.credit_entries; begin
  if amount is null or amount=0 or coalesce(length(btrim(note)),0)=0 then raise exception 'A nonzero credit change and reason are required'; end if;
  update horsebook.accounts set balance=balance+amount,revision=revision+1 where client_id=cid returning * into a;
  if not found then raise exception 'Credit account does not exist'; end if;
  insert into horsebook.credit_entries(operation_id,client_id,booking_id,decision_id,delta,balance_after,account_revision,reason,actor_id,actor_name)
    select op,cid,bid,did,amount,a.balance,a.revision,btrim(note),actor_id,actor_name from horsebook.operations where id=op returning * into entry;
  return to_jsonb(entry);
end $$;

create function public.hb_adjust_credits(p_operation_id uuid,p_client_id uuid,p_expected_revision integer,p_delta integer,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; a horsebook.accounts; begin
  cached:=horsebook.begin_operation(p_operation_id,'adjust_credits',jsonb_build_object('id',p_client_id,'revision',p_expected_revision,'delta',p_delta,'reason',p_reason));
  if cached is not null then return cached; end if;
  select * into a from horsebook.accounts where client_id=p_client_id for update;
  if not found or a.revision is distinct from p_expected_revision then raise exception 'Balance changed; reload before saving' using errcode='40001'; end if;
  return horsebook.finish_operation(p_operation_id,horsebook.post_credit(p_operation_id,p_client_id,p_delta,p_reason));
end $$;

create function public.hb_review_credits(p_operation_id uuid,p_decisions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; item jsonb; b horsebook.bookings; l horsebook.lessons;
  did uuid; effect integer; wanted integer; posted integer; note text; output jsonb:='[]'; seen uuid[]:=array[]::uuid[];
begin
  cached:=horsebook.begin_operation(p_operation_id,'review_credits',jsonb_build_object('decisions',p_decisions));
  if cached is not null then return cached; end if;
  if jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_array_length(p_decisions) not between 1 and 100 then
    raise exception 'Select between 1 and 100 bookings'; end if;
  for item in select value from jsonb_array_elements(p_decisions) order by value->>'booking_id' loop
    select * into b from horsebook.bookings where id=(item->>'booking_id')::uuid for update;
    if not found or b.revision is distinct from (item->>'expected_revision')::integer or b.review_status not in ('pending','needs_review') then
      raise exception 'Review changed; reload before approving' using errcode='40001'; end if;
    if b.id=any(seen) then raise exception 'Duplicate booking in review'; end if;
    seen:=array_append(seen,b.id);
    select * into l from horsebook.lessons where id=b.lesson_id;
    if item->>'action' is null or item->>'action' not in ('charge','waive') then raise exception 'Choose charge or waive'; end if;
    if (l.date + make_interval(mins=>l.start_minute+l.duration_minutes)) at time zone 'Europe/Warsaw' > now()
      and b.review_status='pending' then raise exception 'Lesson has not ended'; end if;
    if item->>'action'='charge' and (b.removed or b.billing_mode<>'package') then raise exception 'Removed or cash bookings cannot be charged package credits'; end if;
    if b.review_status='needs_review' and coalesce(length(btrim(item->>'reason')),0)=0 then raise exception 'Explain the corrective decision'; end if;
    note:=coalesce(nullif(btrim(item->>'reason'),''),case when item->>'action'='charge' then 'Approved lesson charge' else 'Admin waived charge' end);
    select coalesce(sum(delta),0)::integer into posted from horsebook.credit_entries where booking_id=b.id;
    wanted:=case when item->>'action'='charge' then -b.units else 0 end;
    effect:=wanted-posted;
    did:=gen_random_uuid();
    insert into horsebook.decisions(id,operation_id,booking_id,booking_revision,action,reason,facts,previous_decision_id,actor_id,actor_name)
      select did,p_operation_id,b.id,b.revision,item->>'action',note,
        jsonb_build_object('booking',to_jsonb(b),'lesson',to_jsonb(l),'previous_net',posted,'target_net',wanted,'delta',effect),
        b.last_decision_id,actor_id,actor_name from horsebook.operations where id=p_operation_id;
    if effect<>0 then perform horsebook.post_credit(p_operation_id,b.client_id,effect,note,b.id,did); end if;
    update horsebook.bookings set review_status=case when item->>'action'='charge' then 'charged' else 'waived' end,
      revision=revision+1,last_decision_id=did where id=b.id;
    output:=output || jsonb_build_array(jsonb_build_object('booking_id',b.id,'decision_id',did,'delta',effect,
      'account',(select to_jsonb(a) from horsebook.accounts a where client_id=b.client_id)));
  end loop;
  return horsebook.finish_operation(p_operation_id,output);
end $$;

create function public.hb_save_setting(p_operation_id uuid,p_key text,p_expected_revision integer,p_value jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; rev integer; begin
  cached:=horsebook.begin_operation(p_operation_id,'save_setting',jsonb_build_object('key',p_key,'revision',p_expected_revision,'value',p_value));
  if cached is not null then return cached; end if;
  if p_key='closed_dates' then
    if jsonb_typeof(p_value) is distinct from 'array' then raise exception 'Closed dates must be an array'; end if;
    perform (value#>>'{}')::date from jsonb_array_elements(p_value);
  elsif p_key='schedule_hours' then
    if jsonb_typeof(p_value) is distinct from 'object' or (p_value->>'start')::integer is null or (p_value->>'end')::integer is null
      or (p_value->>'start')::integer<0 or (p_value->>'end')::integer>24 or (p_value->>'start')::integer >= (p_value->>'end')::integer then
      raise exception 'Invalid schedule hours'; end if;
  else raise exception 'Unknown setting'; end if;
  select revision into rev from horsebook.settings where key=p_key for update;
  if rev is distinct from p_expected_revision then raise exception 'Setting changed; reload before saving' using errcode='40001'; end if;
  insert into horsebook.settings(key,value) values(p_key,p_value)
    on conflict(key) do update set value=excluded.value,revision=horsebook.settings.revision+1;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(s) from horsebook.settings s where key=p_key));
end $$;

create function public.hb_save_finance(p_operation_id uuid,p_expected_revision integer,p_record jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cached jsonb; fid uuid; rev integer; begin
  cached:=horsebook.begin_operation(p_operation_id,'save_finance',jsonb_build_object('revision',p_expected_revision,'record',p_record));
  if cached is not null then return cached; end if;
  fid:=coalesce((p_record->>'id')::uuid,gen_random_uuid());
  select revision into rev from horsebook.finance_entries where id=fid for update;
  if rev is distinct from p_expected_revision then raise exception 'Finance record changed; reload before saving' using errcode='40001'; end if;
  insert into horsebook.finance_entries(id,kind,title,amount,date,notes,archived)
    values(fid,p_record->>'kind',btrim(p_record->>'title'),(p_record->>'amount')::numeric,(p_record->>'date')::date,
      coalesce(p_record->>'notes',''),coalesce((p_record->>'archived')::boolean,false))
    on conflict(id) do update set kind=excluded.kind,title=excluded.title,amount=excluded.amount,date=excluded.date,
      notes=excluded.notes,archived=excluded.archived,revision=horsebook.finance_entries.revision+1;
  return horsebook.finish_operation(p_operation_id,(select to_jsonb(f) from horsebook.finance_entries f where id=fid));
end $$;

create function public.hb_references() returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  return jsonb_build_object(
    'clients',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('account',to_jsonb(a)) order by c.name,c.id),'[]') from horsebook.clients c join horsebook.accounts a on a.client_id=c.id),
    'horses',(select coalesce(jsonb_agg(to_jsonb(h) order by name,id),'[]') from horsebook.horses h),
    'instructors',(select coalesce(jsonb_agg(to_jsonb(i) order by name,id),'[]') from horsebook.instructors i),
    'settings',(select coalesce(jsonb_agg(to_jsonb(s) order by key),'[]') from horsebook.settings s));
end $$;

create function public.hb_calendar(p_from date,p_to date) returns jsonb
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
    'settings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from horsebook.settings x));
end $$;

create function public.hb_review_queue(p_through date,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform horsebook.require_admin();
  if p_through is null or p_limit not between 1 and 200 or p_offset<0 or p_limit is null or p_offset is null then raise exception 'Invalid pagination'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(q) order by date,start_minute,id),'[]') from (
    select b.*,l.date,l.start_minute,l.duration_minutes,l.status as lesson_status,l.title,
      c.name as client_name,a.balance,
      (select coalesce(sum(delta),0)::integer from horsebook.credit_entries where booking_id=b.id) as posted_net,
      (case when b.billing_mode='package' and not b.removed then -b.units else 0 end) as proposed_net
    from horsebook.bookings b join horsebook.lessons l on l.id=b.lesson_id
      join horsebook.clients c on c.id=b.client_id join horsebook.accounts a on a.client_id=c.id
    where b.review_status in ('pending','needs_review') and l.date<=p_through
      and (b.billing_mode='package' and not b.removed or b.last_decision_id is not null)
      and ((l.date + make_interval(mins=>l.start_minute+l.duration_minutes)) at time zone 'Europe/Warsaw' <= now() or b.review_status='needs_review')
    order by l.date,l.start_minute,b.id limit p_limit offset p_offset) q);
end $$;

create function public.hb_history(p_kind text,p_client_id uuid default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
  perform horsebook.require_admin();
  if p_limit is null or p_offset is null or p_limit not between 1 and 200 or p_offset<0 then raise exception 'Invalid pagination'; end if;
  if p_kind='credits' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]') into result from (
      select e.*,c.name as client_name from horsebook.credit_entries e join horsebook.clients c on c.id=e.client_id
      where p_client_id is null or e.client_id=p_client_id order by e.created_at desc,e.id desc limit p_limit offset p_offset) q;
  elsif p_kind='decisions' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]') into result from (
      select d.*,c.name as client_name from horsebook.decisions d join horsebook.bookings b on b.id=d.booking_id join horsebook.clients c on c.id=b.client_id
      where p_client_id is null or c.id=p_client_id order by d.created_at desc,d.id desc limit p_limit offset p_offset) q;
  elsif p_kind='audit' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]') into result from (
      select * from horsebook.audit_events order by created_at desc,id desc limit p_limit offset p_offset) q;
  else raise exception 'Unknown history kind'; end if;
  return result;
end $$;

create function public.hb_finances(p_from date,p_to date,p_limit integer default 100,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
  perform horsebook.require_admin();
  if p_from is null or p_to is null or p_to<p_from or p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset<0 then raise exception 'Invalid finance query'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(q) order by date desc,id),'[]') from (
    select * from horsebook.finance_entries where date between p_from and p_to and not archived order by date desc,id limit p_limit offset p_offset) q);
end $$;

create function horsebook.integrity() returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(problem),'[]') from (
    select jsonb_build_object('type','balance','client_id',a.client_id,'stored',a.balance,'ledger',coalesce(sum(e.delta),0)) as problem
      from horsebook.accounts a left join horsebook.credit_entries e on e.client_id=a.client_id
      group by a.client_id,a.balance,a.revision having a.balance<>coalesce(sum(e.delta),0) or a.revision<>count(e.id)
    union all
    select jsonb_build_object('type','entry_chain','entry_id',id) from (
      select *,sum(delta) over(partition by client_id order by account_revision) as running,
        row_number() over(partition by client_id order by account_revision) as ordinal from horsebook.credit_entries) x
      where balance_after<>running or account_revision<>ordinal
    union all
    select jsonb_build_object('type','review_net','booking_id',b.id) from horsebook.bookings b
      where b.review_status in ('charged','waived') and (select coalesce(sum(delta),0) from horsebook.credit_entries where booking_id=b.id)
        <>case when b.review_status='charged' then -b.units else 0 end
    union all
    select jsonb_build_object('type','incomplete_operation','operation_id',id) from horsebook.operations where result is null
  ) problems;
$$;
create function public.hb_integrity() returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
  perform horsebook.require_admin(); return horsebook.integrity();
end $$;

-- One STABLE SQL statement exports a consistent MVCC snapshot of every table.
-- Admin membership is deliberately NOT restored into another project's Auth.
create function horsebook.snapshot() returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('format','horsebook.snapshot','version',1,'created_at',statement_timestamp(),'data',jsonb_build_object(
    'operations',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.operations x),
    'clients',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.clients x),
    'horses',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.horses x),
    'instructors',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.instructors x),
    'accounts',(select coalesce(jsonb_agg(to_jsonb(x) order by client_id),'[]') from horsebook.accounts x),
    'series',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.series x),
    'lessons',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.lessons x),
    'bookings',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.bookings x),
    'decisions',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.decisions x),
    'credit_entries',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.credit_entries x),
    'settings',(select coalesce(jsonb_agg(to_jsonb(x) order by key),'[]') from horsebook.settings x),
    'finance_entries',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.finance_entries x),
    'audit_events',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from horsebook.audit_events x)));
$$;
create function public.hb_export_snapshot() returns jsonb language plpgsql stable security definer set search_path = '' as $$ begin
  perform horsebook.require_admin(); return horsebook.snapshot();
end $$;

-- PostgreSQL grants function execution to PUBLIC by default: revoke it explicitly.
revoke all on all functions in schema horsebook from public,anon,authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'hb\_%' escape '\' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
    if f.proname in ('hb_health','hb_calendar') then execute format('grant execute on function %s to anon',f.signature); end if;
  end loop;
end $$;
