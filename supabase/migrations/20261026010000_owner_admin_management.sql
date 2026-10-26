-- Owner-managed administrator access for CampusCare.
-- The existing management account is promoted to the initial owner below.

alter table public.profiles
    add column if not exists email text;

update public.profiles as p
set email = u.email
from auth.users as u
where p.id = u.id
  and p.email is distinct from u.email;

alter table public.profiles
    drop constraint if exists profiles_role_check;

alter table public.profiles
    add constraint profiles_role_check
    check (role in ('student', 'admin', 'owner'));

create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles as p
        where p.id = (select auth.uid())
          and p.role = 'owner'
    );
$$;

revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;

create or replace function private.is_management()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles as p
        where p.id = (select auth.uid())
          and p.role in ('admin', 'owner')
    );
$$;

revoke all on function private.is_management() from public, anon;
grant execute on function private.is_management() to authenticated;

create or replace function private.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_name text;
begin
    requested_name := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
    if requested_name = '' then
        requested_name := coalesce(
            nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
            'Campus user'
        );
    end if;

    insert into public.profiles (id, full_name, email)
    values (new.id, pg_catalog.left(requested_name, 100), new.email)
    on conflict (id) do update
        set email = excluded.email;

    return new;
end;
$$;

revoke all on function private.create_profile_for_new_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_campuscare on auth.users;
create trigger on_auth_user_created_campuscare
    after insert on auth.users
    for each row execute function private.create_profile_for_new_auth_user();

drop trigger if exists on_auth_user_email_changed_campuscare on auth.users;
create trigger on_auth_user_email_changed_campuscare
    after update of email on auth.users
    for each row execute function private.create_profile_for_new_auth_user();

-- Owners can see all profile rows; other authenticated users can see only their own.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
    on public.profiles
    for select
    to authenticated
    using (
        id = (select auth.uid())
        or (select private.is_owner())
    );

-- Only the owner may change another account's role, and the owner cannot demote themself.
revoke update on table public.profiles from public, anon, authenticated;
grant update (role) on public.profiles to authenticated;
drop policy if exists profiles_update_roles_owner on public.profiles;
create policy profiles_update_roles_owner
    on public.profiles
    for update
    to authenticated
    using (
        (select private.is_owner())
        and id <> (select auth.uid())
    )
    with check (
        (select private.is_owner())
        and id <> (select auth.uid())
        and role in ('student', 'admin')
    );

-- Make the current management account the first owner. The owner can manage all other accounts in the website.
update public.profiles as p
set role = 'owner'
from auth.users as u
where p.id = u.id
  and lower(u.email) = lower('pm099663@gmail.com')
returning p.full_name, p.role;