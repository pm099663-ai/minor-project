-- Employee portal, account approval, work assignment, and completion evidence.

alter table public.profiles
    add column if not exists requested_role text not null default 'student',
    add column if not exists phone text,
    add column if not exists work_category text,
    add column if not exists id_card_path text,
    add column if not exists id_card_mime_type text;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
    check (role in ('pending', 'student', 'employee', 'admin', 'owner'));

alter table public.profiles drop constraint if exists profiles_requested_role_check;
alter table public.profiles add constraint profiles_requested_role_check
    check (requested_role in ('student', 'employee'));

alter table public.profiles drop constraint if exists profiles_employee_details_check;
alter table public.profiles add constraint profiles_employee_details_check
    check (
        (phone is null or char_length(pg_catalog.btrim(phone)) between 7 and 25)
        and (work_category is null or char_length(pg_catalog.btrim(work_category)) between 2 and 80)
        and (
            (id_card_path is null and id_card_mime_type is null)
            or (
                id_card_path is not null
                and id_card_mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')
                and char_length(id_card_path) <= 512
                and id_card_path like 'id-cards/' || id::text || '/%'
            )
        )
    );

-- Never accept a privileged role from signup metadata. Only the request type and
-- basic contact fields are copied; the role always remains pending.
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
        when new.raw_user_meta_data ->> 'requested_role' = 'employee' then 'employee'
        else 'student'
    end;
    clean_phone := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '');
    clean_work_category := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'work_category', '')), '');
    requested_college_id := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'college_id', '')), '');
    requested_branch := nullif(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'branch', '')), '');

    insert into public.profiles (id, full_name, email, college_id, branch, requested_role, phone, work_category)
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

-- The initial owner is unchanged. Existing approved roles are preserved.
-- Account list visibility is already granted to management by the previous migration.
revoke update on table public.profiles from public, anon, authenticated;
revoke update (role) on table public.profiles from public, anon, authenticated;
drop policy if exists profiles_update_roles_owner on public.profiles;

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
        raise exception 'Sign in before uploading your college ID.' using errcode = '42501';
    end if;
    if requested_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf')
       or requested_path is null
       or char_length(requested_path) > 512
       or requested_path not like 'id-cards/' || (select auth.uid())::text || '/%' then
        raise exception 'Choose a valid college ID image or PDF.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from public.profiles as p
        where p.id = (select auth.uid())
          and p.requested_role = 'student'
          and p.role in ('pending', 'student')
    ) then
        raise exception 'This account cannot upload a student ID card.' using errcode = '42501';
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

alter table public.complaints
    add column if not exists assigned_employee_id uuid references public.profiles (id) on delete set null,
    add column if not exists work_proof_path text,
    add column if not exists work_proof_mime_type text;

create index if not exists complaints_assigned_employee_created_idx
    on public.complaints (assigned_employee_id, created_at desc);

alter table public.complaints drop constraint if exists complaints_status_check;
alter table public.complaints add constraint complaints_status_check
    check (status in ('submitted', 'in_progress', 'work_completed', 'resolved', 'rejected'));

alter table public.complaints drop constraint if exists complaints_work_proof_check;
alter table public.complaints add constraint complaints_work_proof_check
    check (
        (work_proof_path is null and work_proof_mime_type is null)
        or (
            work_proof_path is not null
            and work_proof_mime_type in (
                'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
                'video/mp4', 'video/webm', 'video/quicktime'
            )
            and assigned_employee_id is not null
            and char_length(work_proof_path) <= 512
            and work_proof_path like 'work-proofs/' || id::text || '/' || assigned_employee_id::text || '/%'
        )
    );
alter table public.complaints drop constraint if exists complaints_work_completed_requires_proof;
alter table public.complaints add constraint complaints_work_completed_requires_proof
    check (status <> 'work_completed' or work_proof_path is not null);

-- Keep browser writes to complaint status/assignment behind checked RPCs.
revoke update on table public.complaints from public, anon, authenticated;
revoke update (status, admin_note, handled_by) on table public.complaints from public, anon, authenticated;
grant update (proof_path, proof_mime_type) on table public.complaints to authenticated;
drop policy if exists complaints_update_management on public.complaints;

