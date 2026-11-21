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

        let form: FormData;
        try {
            form = await request.formData();
        } catch {
            return respond(400, { error: "Enter the account details and try again." });
        }

        const field = (name: string) => String(form.get(name) || "").trim();
        const fullName = field("full_name");
        const email = field("email").toLowerCase();
        const requestedRole = field("requested_role");
        const department = field("department");
        const collegeId = field("college_id");
        const branch = field("branch");
        const phone = field("phone");
        const workCategory = field("work_category");
        const idCardFile = form.get("id_card");
        const idCardTypes: Record<string, string> = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/heic": "heic",
            "image/heif": "heif",
            "application/pdf": "pdf",
        };

        if (fullName.length < 1 || fullName.length > 100) return respond(400, { error: "Enter a name up to 100 characters." });
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: "Enter a valid email address." });
        if (!["student", "employee", "admin"].includes(requestedRole)) return respond(400, { error: "Choose Student, Employee, or Admin." });
        if (department.length < 1 || department.length > 100) return respond(400, { error: "Enter a department up to 100 characters." });
        if (!(idCardFile instanceof File) || !(idCardFile.type.toLowerCase() in idCardTypes)) {
            return respond(400, { error: "Upload an ID card image or PDF." });
        }
        if (idCardFile.size < 1 || idCardFile.size > 5 * 1024 * 1024) {
            return respond(400, { error: "The ID card must be smaller than 5 MB." });
        }
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
                department,
                college_id: requestedRole === "student" ? collegeId : "",
                branch: requestedRole === "student" ? branch : "",
                phone: requestedRole === "employee" ? phone : "",
                work_category: requestedRole === "employee" ? workCategory : "",
            },
            redirectTo: redirect.toString(),
        });
        if (error) return respond(400, { error: error.message });

        const invitedUserId = data.user?.id;
        if (!invitedUserId) return respond(500, { error: "Invitation was created, but its account could not be identified." });

        const mimeType = idCardFile.type.toLowerCase();
        const idCardPath = `id-cards/${invitedUserId}/${crypto.randomUUID()}.${idCardTypes[mimeType]}`;
        const { error: uploadError } = await adminClient.storage
            .from("campuscare-private")
            .upload(idCardPath, new Uint8Array(await idCardFile.arrayBuffer()), {
                cacheControl: "3600",
                contentType: mimeType,
                upsert: false,
            });
        if (uploadError) {
            await adminClient.auth.admin.deleteUser(invitedUserId);
            return respond(500, { error: "The ID card could not be saved. Please try again." });
        }

        const { error: profileError } = await adminClient
            .from("profiles")
            .update({ department, id_card_path: idCardPath, id_card_mime_type: mimeType })
            .eq("id", invitedUserId);
        if (profileError) {
            await adminClient.storage.from("campuscare-private").remove([idCardPath]);
            await adminClient.auth.admin.deleteUser(invitedUserId);
            return respond(500, { error: "The account details could not be saved. Please try again." });
        }

        return respond(200, {
            invited: true,
            user_id: invitedUserId,
            email,
            requested_role: requestedRole,
            department,
            message: "Invitation sent. This account remains pending until management approves it.",
        });
    } catch (error) {
        return respond(500, { error: error instanceof Error ? error.message : "Could not send the invitation." });
    }
});
