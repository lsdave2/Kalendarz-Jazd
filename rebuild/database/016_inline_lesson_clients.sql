-- Resolve typed client names inside the lesson's existing atomic, audited operation.
-- The operation's writer lock serializes name lookup and creation across admins.
create or replace function horsebook.save_lesson(expected integer,payload jsonb,target_series uuid default null,occurrence date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved jsonb; item jsonb; bookings jsonb := '[]'; client_name text; cid uuid; matches integer;
begin
  if jsonb_typeof(payload->'bookings') is distinct from 'array' or jsonb_array_length(payload->'bookings') not between 1 and 50 then
    raise exception 'A lesson needs between 1 and 50 participants'; end if;
  for item in select value from jsonb_array_elements(payload->'bookings') loop
    if nullif(item->>'client_id','') is null then
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
insert into horsebook.schema_version values(16);
