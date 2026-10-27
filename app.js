import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const supabaseUrl = SUPABASE_URL.trim();
const publishableKey = SUPABASE_PUBLISHABLE_KEY.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);
export const supabase = isSupabaseConfigured
    ? createClient(supabaseUrl, publishableKey, {
          auth: {
              autoRefreshToken: true,
              persistSession: true,
              detectSessionInUrl: true
          }
      })
    : null;

function requireClient() {
    if (!supabase) {
        throw new Error("Supabase is not configured. Add your project URL and publishable key to supabase-config.js.");
    }
    return supabase;
}

export async function getProfile(userId) {
    const { data, error } = await requireClient()
        .from("profiles")
        .select("id, full_name, role, college_id")
        .eq("id", userId)
        .single();
    if (error) throw error;
    return data;
}

export async function signIn(email, password) {
    return requireClient().auth.signInWithPassword({ email, password });
}

export async function registerStudent(email, password, fullName, collegeId) {
    return requireClient().auth.signUp({
        email,
        password,
        options: {
            data: { full_name: fullName, college_id: collegeId },
            emailRedirectTo: window.location.href.split("#")[0]
        }
    });
}

export async function signOut() {
    return requireClient().auth.signOut();
}

export async function requestPasswordReset(email) {
    return requireClient().auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href.split("#")[0]
    });
}

export async function updatePassword(password) {
    return requireClient().auth.updateUser({ password });
}

export async function loadComplaints({ offset, limit, status = "", category = "", ticketNumber = "", ownerId = "" }) {
    let query = requireClient()
        .from("complaints")
        .select("id, ticket_number, user_id, category, title, location, description, status, admin_note, handled_by, proof_path, proof_mime_type, created_at, updated_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

    if (ownerId) query = query.eq("user_id", ownerId);
    if (status) query = query.eq("status", status);
    if (category) query = query.eq("category", category);
    if (ticketNumber) query = query.eq("ticket_number", Number(ticketNumber));

    const { data, error, count } = await query;
    if (error) throw error;
    return { rows: data ?? [], count: count ?? 0 };
}

export async function createComplaint({ category, title, location, description }) {
    const { data, error } = await requireClient()
        .from("complaints")
        .insert({ category, title, location, description })
        .select("id, ticket_number, status, created_at")
        .single();
    if (error) throw error;
    return data;
}

const COMPLAINT_PROOF_BUCKET = "complaint-proofs";
export const COMPLAINT_PROOF_MAX_BYTES = 25 * 1024 * 1024;
const COMPLAINT_PROOF_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
    "video/mp4", "video/webm", "video/quicktime"
]);

export function validateComplaintProof(file) {
    if (!file) return;
    if (!COMPLAINT_PROOF_TYPES.has(file.type.toLowerCase())) {
        throw new Error("Choose a JPG, PNG, WebP, GIF, HEIC, MP4, WebM, or MOV photo/video.");
    }
    if (file.size > COMPLAINT_PROOF_MAX_BYTES) {
        throw new Error("The photo/video must be 25 MB or smaller.");
    }
}

export async function attachComplaintProof({ complaintId, userId, file }) {
    if (!file) throw new Error("Choose a photo or video first.");
    validateComplaintProof(file);
    const originalName = (file.name || "proof").split(/[\\/]/).pop();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-100) || "proof";
    const uniqueName = globalThis.crypto?.randomUUID?.() || (Date.now() + "-" + Math.random().toString(36).slice(2));
    const path = userId + "/" + complaintId + "/" + uniqueName + "-" + safeName;
    const bucket = requireClient().storage.from(COMPLAINT_PROOF_BUCKET);
    const { data: uploaded, error: uploadError } = await bucket.upload(path, file, {
        cacheControl: "3600",
        contentType: file.type,
        upsert: false
    });
    if (uploadError) throw uploadError;

    const { data, error } = await requireClient()
        .from("complaints")
        .update({ proof_path: uploaded.path, proof_mime_type: file.type.toLowerCase() })
        .eq("id", complaintId)
        .select("id, proof_path, proof_mime_type")
        .single();
    if (error) {
        try {
            await bucket.remove([uploaded.path]);
        } catch {
            // Keep the original database error; cleanup only removes unlinked uploads.
        }
        throw error;
    }
    return data;
}

export async function createComplaintProofUrl(path) {
    const { data, error } = await requireClient()
        .storage
        .from(COMPLAINT_PROOF_BUCKET)
        .createSignedUrl(path, 60 * 60);
    if (error) throw error;
    return data.signedUrl;
}

export async function updateComplaint({ id, status, adminNote, handlerId }) {
    const { data, error } = await requireClient()
        .from("complaints")
        .update({ status, admin_note: adminNote, handled_by: handlerId })
        .eq("id", id)
        .select("id, status, admin_note, handled_by, updated_at")
        .single();
    if (error) throw error;
    return data;
}
export async function listProfilesForOwner() {
    const { data, error } = await requireClient()
        .from("profiles")
        .select("id, full_name, email, college_id, role, created_at")
        .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
}

export async function setProfileRole(userId, role) {
    if (!['pending', 'student', 'admin'].includes(role)) {
        throw new Error("Choose either Student or Admin.");
    }
    const { data, error } = await requireClient()
        .from("profiles")
        .update({ role })
        .eq("id", userId)
        .select("id, full_name, email, role")
        .single();
    if (error) throw error;
    return data;
}
