-- New CampusCare signups remain pending until the owner approves them.
-- Existing student, admin, and owner roles are preserved.

alter table public.profiles
    add column if not exists college_id text;

alter table public.profiles
    alter column role set default 'pending';

alter table public.profiles
    drop constraint if exists profiles_role_check;

alter table public.profiles
    add constraint profiles_role_check
    check (role in ('pending', 'student', 'admin', 'owner'));

update public.profiles as p
set college_id = nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'college_id', '')), '')
from auth.users as u
where p.id = u.id
  and nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'college_id', '')), '') is not null
  and p.college_id is distinct from nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'college_id', '')), '');

create or replace function private.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_name text;
    requested_college_id text;
begin
    requested_name := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
    if requested_name = '' then
        requested_name := coalesce(
            nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
            'Campus user'
        );
    end if;
    requested_college_id := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'college_id', '')), '');

    insert into public.profiles (id, full_name, email, college_id)
    values (new.id, pg_catalog.left(requested_name, 100), new.email, requested_college_id)
    on conflict (id) do update
        set email = excluded.email,
            college_id = coalesce(excluded.college_id, public.profiles.college_id);

    return new;
end;
$$;

revoke all on function private.create_profile_for_new_auth_user() from public, anon, authenticated;

-- Existing trigger also syncs email changes; replace it to use the updated function.
drop trigger if exists on_auth_user_created_campuscare on auth.users;
create trigger on_auth_user_created_campuscare
    after insert on auth.users
    for each row execute function private.create_profile_for_new_auth_user();

drop trigger if exists on_auth_user_email_changed_campuscare on auth.users;
create trigger on_auth_user_email_changed_campuscare
    after update of email on auth.users
    for each row execute function private.create_profile_for_new_auth_user();

-- Only approved student accounts may submit complaints.
drop policy if exists complaints_insert_own on public.complaints;
create policy complaints_insert_own
    on public.complaints
    for insert
    to authenticated
    with check (
        user_id = (select auth.uid())
        and exists (
            select 1
            from public.profiles as p
            where p.id = (select auth.uid())
              and p.role = 'student'
        )
        and status = 'submitted'
        and admin_note is null
        and handled_by is null
    );
