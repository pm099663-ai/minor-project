# CampusCare complaint management

## Live presentation demo

Open the deployed website: https://campuscare-complaints.vercel.app

This folder contains the static website source, Supabase configuration, SQL migrations, and the assignment-notification Edge Function.

The website uses Supabase Auth and Postgres. The browser contains only the Supabase project URL and public publishable key. Database Row Level Security and checked RPC functions enforce account and complaint access.

## Supabase setup

Apply the existing migrations in order, then apply `supabase/migrations/20261029000000_employee_workflow.sql`:

1. `20261026000000_campuscare.sql`
2. `20261026010000_owner_admin_management.sql`
3. `20261026020000_owner_approval.sql`
4. `20261027000000_complaint_proof_storage.sql`
5. `20261028000000_student_branch_and_owner_name.sql`
6. `20261029000000_employee_workflow.sql`

The complaint-proof migration expects a private `complaint-proofs` bucket (25 MB; images and videos). The new workflow migration creates a second private bucket for college ID cards and employee work evidence.

Students request an account with college ID/roll number, branch, and a college ID image/PDF. Employees request an account with name, email, mobile number, and work category. New requests stay pending until management approves them. Admins can approve and manage student/employee accounts, but only the owner can create or change Admin accounts.

Management assigns an approved employee to a complaint. The employee sees only assigned complaints, uploads a work photo/video, and submits it for management review. Management resolves or returns the work; the student can see the updated status and management note.

## Assignment email setup

Deploy `supabase/functions/notify-assignment` as a Supabase Edge Function. Configure its secrets:

- `RESEND_API_KEY`: API key from Resend.
- `FROM_EMAIL`: sender email allowed by the Resend account.
- `APP_URL` (optional): website URL; defaults to `https://campuscare-complaints.vercel.app`.

Supabase provides its project URL and service-role key to deployed Edge Functions. Never put the service-role key or Resend key in browser code. Assignment works in the app without the email function, but the employee notification email needs the function and a verified sender configured.

## Run locally

Serve this directory over HTTP so JavaScript modules can load:

```powershell
npx http-server . -p 8000
```

Then open http://localhost:8000. Add that URL to the Supabase Auth redirect allowlist. No build step is required; the Supabase JavaScript client loads from esm.sh.

## Deploy

Deploy this folder as the static site root, including `index.html`, `style.css`, `main.js`, `app.js`, and `supabase-config.js`. Set the production URL in Supabase Authentication URL Configuration. The public project URL and publishable key go in `supabase-config.js`; never place a service-role or secret key there.

## Access model

- Students can submit complaints and see only their own reports.
- Employees can see only work assigned to their account and submit completion evidence.
- Admins and the owner can see complaints, assign employees, manage account requests, and resolve/return completed work.
- Admins cannot create or alter admin access. Only the owner can assign Admin.
- Student ID cards, complaint photos/videos, and employee work evidence are kept in private Storage buckets.
- Complaint history cannot be deleted from the browser.

The earlier demo verified student sign-in, complaint submission/tracking, and management access. The new workflow requires the migration and Edge Function setup above before the live site supports it.
