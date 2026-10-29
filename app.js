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
        .select("id, full_name, role, requested_role, college_id, branch, phone, work_category, id_card_path, id_card_mime_type")
        .eq("id", userId)
        .single();
    if (error) throw error;
    return data;
}

export async function signIn(email, password) {
    return requireClient().auth.signInWithPassword({ email, password });
}

export async function registerStudent(email, password, fullName, collegeId, branch) {
    return requireClient().auth.signUp({
        email,
        password,
        options: {
            data: { full_name: fullName, college_id: collegeId, branch, requested_role: "student" },
            emailRedirectTo: window.location.href.split("#")[0]
        }
    });
}

export async function registerEmployee(email, password, fullName, phone, workCategory) {
    return requireClient().auth.signUp({
        email,
        password,
        options: {
            data: { full_name: fullName, phone, work_category: workCategory, requested_role: "employee" },
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

export async function loadComplaints({ offset, limit, status = "", category = "", ticketNumber = "", ownerId = "", assignedTo = "", excludeStatus = "" }) {
    let query = requireClient()
        .from("complaints")
        .select("id, ticket_number, user_id, category, title, location, description, status, admin_note, handled_by, assigned_employee_id, proof_path, proof_mime_type, work_proof_path, work_proof_mime_type, created_at, updated_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

    if (ownerId) query = query.eq("user_id", ownerId);
    if (status) query = query.eq("status", status);
    if (excludeStatus) query = query.neq("status", excludeStatus);
    if (category) query = query.eq("category", category);
    if (ticketNumber) query = query.eq("ticket_number", Number(ticketNumber));
    if (assignedTo) query = query.eq("assigned_employee_id", assignedTo);

    const { data, error, count } = await query;
    if (error) throw error;
    return { rows: data ?? [], count: count ?? 0 };
}

export async function loadComplaintSubmitters(userIds) {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return [];
    const { data, error } = await requireClient()
        .from("profiles")
        .select("id, full_name, branch")
        .in("id", ids);
    if (error) throw error;
    return data ?? [];
}

export async function updateOwnBranch(branch) {
    const { data, error } = await requireClient().rpc("set_my_branch", { requested_branch: branch });
    if (error) throw error;
    return data;
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

export async function updateComplaint({ id, status, adminNote }) {
    const { data, error } = await requireClient().rpc("update_complaint_management", {
        target_complaint_id: id,
        requested_status: status,
        requested_note: adminNote
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
}

const PRIVATE_EVIDENCE_BUCKET = "campuscare-private";
const WORK_PROOF_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
    "video/mp4", "video/webm", "video/quicktime"
]);
const ID_CARD_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
export const WORK_PROOF_MAX_BYTES = 25 * 1024 * 1024;
export const ID_CARD_MAX_BYTES = 10 * 1024 * 1024;

function validateEvidence(file, types, maxBytes, label) {
    if (!file) throw new Error("Choose " + label + " first.");
    if (!types.has(file.type.toLowerCase())) throw new Error("Choose a supported " + label + " file.");
    if (file.size > maxBytes) throw new Error("The " + label + " file is too large.");
}

function safeFileName(file, fallback) {
    const extension = (file.name || fallback).split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "file";
    const unique = globalThis.crypto?.randomUUID?.() || (Date.now() + "-" + Math.random().toString(36).slice(2));
    return unique + "." + extension;
}

export function validateIdCard(file) {
    validateEvidence(file, ID_CARD_TYPES, ID_CARD_MAX_BYTES, "college ID image or PDF");
}

export function validateWorkProof(file) {
    validateEvidence(file, WORK_PROOF_TYPES, WORK_PROOF_MAX_BYTES, "work photo or video");
}

export async function uploadStudentIdCard({ userId, file }) {
    validateIdCard(file);
    const path = "id-cards/" + userId + "/" + safeFileName(file, "college-id");
    const bucket = requireClient().storage.from(PRIVATE_EVIDENCE_BUCKET);
    const { data: uploaded, error: uploadError } = await bucket.upload(path, file, {
        cacheControl: "3600", contentType: file.type, upsert: false
    });
    if (uploadError) throw uploadError;
    const { data, error } = await requireClient().rpc("set_my_id_card", {
        requested_path: uploaded.path,
        requested_mime_type: file.type.toLowerCase()
    });
    if (error) {
        try { await bucket.remove([uploaded.path]); } catch { /* Keep the database error. */ }
        throw error;
    }
    return data;
}

export async function uploadWorkProof({ complaintId, employeeId, file }) {
    validateWorkProof(file);
    const path = "work-proofs/" + complaintId + "/" + employeeId + "/" + safeFileName(file, "work-proof");
    const bucket = requireClient().storage.from(PRIVATE_EVIDENCE_BUCKET);
    const { data: uploaded, error: uploadError } = await bucket.upload(path, file, {
        cacheControl: "3600", contentType: file.type, upsert: false
    });
    if (uploadError) throw uploadError;
    const { data, error } = await requireClient().rpc("complete_assigned_work", {
        target_complaint_id: complaintId,
        requested_path: uploaded.path,
        requested_mime_type: file.type.toLowerCase()
    });
    if (error) {
        try { await bucket.remove([uploaded.path]); } catch { /* Keep the database error. */ }
        throw error;
    }
    return Array.isArray(data) ? data[0] : data;
}

export async function createPrivateEvidenceUrl(path) {
    const { data, error } = await requireClient().storage
        .from(PRIVATE_EVIDENCE_BUCKET)
        .createSignedUrl(path, 60 * 60);
    if (error) throw error;
    return data.signedUrl;
}

export async function listProfilesForManagement() {
    const { data, error } = await requireClient()
        .from("profiles")
        .select("id, full_name, email, college_id, branch, role, requested_role, phone, work_category, id_card_path, id_card_mime_type, created_at")
        .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
}

export async function setProfileRole(userId, role) {
    const { data, error } = await requireClient().rpc("set_account_access", {
        target_user_id: userId,
        requested_access: role
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
}

export async function assignComplaint(complaintId, employeeId) {
    const { data, error } = await requireClient().rpc("assign_complaint", {
        target_complaint_id: complaintId,
        target_employee_id: employeeId
    });
    if (error) throw error;
    const assigned = Array.isArray(data) ? data[0] : data;
    const { error: notificationError } = await requireClient().functions.invoke("notify-assignment", {
        body: { complaintId }
    });
    return { assignment: assigned, notificationError };
}
