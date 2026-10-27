import {
    attachComplaintProof,
    createComplaint,
    createComplaintProofUrl,
    getProfile,
    isSupabaseConfigured,
    loadComplaints,
    listProfilesForOwner,
    setProfileRole,
    registerStudent,
    requestPasswordReset,
    signIn,
    signOut,
    supabase,
    updateComplaint,
    updatePassword,
    validateComplaintProof
} from "./app.js";

const PAGE_SIZE = 10;
let selectedProofFile = null;
let selectedProofPreviewUrl = "";
let proofCameraStream = null;
let proofRecorder = null;
let proofRecordingChunks = [];
const state = {
    user: null,
    profile: null,
    profileError: null,
    selectedPortal: null,
    view: "signin",
    studentPage: 0,
    managementPage: 0,
    studentTicket: "",
    managementFilters: { ticketNumber: "", status: "", category: "" }
};

const byId = (id) => document.getElementById(id);
const portalPanel = byId("portal-panel");
const portalMessage = byId("portal-message");
const actionMessage = byId("action-message");
const authArea = byId("auth-area");
const dashboard = byId("dashboard");
const sessionError = byId("session-error");
const roleMismatch = byId("role-mismatch");

function setMessage(message, kind = "info") {
    actionMessage.textContent = message;
    actionMessage.dataset.kind = kind;
}

function setPortalMessage(message = "") {
    portalMessage.textContent = message;
}

function setBusy(form, busy, busyLabel = "Working…") {
    const button = form.querySelector('button[type="submit"]');
    if (!button) return;
    if (busy) {
        button.dataset.originalLabel = button.textContent;
        button.textContent = busyLabel;
        button.disabled = true;
    } else {
        button.textContent = button.dataset.originalLabel || button.textContent;
        button.disabled = false;
        delete button.dataset.originalLabel;
    }
}

function formatError(error) {
    const message = String(error?.message || "Something went wrong.");
    if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
    if (/email not confirmed/i.test(message)) return "Please verify your email from the link we sent before signing in.";
    if (/user already registered/i.test(message)) return "An account already exists for this email. Sign in instead.";
    if (/password.*(weak|short|characters)/i.test(message)) return "Choose a stronger password with at least 10 characters.";
    if (/failed to fetch|network/i.test(message)) return "Could not reach Supabase. Check the project URL, key, and internet connection.";
    return message;
}

