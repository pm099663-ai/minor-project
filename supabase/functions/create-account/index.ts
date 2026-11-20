import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(status: number, body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

Deno.serve(async (request) => {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (request.method !== "POST") return respond(405, { error: "Use POST to create an account invitation." });

    const authorization = request.headers.get("Authorization") || "";
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return respond(401, { error: "Sign in with a management account first." });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return respond(500, { error: "Account invitation service is not configured." });

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    try {
        const { data: authData, error: authError } = await adminClient.auth.getUser(accessToken);
        if (authError || !authData.user) return respond(401, { error: "Your session expired. Sign in again." });

        const { data: actor, error: actorError } = await adminClient
            .from("profiles")
            .select("role")
            .eq("id", authData.user.id)
            .single();
        if (actorError || !["owner", "admin"].includes(actor?.role)) {
            return respond(403, { error: "Only management can create account invitations." });
        }

        let body: Record<string, unknown>;
        try {
            body = await request.json();
        } catch {
            return respond(400, { error: "Enter the account details and try again." });
        }

        const fullName = String(body.full_name || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        const requestedRole = String(body.requested_role || "");
        const collegeId = String(body.college_id || "").trim();
        const branch = String(body.branch || "").trim();
        const phone = String(body.phone || "").trim();
        const workCategory = String(body.work_category || "").trim();

        if (fullName.length < 1 || fullName.length > 100) return respond(400, { error: "Enter a name up to 100 characters." });
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: "Enter a valid email address." });
        if (!["student", "employee", "admin"].includes(requestedRole)) return respond(400, { error: "Choose Student, Employee, or Admin." });
        if (requestedRole === "admin" && actor.role !== "owner") return respond(403, { error: "Only the owner can invite an admin." });
        if (requestedRole === "student" && (collegeId.length > 50 || branch.length > 80)) return respond(400, { error: "Check the college ID and branch lengths." });
        if (requestedRole === "employee" && (phone.length < 7 || phone.length > 25 || workCategory.length < 2 || workCategory.length > 80)) {
            return respond(400, { error: "Enter the employee phone number and work category." });
        }

        const siteUrl = (Deno.env.get("CAMPUSCARE_SITE_URL") || "https://campuscare-complaints.vercel.app").replace(/\/$/, "");
        const redirect = new URL(siteUrl + "/");
        redirect.searchParams.set("verify", "invite");
        redirect.searchParams.set("email", email);

        const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
            data: {
                full_name: fullName,
                requested_role: requestedRole,
                college_id: requestedRole === "student" ? collegeId : "",
                branch: requestedRole === "student" ? branch : "",
                phone: requestedRole === "employee" ? phone : "",
                work_category: requestedRole === "employee" ? workCategory : "",
            },
            redirectTo: redirect.toString(),
        });
        if (error) return respond(400, { error: error.message });

        return respond(200, {
            invited: true,
            user_id: data.user?.id,
            email,
            requested_role: requestedRole,
            message: "Invitation sent. This account remains pending until management approves it.",
        });
    } catch (error) {
        return respond(500, { error: error instanceof Error ? error.message : "Could not send the invitation." });
    }
});

