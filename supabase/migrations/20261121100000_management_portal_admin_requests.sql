-- Let applicants request management access through the Management portal.
-- A request remains pending until the owner grants the admin role.

alter table public.profiles
    drop constraint if exists profiles_requested_role_check;

alter table public.profiles
    add constraint profiles_requested_role_check
    check (requested_role in ('student', 'employee', 'admin'));

create or replace function public.set_account_access(target_user_id uuid, requested_access text)
returns table (id uuid, full_name text, email text, role text, requested_role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor_role text;
    target_role text;
    target_request text;
    target_card text;
    target_phone text;
    target_category text;
begin
    select p.role into actor_role
    from public.profiles as p
    where p.id = (select auth.uid());

    if coalesce(actor_role, '') not in ('owner', 'admin') then
        raise exception 'Only management can approve accounts.' using errcode = '42501';
    end if;
    if target_user_id is null or target_user_id = (select auth.uid()) then
        raise exception 'Choose another account.' using errcode = '22023';
    end if;
    if requested_access not in ('pending', 'student', 'employee', 'admin') then
        raise exception 'Choose Pending, Student, Employee, or Admin.' using errcode = '22023';
    end if;

    select p.role, p.requested_role, p.id_card_path, p.phone, p.work_category
      into target_role, target_request, target_card, target_phone, target_category
    from public.profiles as p
    where p.id = target_user_id
    for update;

    if not found then
        raise exception 'Account not found.' using errcode = 'P0002';
    end if;
    if target_role = 'owner' then
        raise exception 'The owner account cannot be changed here.' using errcode = '42501';
    end if;
    if actor_role = 'admin' and (target_role in ('admin', 'owner') or requested_access = 'admin') then
        raise exception 'Admins cannot change admin accounts or create another admin.' using errcode = '42501';
    end if;
    if requested_access = 'admin' and actor_role <> 'owner' then
        raise exception 'Only the owner can approve Admin access.' using errcode = '42501';
    end if;
    if requested_access = 'admin' and target_request <> 'admin' then
        raise exception 'Only an account requesting management access can be approved as Admin.' using errcode = '22023';
    end if;
    if requested_access = 'admin' and target_card is null then
        raise exception 'Upload and review the ID card before approving Admin access.' using errcode = '22023';
    end if;
    if requested_access = 'student' and target_role <> 'student' and target_card is null then
        raise exception 'Upload and review the student college ID card before approval.' using errcode = '22023';
    end if;
    if requested_access = 'employee' and target_role <> 'employee'
       and (target_phone is null or target_category is null) then
        raise exception 'The employee must provide a phone number and work category.' using errcode = '22023';
    end if;

    update public.profiles as p
       set role = requested_access,
           requested_role = case
               when requested_access in ('student', 'employee') then requested_access
               else target_request
           end
     where p.id = target_user_id;

    return query
        select p.id, p.full_name, p.email, p.role, p.requested_role
        from public.profiles as p
        where p.id = target_user_id;
end;
$$;

revoke all on function public.set_account_access(uuid, text) from public, anon;
grant execute on function public.set_account_access(uuid, text) to authenticated;

create or replace function public.set_my_id_card(requested_path text, requested_mime_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null then
        raise exception 'Sign in before uploading your ID card.' using errcode = '42501';
    end if;
    if requested_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')
       or requested_path is null
       or char_length(requested_path) > 512
       or requested_path not like 'id-cards/' || (select auth.uid())::text || '/%' then
        raise exception 'Choose a valid ID card image or PDF.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.profiles as p
        where p.id = (select auth.uid())
          and p.requested_role in ('student', 'admin')
          and p.role in ('pending', 'student', 'admin')
    ) then
        raise exception 'This account cannot upload an ID card.' using errcode = '42501';
    end if;
    if not exists (
        select 1 from storage.objects as o
        where o.bucket_id = 'campuscare-private' and o.name = requested_path
    ) then
        raise exception 'Upload the ID card file first.' using errcode = 'P0002';
    end if;

    update public.profiles
       set id_card_path = requested_path,
           id_card_mime_type = requested_mime_type
     where id = (select auth.uid());
    return requested_path;
end;
$$;

revoke all on function public.set_my_id_card(text, text) from public, anon;
grant execute on function public.set_my_id_card(text, text) to authenticated;

-- The existing policy covers students and employees. This additional policy
-- permits only a pending management applicant to upload their own ID card.
drop policy if exists campuscare_management_request_id_card_insert on storage.objects;
create policy campuscare_management_request_id_card_insert
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'campuscare-private'
        and (storage.foldername(name))[1] = 'id-cards'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and array_length(storage.foldername(name), 1) = 2
        and exists (
            select 1 from public.profiles as p
            where p.id = (select auth.uid())
              and p.role = 'pending'
              and p.requested_role = 'admin'
              and p.id_card_path is null
        )
    );