function showPortal(portal) {
    state.selectedPortal = portal;
    state.view = "signin";
    portalPanel.hidden = false;
    setPortalMessage("");
    setMessage("");
    byId("portal-title").textContent = portal === "student" ? "Student Portal" : "Management Portal";
    byId("portal-kicker").textContent = portal === "student" ? "Student access" : "Management access";

    if (state.user && state.profile) {
        renderSession();
    } else if (state.user) {
        showSessionError(state.profileError || new Error("The profile record is not available."));
    } else {
        showAuth();
    }
    portalPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setAuthView(view) {
    state.view = view;
    byId("signin-form").hidden = view !== "signin";
    byId("signup-form").hidden = view !== "signup";
    byId("reset-form").hidden = view !== "reset";
    byId("update-password-form").hidden = view !== "update";
    byId("show-signup").hidden = view !== "signin" || state.selectedPortal !== "student";
    byId("forgot-password").hidden = view !== "signin";
    byId("show-signin").hidden = view === "signin";
    if (view === "signin") {
        byId("auth-intro").textContent = state.selectedPortal === "student"
            ? "Sign in to submit complaints and track your reports."
            : "Sign in with an account approved for the management portal.";
    } else if (view === "signup") {
        byId("auth-intro").textContent = "Create an account. The owner reviews it before portal access is enabled.";
    } else if (view === "reset") {
        byId("auth-intro").textContent = "Request a secure password reset link.";
    } else {
        byId("auth-intro").textContent = "Set a new password for your account.";
    }
}

function showAuth() {
    dashboard.hidden = true;
    sessionError.hidden = true;
    roleMismatch.hidden = true;
    byId("approval-pending").hidden = true;
    authArea.hidden = false;
    setAuthView(state.view || "signin");
}

function showSessionError(error) {
    state.profile = null;
    state.profileError = error;
    authArea.hidden = true;
    dashboard.hidden = true;
    roleMismatch.hidden = true;
    byId("approval-pending").hidden = true;
    sessionError.hidden = false;
    byId("session-error-text").textContent =
        "We could not load your account profile. Check that the Supabase migration is installed and your account setup completed. " +
        formatError(error);
}

function roleForProfile(profile) {
    if (profile.role === "admin" || profile.role === "owner") return "admin";
    if (profile.role === "student") return "student";
    return "pending";
}

function renderSession() {
    if (!state.user || !state.profile) return;
    const actualPortal = roleForProfile(state.profile);
    state.selectedPortal = actualPortal;

    if (actualPortal === "pending") {
        authArea.hidden = true;
        dashboard.hidden = true;
        sessionError.hidden = true;
        roleMismatch.hidden = true;
        byId("approval-pending").hidden = false;
        byId("portal-title").textContent = "Account pending approval";
        byId("portal-kicker").textContent = "Awaiting owner review";
        return;
    }
    byId("approval-pending").hidden = true;
    sessionError.hidden = true;
    roleMismatch.hidden = true;
    authArea.hidden = true;
    dashboard.hidden = false;
    byId("portal-title").textContent = actualPortal === "admin" ? "Management Portal" : "Student Portal";
    byId("portal-kicker").textContent = actualPortal === "admin" ? "Management access" : "Student access";
    byId("dashboard-kicker").textContent = actualPortal === "admin" ? "Management dashboard" : "Student dashboard";
    byId("dashboard-welcome").textContent = "Welcome, " + (state.profile.full_name || "Campus user");
    byId("dashboard-email").textContent = state.user.email || "";
    byId("student-tools").hidden = actualPortal !== "student";
    byId("management-tools").hidden = actualPortal !== "admin";
    byId("owner-tools").hidden = state.profile.role !== "owner";
    setMessage("");

    if (actualPortal === "admin") {
        loadAndRenderComplaints("management");
        if (state.profile.role === "owner") loadAndRenderAccounts();
    } else {
        loadAndRenderComplaints("student");
    }
}

async function applySession(session) {
    state.user = session?.user ?? null;
    state.profile = null;
    state.profileError = null;

    if (!state.user) {
        dashboard.hidden = true;
        roleMismatch.hidden = true;
        sessionError.hidden = true;
        if (state.selectedPortal) showAuth();
        return;
    }

    try {
        state.profile = await getProfile(state.user.id);
        if (!state.selectedPortal) {
            state.selectedPortal = roleForProfile(state.profile);
            portalPanel.hidden = false;
        }
        renderSession();
    } catch (error) {
        showSessionError(error);
    }
}

function parseTicketNumber(value) {
    const cleaned = value.trim().replace(/^CC-/i, "");
    if (!cleaned) return "";
    if (!/^\d{1,18}$/.test(cleaned) || Number(cleaned) < 1 || !Number.isSafeInteger(Number(cleaned))) {
        throw new Error("Enter a valid complaint ID such as CC-100001.");
    }
    return cleaned;
}

function statusLabel(status) {
    return ({
        submitted: "Submitted",
        in_progress: "In progress",
        resolved: "Resolved",
        rejected: "Rejected"
    })[status] || status;
}

function categoryLabel(category) {
    return category.charAt(0).toUpperCase() + category.slice(1);
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(date);
}

function appendText(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
}

function clearProofSelection() {
    selectedProofFile = null;
    if (selectedProofPreviewUrl) URL.revokeObjectURL(selectedProofPreviewUrl);
    selectedProofPreviewUrl = "";
    byId("complaint-file-input").value = "";
    byId("complaint-proof-preview").replaceChildren();
    byId("complaint-proof-preview").hidden = true;
}

function closeProofCamera() {
    if (proofRecorder?.state === "recording") {
        proofRecorder.ondataavailable = null;
        proofRecorder.onstop = null;
        proofRecorder.stop();
    }
    proofRecorder = null;
    proofRecordingChunks = [];
    if (proofCameraStream) {
        proofCameraStream.getTracks().forEach((track) => track.stop());
        proofCameraStream = null;
    }
    byId("proof-camera-preview").srcObject = null;
    byId("proof-camera-modal").hidden = true;
    byId("proof-start-video").hidden = false;
    byId("proof-stop-video").hidden = true;
}

async function openProofCamera() {
    const modal = byId("proof-camera-modal");
    const status = byId("proof-camera-status");
    const startVideo = byId("proof-start-video");
    modal.hidden = false;
    status.textContent = "Starting camera…";
    startVideo.disabled = !window.MediaRecorder;
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not available in this browser.");
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });
        if (modal.hidden) {
            stream.getTracks().forEach((track) => track.stop());
            return;
        }
        proofCameraStream = stream;
        byId("proof-camera-preview").srcObject = proofCameraStream;
        status.textContent = "Take a photo or record a short video.";
        byId("proof-take-photo").focus();
    } catch (error) {
        if (modal.hidden) return;
        closeProofCamera();
        setMessage("Could not open the camera. Choose a saved photo/video instead. " + formatError(error), "error");
    }
}

