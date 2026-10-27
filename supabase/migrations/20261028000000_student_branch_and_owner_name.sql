-- Add student branch details to CampusCare profiles and complaint management views.
-- Existing accounts can save their branch from the student dashboard.

alter table public.profiles
    add column if not exists branch text;

alter table public.profiles
    drop constraint if exists profiles_branch_check;

alter table public.profiles
    add constraint profiles_branch_check
    check (branch is null or char_length(pg_catalog.btrim(branch)) between 1 and 80);

update public.profiles as p
set branch = nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'branch', '')), '')
from auth.users as u
where p.id = u.id
  and nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'branch', '')), '') is not null
  and p.branch is distinct from nullif(pg_catalog.btrim(coalesce(u.raw_user_meta_data ->> 'branch', '')), '');

create or replace function private.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_name text;
    requested_college_id text;
    requested_branch text;
begin
    requested_name := pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
    if requested_name = '' then
        requested_name := coalesce(
            nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''),
            'Campus user'
        );
    end if;
    requested_college_id := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'college_id', '')), '');
    requested_branch := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'branch', '')), '');

    insert into public.profiles (id, full_name, email, college_id, branch)
    values (new.id, pg_catalog.left(requested_name, 100), new.email, requested_college_id, requested_branch)
    on conflict (id) do update
        set email = excluded.email,
            college_id = coalesce(excluded.college_id, public.profiles.college_id),
            branch = coalesce(excluded.branch, public.profiles.branch);

    return new;
end;
$$;

revoke all on function private.create_profile_for_new_auth_user() from public, anon, authenticated;

-- Approved management users need profile names/branches to identify complaint submitters.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
    on public.profiles
    for select
    to authenticated
    using (
        id = (select auth.uid())
        or (select private.is_management())
    );

-- Let a student safely edit only their own branch without opening profile updates generally.
create or replace function public.set_my_branch(requested_branch text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    clean_branch text;
begin
    if (select auth.uid()) is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;

    if not exists (
        select 1
        from public.profiles as p
        where p.id = (select auth.uid())
          and p.role = 'student'
    ) then
        raise exception 'Only student accounts can update a branch.' using errcode = '42501';
    end if;

    clean_branch := nullif(pg_catalog.btrim(coalesce(requested_branch, '')), '');
    if clean_branch is null or pg_catalog.char_length(clean_branch) > 80 then
        raise exception 'Enter a branch name between 1 and 80 characters.' using errcode = '22023';
    end if;

    update public.profiles
    set branch = clean_branch
    where id = (select auth.uid());

    if not found then
        raise exception 'Profile not found.' using errcode = 'P0002';
    end if;

    return clean_branch;
end;
$$;

revoke all on function public.set_my_branch(text) from public, anon;
grant execute on function public.set_my_branch(text) to authenticated;

-- Correct the existing owner account's displayed name.
update public.profiles as p
set full_name = 'Premchand'
from auth.users as u
where p.id = u.id
  and lower(u.email) = lower('pm099663@gmail.com')
  and p.full_name is distinct from 'Premchand';

-- Require each approved student to provide a branch before submitting a complaint.
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
              and p.branch is not null
        )
        and status = 'submitted'
        and admin_note is null
        and handled_by is null
    );
