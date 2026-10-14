-- Optional contact details, included automatically in references and snapshots.
alter table horsebook.clients add column phone_number text
  check (phone_number is null or length(phone_number) <= 50);

create or replace function public.hb_save_reference(p_operation_id uuid, p_kind text, p_expected_revision integer, p_record jsonb)
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
    update horsebook.clients set payment_rate=(p_record->>'payment_rate')::numeric,
      phone_number=case when p_record ? 'phone_number'
        then nullif(btrim(p_record->>'phone_number'),'') else phone_number end
      where id=record_id;
  end if;
  execute format('select to_jsonb(t) from horsebook.%I t where id=$1',p_kind) into row_data using record_id;
  return horsebook.finish_operation(p_operation_id,row_data);
end $$;

insert into horsebook.schema_version values(14);