function startProofRecording() {
    if (!proofCameraStream || !window.MediaRecorder) {
        setMessage("Video recording is not supported by this browser.", "error");
        return;
    }
    const supportedTypes = typeof MediaRecorder.isTypeSupported === "function"
        ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
        : [];
    const mimeType = supportedTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    proofRecorder = mimeType
        ? new MediaRecorder(proofCameraStream, { mimeType })
        : new MediaRecorder(proofCameraStream);
    proofRecordingChunks = [];
    proofRecorder.ondataavailable = (event) => {
        if (!event.data?.size) return;
        proofRecordingChunks.push(event.data);
        const totalBytes = proofRecordingChunks.reduce((total, chunk) => total + chunk.size, 0);
        if (totalBytes >= MAX_PROOF_BYTES && proofRecorder?.state === "recording") {
            byId("proof-camera-status").textContent = "Size limit reached. Finishing video…";
            proofRecorder.stop();
        }
    };
    proofRecorder.onstop = () => {
        const recordedType = proofRecorder?.mimeType || proofRecordingChunks[0]?.type || "video/webm";
        const type = recordedType.split(";")[0].toLowerCase();
        const extension = type.includes("mp4") ? "mp4" : "webm";
        const file = new File(proofRecordingChunks, "camera-proof-" + Date.now() + "." + extension, { type });
        proofRecorder = null;
        proofRecordingChunks = [];
        closeProofCamera();
        selectProofFile(file);
    };
    proofRecorder.start(1000);
    byId("proof-start-video").hidden = true;
    byId("proof-stop-video").hidden = false;
    byId("proof-camera-status").textContent = "Recording video…";
}

function captureProofPhoto() {
    const video = byId("proof-camera-preview");
    if (!video.videoWidth || !video.videoHeight) {
        setMessage("Camera is still starting. Try again in a moment.", "error");
        return;
    }
    const canvas = byId("proof-camera-canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
        if (!blob) {
            setMessage("Could not capture the photo. Try again.", "error");
            return;
        }
        const file = new File([blob], "camera-proof-" + Date.now() + ".jpg", { type: "image/jpeg" });
        closeProofCamera();
        selectProofFile(file);
    }, "image/jpeg", 0.9);
}

function selectProofFile(file) {
    clearProofSelection();
    if (!file) return;
    try {
        validateComplaintProof(file);
    } catch (error) {
        setMessage(error.message, "error");
        return;
    }

    selectedProofFile = file;
    selectedProofPreviewUrl = URL.createObjectURL(file);
    const preview = byId("complaint-proof-preview");
    if (file.type.startsWith("image/")) {
        const image = document.createElement("img");
        image.src = selectedProofPreviewUrl;
        image.alt = "Selected complaint proof";
        preview.append(image);
    } else {
        const video = document.createElement("video");
        video.src = selectedProofPreviewUrl;
        video.controls = true;
        video.preload = "metadata";
        video.playsInline = true;
        preview.append(video);
    }
    appendText(preview, "p", "field-hint", file.name + " · " + (file.size / (1024 * 1024)).toFixed(1) + " MB");
    preview.hidden = false;
    setMessage("");
}

