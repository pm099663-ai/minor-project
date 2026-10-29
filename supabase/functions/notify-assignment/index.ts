import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !resendKey || !fromEmail) {
    return json({ error: "Email notification is not configured." }, 503);
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sign in is required." }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: "Your session is not valid." }, 401);

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: actor, error: actorError } = await serviceClient
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (actorError || !actor || !["admin", "owner"].includes(actor.role)) {
    return json({ error: "Management access is required." }, 403);
  }

  let body: { complaintId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (typeof body.complaintId !== "string") return json({ error: "Complaint ID is required." }, 400);

  const { data: complaint, error: complaintError } = await serviceClient
    .from("complaints")
    .select("id, ticket_number, title, location, status, assigned_employee_id, handled_by")
    .eq("id", body.complaintId)
    .maybeSingle();
  if (complaintError || !complaint || !complaint.assigned_employee_id || complaint.status !== "in_progress" || complaint.handled_by !== user.id) {
    return json({ error: "The complaint is not assigned to an active employee." }, 404);
  }

  const { data: employee, error: employeeError } = await serviceClient
    .from("profiles").select("full_name, email, role, work_category")
    .eq("id", complaint.assigned_employee_id).maybeSingle();
  if (employeeError || !employee || employee.role !== "employee" || !employee.email) {
    return json({ error: "The assigned employee has no valid email address." }, 422);
  }

  const ticket = `CC-${String(complaint.ticket_number).padStart(6, "0")}`;
  const siteUrl = (Deno.env.get("APP_URL") || "https://campuscare-complaints.vercel.app").replace(/\/$/, "");
  const name = escapeHtml(employee.full_name || "Employee");
  const title = escapeHtml(complaint.title);
  const location = escapeHtml(complaint.location);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromEmail,
      to: [employee.email],
      subject: `CampusCare work assigned: ${ticket}`,
      html: `<p>Hello ${name},</p><p>A campus complaint has been assigned to you.</p><p><strong>${ticket}: ${title}</strong><br>Location: ${location}<br>Work category: ${escapeHtml(employee.work_category || "General maintenance")}</p><p>Sign in to your employee portal to view the details and upload completion proof.</p><p><a href="${siteUrl}">Open CampusCare</a></p>`,
    }),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    console.error("Resend rejected assignment email", response.status, responseBody);
    return json({ error: "Email provider could not send the assignment notice." }, 502);
  }
  return json({ sent: true });
});
