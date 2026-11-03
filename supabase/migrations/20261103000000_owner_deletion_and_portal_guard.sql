-- Owner-only account and complaint deletion, with portal-safe account cleanup.
-- Complaint history remains after account deletion, but is no longer linked to a login.

alter table public.complaints
    alter column user_id drop not null;

alter table public.complaints
    drop constraint if exists complaints_user_id_fkey;

alter table public.complaints
    add constraint complaints_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete set null;

-- Keep employee completion evidence valid when an employee account is removed.
alter table public.complaints
    drop constraint if exists complaints_work_proof_check;

alter table public.complaints
    add constraint complaints_work_proof_check
    check (
        (work_proof_path is null and work_proof_mime_type is null)
        or (
            work_proof_path is not null
            and work_proof_mime_type in (
                'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
                'video/mp4', 'video/webm', 'video/quicktime'
            )
            and char_length(work_proof_path) <= 512
            and work_proof_path like 'work-proofs/' || id::text || '/%'
            and (
                assigned_employee_id is null
                or work_proof_path like 'work-proofs/' || id::text || '/' || assigned_employee_id::text || '/%'
            )
        )
    );

create or replace function public.owner_delete_complaint(target_complaint_id uuid)
returns table (ticket_number bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_ticket_number bigint;
begin
    if not (select private.is_owner()) then
        raise exception 'Only the owner can delete complaints.' using errcode = '42501';
    end if;

    delete from public.complaints as c
    where c.id = target_complaint_id
    returning c.ticket_number into v_ticket_number;

    if not found then
        raise exception 'Complaint not found.';
    end if;

    return query select v_ticket_number;
end;
$$;

revoke all on function public.owner_delete_complaint(uuid) from public, anon, authenticated;
grant execute on function public.owner_delete_complaint(uuid) to authenticated;

create or replace function public.owner_delete_account(target_user_id uuid)
returns table (
    deleted_full_name text,
    deleted_email text,
    deleted_role text,
    preserved_complaints bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_full_name text;
    v_email text;
    v_role text;
    v_preserved_complaints bigint;
begin
    if not (select private.is_owner()) then
        raise exception 'Only the owner can delete accounts.' using errcode = '42501';
    end if;
    if target_user_id is null or target_user_id = (select auth.uid()) then
        raise exception 'You cannot delete your own owner account.';
    end if;

    select p.full_name, u.email, p.role
      into v_full_name, v_email, v_role
      from public.profiles as p
      join auth.users as u on u.id = p.id
     where p.id = target_user_id
     for update of p, u;

    if not found then
        raise exception 'Account not found.';
    end if;
    if v_role = 'owner' then
        raise exception 'Owner accounts cannot be deleted here.';
    end if;

    select pg_catalog.count(*)
      into v_preserved_complaints
      from public.complaints as c
     where c.user_id = target_user_id;

    -- Deleting the auth user cascades its profile. Linked complaints are kept
    -- and their user_id is set to NULL; employee assignments are also unassigned.
    delete from auth.users as u
     where u.id = target_user_id;

    if not found then
        raise exception 'Account could not be deleted.';
    end if;

    return query
    select v_full_name, v_email, v_role, v_preserved_complaints;
end;
$$;

revoke all on function public.owner_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.owner_delete_account(uuid) to authenticated;