async function renderComplaintProof(row, container) {
    try {
        const url = await createComplaintProofUrl(row.proof_path);
        container.replaceChildren();
        if (row.proof_mime_type?.startsWith("image/")) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = "Complaint proof";
            container.append(image);
        } else if (row.proof_mime_type?.startsWith("video/")) {
            const video = document.createElement("video");
            video.src = url;
            video.controls = true;
            video.preload = "metadata";
            video.playsInline = true;
            container.append(video);
        }
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Open proof in a new tab";
        container.append(link);
    } catch (error) {
        container.textContent = "Could not load the attached proof. " + formatError(error);
    }
}

function makeProofRetryForm(row) {
    const form = document.createElement("form");
    form.className = "proof-upload-form";
    const label = document.createElement("label");
    label.textContent = "Add a photo/video proof";
    const input = document.createElement("input");
    input.type = "file";
    input.name = "proof";
    input.accept = "image/*,video/*";
    input.capture = "environment";
    input.required = true;
    label.append(input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "secondary-button";
    submit.textContent = "Upload proof";
    form.append(label, submit);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const file = input.files?.[0];
        try {
            validateComplaintProof(file);
            setBusy(form, true, "Uploading…");
            await attachComplaintProof({ complaintId: row.id, userId: state.user.id, file });
            setMessage("Proof attached to CC-" + String(row.ticket_number).padStart(6, "0"), "success");
            await loadAndRenderComplaints("student");
        } catch (error) {
            setMessage(formatError(error), "error");
        } finally {
            setBusy(form, false);
        }
    });
    return form;
}

function makeComplaintCard(row, management = false) {
    const card = document.createElement("article");
    card.className = "complaint-card";

    const heading = document.createElement("div");
    heading.className = "complaint-heading";
    const titleBlock = document.createElement("div");
    appendText(titleBlock, "h5", "", row.title);
    const badge = appendText(titleBlock, "span", "status-badge", statusLabel(row.status));
    badge.dataset.status = row.status;
    appendText(heading, "span", "ticket-id", "CC-" + String(row.ticket_number).padStart(6, "0"));
    heading.prepend(titleBlock);
    card.append(heading);

    const details = document.createElement("div");
    details.className = "complaint-details";
    appendText(details, "p", "", "Category: " + categoryLabel(row.category));
    appendText(details, "p", "", "Location: " + row.location);
    appendText(details, "p", "", "Submitted: " + formatDate(row.created_at));
    appendText(details, "p", "", "Updated: " + formatDate(row.updated_at));
    appendText(details, "p", "complaint-description", row.description);
    if (row.admin_note) appendText(details, "p", "management-note", "Management update: " + row.admin_note);
    if (row.proof_path) {
        const proof = document.createElement("div");
        proof.className = "complaint-proof";
        appendText(proof, "p", "muted", "Loading attached proof…");
        details.append(proof);
        void renderComplaintProof(row, proof);
    } else if (!management && ["submitted", "in_progress"].includes(row.status)) {
        details.append(makeProofRetryForm(row));
    }
    card.append(details);

    if (management) {
        const form = document.createElement("form");
        form.className = "admin-update-form";
        form.dataset.complaintId = row.id;

        const statusLabelElement = document.createElement("label");
        statusLabelElement.append(document.createTextNode("Status"));
        const statusSelect = document.createElement("select");
        statusSelect.name = "status";
        const statuses = {
            submitted: "Submitted",
            in_progress: "In progress",
            resolved: "Resolved",
            rejected: "Rejected"
        };
        for (const [value, label] of Object.entries(statuses)) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            option.selected = value === row.status;
            statusSelect.append(option);
        }
        statusLabelElement.append(statusSelect);

        const noteLabel = document.createElement("label");
        noteLabel.append(document.createTextNode("Management note"));
        const noteInput = document.createElement("input");
        noteInput.type = "text";
        noteInput.name = "admin_note";
        noteInput.maxLength = 3000;
        noteInput.value = row.admin_note || "";
        noteInput.placeholder = "Optional update for the student";
        noteLabel.append(noteInput);

        const save = document.createElement("button");
        save.type = "submit";
        save.className = "secondary-button";
        save.textContent = "Save update";
        form.append(statusLabelElement, noteLabel, save);
        card.append(form);
    }

    return card;
}