drop policy if exists complaints_select_owner_or_management on public.complaints;
create policy complaints_select_owner_or_management
    on public.complaints for select to authenticated
    using (
        user_id = (select auth.uid())
        or assigned_employee_id = (select auth.uid())
        or (select private.is_management())
    );

create or replace function public.assign_complaint(target_complaint_id uuid, target_employee_id uuid)
returns table (id uuid, ticket_number bigint, assigned_employee_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not (select private.is_management()) then
        raise exception 'Only management can assign work.' using errcode = '42501';
    end if;
    if not exists (
        select 1 from public.profiles as p
        where p.id = target_employee_id and p.role = 'employee'
    ) then
        raise exception 'Choose an approved employee account.' using errcode = '22023';
    end if;
    return query
        update public.complaints as c
           set assigned_employee_id = target_employee_id,
               status = 'in_progress',
               handled_by = (select auth.uid()),
               work_proof_path = null,
               work_proof_mime_type = null
         where c.id = target_complaint_id
           and c.status not in ('work_completed', 'resolved', 'rejected')
        returning c.id, c.ticket_number, c.assigned_employee_id, c.status;
    if not found then
        raise exception 'Complaint not found or already closed.' using errcode = 'P0002';
    end if;
end;
$$;

revoke all on function public.assign_complaint(uuid, uuid) from public, anon;
grant execute on function public.assign_complaint(uuid, uuid) to authenticated;

create or replace function public.complete_assigned_work(target_complaint_id uuid, requested_path text, requested_mime_type text)
returns table (id uuid, ticket_number bigint, status text, work_proof_path text, work_proof_mime_type text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if requested_mime_type not in (
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
        'video/mp4', 'video/webm', 'video/quicktime'
    ) or requested_path is null or char_length(requested_path) > 512 then
        raise exception 'Choose a supported work photo or video.' using errcode = '22023';
    end if;
    if not exists (
        select 1 from storage.objects as o
        where o.bucket_id = 'campuscare-private' and o.name = requested_path
    ) then
        raise exception 'Upload the work proof first.' using errcode = 'P0002';
    end if;

    return query
        update public.complaints as c
           set work_proof_path = requested_path,
               work_proof_mime_type = requested_mime_type,
               status = 'work_completed'
         where c.id = target_complaint_id
           and c.assigned_employee_id = (select auth.uid())
           and c.status = 'in_progress'
           and requested_path like 'work-proofs/' || c.id::text || '/' || (select auth.uid())::text || '/%'
           and exists (
               select 1 from public.profiles as p
               where p.id = (select auth.uid()) and p.role = 'employee'
           )
        returning c.id, c.ticket_number, c.status, c.work_proof_path, c.work_proof_mime_type;
    if not found then
        raise exception 'This work is not assigned to your account or is no longer in progress.' using errcode = '42501';
    end if;
end;
$$;

revoke all on function public.complete_assigned_work(uuid, text, text) from public, anon;
grant execute on function public.complete_assigned_work(uuid, text, text) to authenticated;

create or replace function public.update_complaint_management(target_complaint_id uuid, requested_status text, requested_note text)
returns table (id uuid, status text, admin_note text, handled_by uuid, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_status text;
begin
    if not (select private.is_management()) then
        raise exception 'Only management can update complaints.' using errcode = '42501';
    end if;
    if requested_status not in ('submitted', 'in_progress', 'resolved', 'rejected') then
        raise exception 'Choose a valid management status.' using errcode = '22023';
    end if;
    if requested_note is not null and char_length(requested_note) > 3000 then
        raise exception 'The update note must be 3000 characters or fewer.' using errcode = '22023';
    end if;
    select c.status into current_status
    from public.complaints as c
    where c.id = target_complaint_id
    for update;
    if not found then
        raise exception 'Complaint not found.' using errcode = 'P0002';
    end if;
    if requested_status = 'resolved' and current_status <> 'work_completed' then
        raise exception 'Resolve this complaint after the employee submits completion proof.' using errcode = '22023';
    end if;

    return query
        update public.complaints as c
           set status = requested_status,
               admin_note = nullif(pg_catalog.btrim(coalesce(requested_note, '')), ''),
               handled_by = (select auth.uid())
         where c.id = target_complaint_id
        returning c.id, c.status, c.admin_note, c.handled_by, c.updated_at;
end;
$$;

revoke all on function public.update_complaint_management(uuid, text, text) from public, anon;
grant execute on function public.update_complaint_management(uuid, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'campuscare-private', 'campuscare-private', false, 26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Assigned employees may inspect the original student evidence for their jobs.
drop policy if exists campuscare_proof_select_linked on storage.objects;
create policy campuscare_proof_select_linked
    on storage.objects for select to authenticated
    using (
        bucket_id = 'complaint-proofs'
        and exists (
            select 1 from public.complaints as c
            where c.proof_path = storage.objects.name
              and c.id::text = (storage.foldername(storage.objects.name))[2]
              and c.user_id::text = (storage.foldername(storage.objects.name))[1]
              and (
                  c.user_id = (select auth.uid())
                  or c.assigned_employee_id = (select auth.uid())
                  or (select private.is_management())
              )
        )
    );

drop policy if exists campuscare_private_select_linked on storage.objects;
create policy campuscare_private_select_linked
    on storage.objects for select to authenticated
    using (
        bucket_id = 'campuscare-private'
        and (
            (
                (storage.foldername(name))[1] = 'id-cards'
                and exists (
                    select 1 from public.profiles as p
                    where p.id::text = (storage.foldername(name))[2]
                      and p.id_card_path = storage.objects.name
                      and (p.id = (select auth.uid()) or (select private.is_management()))
                )
            )
            or (
                (storage.foldername(name))[1] = 'work-proofs'
                and exists (
                    select 1 from public.complaints as c
                    where c.work_proof_path = storage.objects.name
                      and (
                          c.user_id = (select auth.uid())
                          or c.assigned_employee_id = (select auth.uid())
                          or (select private.is_management())
                      )
                )
            )
        )
    );

drop policy if exists campuscare_private_insert_own on storage.objects;
create policy campuscare_private_insert_own
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'campuscare-private'
        and (
            (
                (storage.foldername(name))[1] = 'id-cards'
                and (storage.foldername(name))[2] = (select auth.uid())::text
                and array_length(storage.foldername(name), 1) = 2
                and exists (
                    select 1 from public.profiles as p
                    where p.id = (select auth.uid())
                      and p.role in ('pending', 'student')
                      and p.requested_role = 'student'
                      and p.id_card_path is null
                )
            )
            or (
                (storage.foldername(name))[1] = 'work-proofs'
                and array_length(storage.foldername(name), 1) = 3
                and exists (
                    select 1 from public.complaints as c
                    join public.profiles as p on p.id = c.assigned_employee_id
                    where c.id::text = (storage.foldername(name))[2]
                      and c.assigned_employee_id = (select auth.uid())
                      and p.role = 'employee'
                      and c.status = 'in_progress'
                )
                and (storage.foldername(name))[3] = (select auth.uid())::text
            )
        )
    );

drop policy if exists campuscare_private_delete_unlinked_own on storage.objects;
create policy campuscare_private_delete_unlinked_own
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'campuscare-private'
        and (
            (
                (storage.foldername(name))[1] = 'id-cards'
                and (storage.foldername(name))[2] = (select auth.uid())::text
                and exists (
                    select 1 from public.profiles as p
                    where p.id = (select auth.uid()) and p.id_card_path is null
                )
            )
            or (
                (storage.foldername(name))[1] = 'work-proofs'
                and (storage.foldername(name))[3] = (select auth.uid())::text
                and exists (
                    select 1 from public.complaints as c
                    where c.id::text = (storage.foldername(name))[2]
                      and c.assigned_employee_id = (select auth.uid())
                      and c.work_proof_path is null
                )
            )
        )
    );
