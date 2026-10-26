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
        .select("id, ticket_number, user_id, category, title, location, description, status, admin_note, handled_by, created_at, updated_at", { count: "exact" })
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