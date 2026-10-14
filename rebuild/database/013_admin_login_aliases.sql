-- Short usernames resolve to current Auth emails; membership remains explicit.
create table horsebook.admin_login_aliases (
  login_name text primary key check (login_name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  user_id uuid not null unique references horsebook.admin_members(user_id) on delete cascade
);
alter table horsebook.admin_login_aliases enable row level security;
revoke all on horsebook.admin_login_aliases from public, anon, authenticated;

create function public.hb_resolve_admin_login_email(p_identifier text)
returns text language sql stable security definer set search_path = '' as $$
  select u.email::text from horsebook.admin_login_aliases a
  join horsebook.admin_members m on m.user_id=a.user_id
  join auth.users u on u.id=a.user_id
  where a.login_name=lower(btrim(p_identifier));
$$;
revoke all on function public.hb_resolve_admin_login_email(text) from public;
grant execute on function public.hb_resolve_admin_login_email(text) to anon, authenticated;
insert into horsebook.schema_version values(13);
