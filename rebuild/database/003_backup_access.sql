-- The unattended backup login can export a snapshot but cannot write app data.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='horsebook_backup') then
    create role horsebook_backup nologin;
  end if;
end $$;
alter function horsebook.snapshot() rename to snapshot_data;
create function horsebook.snapshot() returns jsonb language sql stable set search_path = '' as $$
  select horsebook.snapshot_data() || jsonb_build_object('schema_version',(select max(version) from horsebook.schema_version));
$$;
create function public.hb_backup_snapshot() returns jsonb language sql stable security definer set search_path = '' as $$
  select horsebook.snapshot();
$$;
revoke all on function horsebook.snapshot() from public,anon,authenticated;
revoke all on function public.hb_backup_snapshot() from public,anon,authenticated;
grant execute on function public.hb_backup_snapshot() to horsebook_backup;
insert into horsebook.schema_version values(3);