async function loadAndRenderComplaints(audience) {
    const isManagement = audience === "management";
    const container = byId(isManagement ? "management-list" : "student-list");
    const page = isManagement ? state.managementPage : state.studentPage;
    const filters = isManagement
        ? state.managementFilters
        : { ticketNumber: state.studentTicket, status: "", category: "" };
    const pagination = byId(isManagement ? "management-pagination" : "student-pagination");

    container.replaceChildren();
    const loading = appendText(container, "p", "empty-state", "Loading complaints…");
    pagination.hidden = true;

    try {
        const result = await loadComplaints({
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
            ownerId: isManagement ? "" : state.user.id,
            ...filters
        });
        loading.remove();

        if (!result.rows.length) {
            appendText(container, "p", "empty-state", "No complaints found.");
        } else {
            const fragment = document.createDocumentFragment();
            for (const row of result.rows) fragment.append(makeComplaintCard(row, isManagement));
            container.append(fragment);
        }

        const pageCount = Math.max(1, Math.ceil(result.count / PAGE_SIZE));
        const start = result.count === 0 ? 0 : page * PAGE_SIZE + 1;
        const end = Math.min((page + 1) * PAGE_SIZE, result.count);
        byId(isManagement ? "management-page-label" : "student-page-label").textContent =
            "Showing " + start + "–" + end + " of " + result.count;
        pagination.hidden = result.count <= PAGE_SIZE;
        byId(isManagement ? "management-prev" : "student-prev").disabled = page <= 0;
        byId(isManagement ? "management-next" : "student-next").disabled = page + 1 >= pageCount;
    } catch (error) {
        loading.remove();
        appendText(container, "p", "empty-state", "Could not load complaints. " + formatError(error));
    }
}

async function loadAndRenderAccounts() {
    const container = byId("owner-account-list");
    const loading = appendText(container, "p", "empty-state", "Loading accounts…");
    container.replaceChildren(loading);

    try {
        const profiles = await listProfilesForOwner();
        loading.remove();
        const adminCount = profiles.filter((profile) => profile.role === "admin").length;
        byId("owner-admin-count").textContent = "Active admins: " + adminCount;
        byId("owner-pending-count").textContent = "Waiting for approval: " + profiles.filter((profile) => profile.role === "pending").length;

        if (!profiles.length) {
            appendText(container, "p", "empty-state", "No accounts found.");
            return;
        }

        for (const profile of profiles) {
            const card = document.createElement("article");
            card.className = "complaint-card owner-account-card";
            appendText(card, "h5", "", profile.full_name || "Campus user");
            appendText(card, "p", "muted", profile.email || "Email unavailable");
            if (profile.college_id) appendText(card, "p", "muted", "College ID / roll number: " + profile.college_id);

            if (profile.role === "owner") {
                appendText(card, "p", "status-badge", "Owner — your account");
                container.append(card);
                continue;
            }

            const form = document.createElement("form");
            form.className = "owner-role-form";
            form.dataset.userId = profile.id;
            const label = document.createElement("label");
            label.append(document.createTextNode("Access"));
            const select = document.createElement("select");
            select.name = "role";
            for (const [value, text] of [["pending", "Pending approval"], ["student", "Student"], ["admin", "Admin"]]) {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                option.selected = profile.role === value;
                select.append(option);
            }
            label.append(select);
            const save = document.createElement("button");
            save.type = "submit";
            save.className = "secondary-button";
            save.textContent = "Save access";
            form.append(label, save);
            card.append(form);
            container.append(card);
        }
    } catch (error) {
        loading.remove();
        byId("owner-admin-count").textContent = "";
        appendText(container, "p", "empty-state", "Could not load accounts. " + formatError(error));
    }
}
async function handleAuthSubmit(form, action, busyLabel) {
    setBusy(form, true, busyLabel);
    setMessage("");
    try {
        await action();
    } catch (error) {
        setMessage(formatError(error), "error");
    } finally {
        setBusy(form, false);
    }
}

for (const button of document.querySelectorAll("[data-portal]")) {
    button.addEventListener("click", () => showPortal(button.dataset.portal));
}

byId("portal-back").addEventListener("click", () => {
    portalPanel.hidden = true;
    setPortalMessage("");
    setMessage("");
});

