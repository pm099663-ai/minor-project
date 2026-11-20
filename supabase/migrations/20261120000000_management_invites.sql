-- Allow management to invite accounts while keeping every new account pending
-- until an authorized manager approves its requested portal.

alter table public.profiles
    drop constraint if exists profiles_requested_role_check;

alter table public.profiles
    add constraint profiles_requested_role_check
    check (requested_role in ('student', 'employee', 'admin'));

create or replace function private.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_name text;
    clean_request_role text;
    clean_phone text;
    clean_work_category text;
    requested_college_id text;
    requested_branch text;
begin
    requested_name := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
    if requested_name = '' then
        requested_name := coalesce(nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''), 'Campus user');
    end if;

    clean_request_role := case
        when new.raw_user_meta_data ->> 'requested_role' in ('employee', 'admin')
            then new.raw_user_meta_data ->> 'requested_role'
        else 'student'
    end;
    clean_phone := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '');
    clean_work_category := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'work_category', '')), '');
    requested_college_id := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'college_id', '')), '');
    requested_branch := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'branch', '')), '');

    insert into public.profiles (
        id, full_name, email, college_id, branch, requested_role, phone, work_category
    )
    values (
        new.id, pg_catalog.left(requested_name, 100), new.email,
        requested_college_id, requested_branch, clean_request_role,
        clean_phone, clean_work_category
    )
    on conflict (id) do update
       set email = excluded.email;

    return new;
end;
$$;

revoke all on function private.create_profile_for_new_auth_user() from public, anon, authenticated;

