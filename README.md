# CampusCare complaint management

## Live presentation demo

Open the deployed website: https://campuscare-complaints.vercel.app

This folder contains the complete static website source, Supabase configuration, and SQL migrations.

This is a static HTML/CSS/JavaScript site backed by Supabase Auth and Postgres. The browser uses only the Supabase project URL and publishable (or legacy anon) key. Row Level Security and restricted SQL grants control access to profiles and complaints.

## Supabase setup

1. Create a Supabase project.
2. In the project SQL Editor, run supabase/migrations/20261026000000_campuscare.sql.
3. In a new SQL Editor query, run supabase/migrations/20261026010000_owner_admin_management.sql. This adds owner-only account controls and promotes the existing management account named in that file to the initial owner.
4. In a new SQL Editor query, run supabase/migrations/20261026020000_owner_approval.sql. New signups will stay pending until the owner approves them. The owner can review the submitted college ID and grant Student or Admin access.
5. Copy the project URL and publishable key (or legacy anon key) into supabase-config.js. These are public browser values. Never put a service_role or secret key in this site.
6. In Authentication settings, enable Email sign-in. Configure the site URL and allowed redirect URLs for local development and the deployed site. Password reset and email verification links return to the current page.
7. New users submit a Student Portal account request with their college ID or roll number. The owner reviews each request in Manage accounts and assigns Pending, Student, or Admin. Admins manage complaints but cannot grant portal access.
8. In Supabase Storage, create a PRIVATE bucket named **complaint-proofs**. Set the size limit to 25 MB and allowed MIME types to: image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif, video/mp4, video/webm, and video/quicktime.
9. After creating that bucket, run supabase/migrations/20261027000000_complaint_proof_storage.sql in the SQL Editor. Students can take a photo/video with their camera or choose a saved file; the student and management accounts can view it.

The first owner is configured in supabase/migrations/20261026010000_owner_admin_management.sql. Change that email in the final UPDATE statement before running the migration if a different existing account should own the site.

## Run locally

Serve this directory over HTTP so the JavaScript modules and CDN import work. For example, with Node.js installed:

~~~~powershell
npx http-server . -p 8000
~~~~

Then open http://localhost:8000. Add that local URL to the Supabase Auth redirect allowlist. No build step is required. The Supabase JavaScript v2 client is loaded from esm.sh, so the browser needs network access.

## Deploy

Deploy this directory as the root of a static site, including supabase-config.js, index.html, style.css, main.js, and app.js. Set the deployed origin as the Supabase Auth site URL and add the exact origin/page URL to allowed redirect URLs. Confirm the project URL and publishable key in supabase-config.js before publishing.

.env.example records the public configuration names for tooling that injects environment variables. A plain static host does not read .env; configure the two values in supabase-config.js or have the host generate that file during deployment.

## Data and access model

- profiles: one row per Auth user; new rows are created by a database trigger with the pending role. Users can read only their own profile. The owner can read profiles and change other users between pending, student, and admin.
- complaints: students can create complaints and read only their own. Admins and the owner can read the queue and update complaint status and management notes. Complaint history cannot be deleted from the browser.
- RLS is enabled on both tables. SQL grants further limit each role's allowed operations and columns.
- Only an owner can change account roles through the website. The owner account cannot demote itself from the page.
- Complaint proof photos and videos are stored in a private Storage bucket and can be viewed only by the student who submitted the complaint and management accounts.

## Verification and limits

The student account signed in, submitted complaint CC-100001, and retrieved it by tracking number. Admin sign-in and dashboard access were also confirmed in the browser. The owner-management and owner-approval migrations must be run in Supabase before the owner approval controls work. Live demo: https://campuscare-complaints.vercel.app