byId("show-signup").addEventListener("click", () => {
    setMessage("");
    setAuthView("signup");
});
byId("show-signin").addEventListener("click", () => {
    setMessage("");
    setAuthView("signin");
});
byId("forgot-password").addEventListener("click", () => {
    byId("reset-email").value = byId("signin-email").value;
    setMessage("");
    setAuthView("reset");
});
byId("open-correct-portal").addEventListener("click", () => {
    state.selectedPortal = roleForProfile(state.profile);
    setMessage("");
    renderSession();
});
byId("session-error-logout").addEventListener("click", async () => {
    try {
        const { error } = await signOut();
        if (error) throw error;
        state.user = null;
        state.profile = null;
        showAuth();
    } catch (error) {
        setMessage(formatError(error), "error");
    }
});

byId("signin-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = values.get("email").trim();
    const password = values.get("password");
    handleAuthSubmit(form, async () => {
        const { data, error } = await signIn(email, password);
        if (error) throw error;
        await applySession(data.session);
        if (data.session) setMessage("Signed in successfully.", "success");
    }, "Signing in…");
});

byId("signup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = values.get("email").trim();
    const password = values.get("password");
    const fullName = values.get("full_name").trim();
    const collegeId = values.get("college_id").trim();
    handleAuthSubmit(form, async () => {
        const { data, error } = await registerStudent(email, password, fullName, collegeId);
        if (error) throw error;
        if (data.session) {
            await applySession(data.session);
            setMessage(state.profile?.role === "pending" ? "Account created. Waiting for owner approval." : "Your account is ready. You are signed in.", "success");
        } else {
            setMessage("Account created. Verify your email, then wait for the owner to approve access.", "success");
            setAuthView("signin");
            byId("signin-email").value = email;
        }
    }, "Creating account…");
});

byId("reset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get("email").trim();
    handleAuthSubmit(form, async () => {
        const { error } = await requestPasswordReset(email);
        if (error) throw error;
        setMessage("If an account uses that address, a password reset link has been sent.", "success");
    }, "Sending…");
});

byId("update-password-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = new FormData(form).get("password");
    handleAuthSubmit(form, async () => {
        const { error } = await updatePassword(password);
        if (error) throw error;
        const { error: signOutError } = await supabase.auth.signOut();
        if (signOutError) throw signOutError;
        state.user = null;
        state.profile = null;
        state.selectedPortal = "student";
        setAuthView("signin");
        setMessage("Password updated. Sign in with your new password.", "success");
    }, "Updating…");
});

byId("approval-pending-signout").addEventListener("click", async () => {
    try {
        const { error } = await signOut();
        if (error) throw error;
        state.user = null;
        state.profile = null;
        setMessage("You have signed out.", "success");
        showAuth();
    } catch (error) {
        setMessage(formatError(error), "error");
    }
});
byId("signout-button").addEventListener("click", async () => {
    clearProofSelection();
    try {
        const { error } = await signOut();
        if (error) throw error;
        state.user = null;
        state.profile = null;
        setMessage("You have signed out.", "success");
        showAuth();
    } catch (error) {
        setMessage(formatError(error), "error");
    }
});

byId("complaint-camera-button").addEventListener("click", openProofCamera);
byId("complaint-file-button").addEventListener("click", () => byId("complaint-file-input").click());
byId("complaint-file-input").addEventListener("change", (event) => selectProofFile(event.currentTarget.files?.[0]));
byId("proof-camera-close").addEventListener("click", closeProofCamera);
byId("proof-take-photo").addEventListener("click", captureProofPhoto);
byId("proof-start-video").addEventListener("click", startProofRecording);
byId("proof-stop-video").addEventListener("click", () => {
    if (proofRecorder?.state === "recording") {
        byId("proof-camera-status").textContent = "Preparing video…";
        proofRecorder.stop();
    }
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("proof-camera-modal").hidden) closeProofCamera();
});

