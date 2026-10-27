-- Private proof storage for CampusCare complaint photos and videos.
-- First create a PRIVATE bucket named complaint-proofs in Supabase Storage.
-- Set its max file size to 25 MB and allow only the MIME types listed below.

alter table public.complaints
    add column if not exists proof_path text,
    add column if not exists proof_mime_type text;

alter table public.complaints
    drop constraint if exists complaints_proof_metadata_check;

alter table public.complaints
    add constraint complaints_proof_metadata_check
    check (
        (proof_path is null and proof_mime_type is null)
        or (
            proof_path is not null
            and proof_mime_type is not null
            and char_length(proof_path) <= 512
            and proof_path like user_id::text || '/' || id::text || '/%'
            and proof_mime_type in (
                'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
                'video/mp4', 'video/webm', 'video/quicktime'
            )
        )
    );

grant update (proof_path, proof_mime_type) on public.complaints to authenticated;

drop policy if exists complaints_attach_proof_own on public.complaints;
create policy complaints_attach_proof_own
    on public.complaints
    for update
    to authenticated
    using (
        user_id = (select auth.uid())
        and status in ('submitted', 'in_progress')
        and proof_path is null
        and exists (
            select 1
            from public.profiles as p
            where p.id = (select auth.uid())
              and p.role = 'student'
        )
    )
    with check (
        user_id = (select auth.uid())
        and status in ('submitted', 'in_progress')
        and proof_path is not null
        and proof_path like user_id::text || '/' || id::text || '/%'
        and proof_mime_type in (
            'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
            'video/mp4', 'video/webm', 'video/quicktime'
        )
        and exists (
            select 1
            from public.profiles as p
            where p.id = (select auth.uid())
              and p.role = 'student'
        )
    );

drop policy if exists campuscare_proof_select_linked on storage.objects;
create policy campuscare_proof_select_linked
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'complaint-proofs'
        and exists (
            select 1
            from public.complaints as c
            where c.proof_path = storage.objects.name
              and c.id::text = (storage.foldername(storage.objects.name))[2]
              and c.user_id::text = (storage.foldername(storage.objects.name))[1]
              and (
                  c.user_id = (select auth.uid())
                  or (select private.is_management())
              )
        )
    );

drop policy if exists campuscare_proof_insert_own on storage.objects;
create policy campuscare_proof_insert_own
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'complaint-proofs'
        and array_length(storage.foldername(name), 1) = 2
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and exists (
            select 1
            from public.complaints as c
            join public.profiles as p on p.id = c.user_id
            where c.id::text = (storage.foldername(name))[2]
              and c.user_id = (select auth.uid())
              and c.status in ('submitted', 'in_progress')
              and c.proof_path is null
              and p.role = 'student'
        )
    );

-- Permit cleanup only for a just-uploaded object not linked to a complaint yet.
drop policy if exists campuscare_proof_delete_unlinked_own on storage.objects;
create policy campuscare_proof_delete_unlinked_own
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'complaint-proofs'
        and array_length(storage.foldername(name), 1) = 2
        and (storage.foldername(name))[1] = (select auth.uid())::text
        and exists (
            select 1
            from public.complaints as c
            where c.id::text = (storage.foldername(name))[2]
              and c.user_id = (select auth.uid())
              and c.proof_path is null
        )
    );