byId("complaint-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const complaint = {
        title: values.get("title").trim(),
        category: values.get("category"),
        location: values.get("location").trim(),
        description: values.get("description").trim()
    };
    const proofFile = selectedProofFile;
    try {
        validateComplaintProof(proofFile);
    } catch (error) {
        setMessage(error.message, "error");
        return;
    }
    handleAuthSubmit(form, async () => {
        const data = await createComplaint(complaint);
        const ticket = "CC-" + String(data.ticket_number).padStart(6, "0");
        if (proofFile) {
            try {
                await attachComplaintProof({ complaintId: data.id, userId: state.user.id, file: proofFile });
            } catch (error) {
                form.reset();
                clearProofSelection();
                state.studentPage = 0;
                await loadAndRenderComplaints("student");
                setMessage("Complaint " + ticket + " was saved, but its proof did not upload. Add proof from the complaint card and try again. " + formatError(error), "error");
                return;
            }
        }
        form.reset();
        clearProofSelection();
        state.studentPage = 0;
        setMessage("Complaint " + ticket + " submitted. Keep this ID to track it.", "success");
        await loadAndRenderComplaints("student");
    }, "Submitting…");
});

byId("student-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        state.studentTicket = parseTicketNumber(byId("student-ticket-filter").value);
        state.studentPage = 0;
        setMessage("");
        loadAndRenderComplaints("student");
    } catch (error) {
        setMessage(error.message, "error");
    }
});
byId("student-clear-filter").addEventListener("click", () => {
    byId("student-ticket-filter").value = "";
    state.studentTicket = "";
    state.studentPage = 0;
    loadAndRenderComplaints("student");
});
byId("management-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        state.managementFilters = {
            ticketNumber: parseTicketNumber(byId("management-ticket-filter").value),
            status: byId("management-status-filter").value,
            category: byId("management-category-filter").value
        };
        state.managementPage = 0;
        setMessage("");
        loadAndRenderComplaints("management");
    } catch (error) {
        setMessage(error.message, "error");
    }
});
byId("management-clear-filter").addEventListener("click", () => {
    byId("management-filter-form").reset();
    state.managementFilters = { ticketNumber: "", status: "", category: "" };
    state.managementPage = 0;
    loadAndRenderComplaints("management");
});

byId("student-prev").addEventListener("click", () => {
    state.studentPage = Math.max(0, state.studentPage - 1);
    loadAndRenderComplaints("student");
});
byId("student-next").addEventListener("click", () => {
    state.studentPage += 1;
    loadAndRenderComplaints("student");
});
byId("management-prev").addEventListener("click", () => {
    state.managementPage = Math.max(0, state.managementPage - 1);
    loadAndRenderComplaints("management");
});
byId("management-next").addEventListener("click", () => {
    state.managementPage += 1;
    loadAndRenderComplaints("management");
});

document.addEventListener("submit", (event) => {
    const form = event.target.closest(".admin-update-form");
    if (!form) return;
    event.preventDefault();
    const values = new FormData(form);
    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";
    setMessage("");
    updateComplaint({
        id: form.dataset.complaintId,
        status: values.get("status"),
        adminNote: values.get("admin_note").trim(),
        handlerId: state.user.id
    }).then(() => {
        setMessage("Complaint update saved.", "success");
        return loadAndRenderComplaints("management");
    }).catch((error) => {
        setMessage(formatError(error), "error");
    }).finally(() => {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
    });
});

document.addEventListener("submit", (event) => {
    const form = event.target.closest(".owner-role-form");
    if (!form) return;
    event.preventDefault();
    const role = new FormData(form).get("role");
    const button = form.querySelector('button[type="submit"]');
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Saving…";
    setMessage("");
    setProfileRole(form.dataset.userId, role).then(() => {
        setMessage("Account access updated.", "success");
        return loadAndRenderAccounts();
    }).catch((error) => {
        setMessage(formatError(error), "error");
    }).finally(() => {
        button.disabled = false;
        button.textContent = originalLabel;
    });
});
if (!isSupabaseConfigured) {
    setPortalMessage("Supabase setup is required before accounts and complaints can be used. See README.md.");
}

if (supabase) {
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === "PASSWORD_RECOVERY") {
            if (!state.selectedPortal) showPortal("student");
            setAuthView("update");
            showAuth();
            setMessage("Choose a new password to finish resetting your account.");
            return;
        }
        window.setTimeout(() => applySession(session), 0);
    });

    supabase.auth.getSession().then(({ data, error }) => {
        if (error) {
            setPortalMessage("Could not restore your session. " + formatError(error));
            return;
        }
        if (data.session) applySession(data.session);
    });
}
