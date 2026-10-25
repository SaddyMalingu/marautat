// Discovery → tenant approval helpers.
//
// The public questionnaire (public/client-discovery-form.html → POST /discovery)
// used to end at "we'll be in touch". These helpers turn one submission into a
// tenant the owner can approve from /admin, plus a portal link that signs that
// client straight into /tenant-dashboard (Writer's Flow).
//
// Kept free of Express/Supabase so scripts/test_discovery_approvals.mjs can test
// the rules (phone normalisation, invite links, queue merging) without a server
// or a database.
import crypto from "crypto";

const KE_MOBILE = /^2547\d{8}$/;

/**
 * Normalise any Kenyan mobile spelling to 2547XXXXXXXX.
 * "0712 345 678", "+254 712 345 678", "712345678" → "254712345678".
 * Returns "" when there is nothing usable.
 */
export function normalizeKePhone(raw = "") {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("254")) return digits.slice(0, 12);
  if (digits.startsWith("0")) return `254${digits.slice(1, 10)}`;
  if (digits.length === 9 && digits.startsWith("7")) return `254${digits}`;
  if (digits.length === 10 && digits.startsWith("7")) return `254${digits}`;
  return digits;
}

export function isValidKeMobile(phone = "") {
  return KE_MOBILE.test(String(phone || ""));
}

/** Stable, human-readable id for a submission that could not reach the DB. */
export function newSubmissionId(now = Date.now(), random = Math.random) {
  const stamp = Number(now).toString(36).toUpperCase();
  const suffix = String(random()).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `DSC-${stamp}-${suffix}`;
}

/** Per-tenant portal credential. 192 bits, hex, safe in a WhatsApp message. */
export function newPortalToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function trimBase(baseUrl = "") {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

/**
 * Invite link. `t` is the tenant's portal token; `phone` lets the portal sign the
 * client in on first open, so they never have to copy a password from WhatsApp.
 */
export function buildPortalUrl(baseUrl, { token, phone } = {}) {
  const t = String(token || "").trim();
  if (!t) throw new Error("token is required");
  const query = new URLSearchParams({ t });
  const normalisedPhone = normalizeKePhone(phone);
  if (normalisedPhone) query.set("phone", normalisedPhone);
  const base = trimBase(baseUrl);
  if (!base) return `/tenant-dashboard?${query.toString()}`;
  return `${base}/tenant-dashboard?${query.toString()}`;
}

export function buildInviteMessage({ contactName = "", businessName = "", portalUrl = "" } = {}) {
  const who = String(contactName || "").trim().split(/\s+/)[0];
  const business = String(businessName || "").trim();
  const hello = who ? `Hi ${who}` : "Hello";
  const forLine = business ? ` for ${business}` : "";
  return [
    `${hello}, your Alphadome workspace${forLine} is approved.`,
    "",
    "Open your tenant portal (this link signs you in — no password to copy):",
    portalUrl,
    "",
    "Inside, open Writer's Flow:",
    "• Blogger — create an offer and generate its pages",
    "• Research & Outreach — run a campaign and see the leads it finds",
    "",
    "The link is personal to your business number. Reply here if it does not open.",
  ].join("\n");
}

export function buildWhatsAppInviteLink({ phone, message } = {}) {
  const to = normalizeKePhone(phone);
  if (!to) throw new Error("phone is required");
  return `https://wa.me/${to}?text=${encodeURIComponent(String(message || ""))}`;
}

/** Tolerant read of the append-only fallback log (one JSON object per line). */
export function parseSubmissionLog(content = "") {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * One shape for both storage paths: the DB row, a fallback-log record (which
 * nests the questionnaire under `payload`), and an approval event appended to
 * the same log.
 */
export function normalizeSubmission(record = {}, index = 0) {
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : record;
  const rawId = String(record?.id || record?.submission_id || payload?.submission_id || "").trim();
  const phone = normalizeKePhone(payload?.phone || record?.phone || "");
  const submittedAt =
    record?.submitted_at || record?.approved_at || record?.at || record?.created_at || new Date(0).toISOString();
  const list = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
    const text = String(value ?? "").trim();
    return text ? [text] : [];
  };
  return {
    id: rawId || `legacy-${phone || "unknown"}-${index}`,
    legacy: !rawId,
    status: String(record?.status || payload?.status || "new").trim().toLowerCase(),
    contact_name: String(payload?.name || record?.contact_name || "").trim(),
    business_name: String(payload?.business_name || record?.business_name || "").trim(),
    email: String(payload?.email || record?.email || "").trim().toLowerCase(),
    phone: phone || String(payload?.phone || record?.phone || "").trim(),
    industry: String(payload?.industry || record?.industry || "").trim(),
    business_description: String(payload?.business_description || "").trim(),
    team_size: String(payload?.team_size || record?.team_size || "").trim(),
    budget: String(payload?.budget || record?.budget || "").trim(),
    timeline: String(payload?.timeline || record?.timeline || "").trim(),
    revenue_target: String(payload?.revenue_target || record?.revenue_target || "").trim(),
    whatsapp_usage: String(payload?.whatsapp_usage || record?.whatsapp_usage || "").trim(),
    ownership_interest: String(payload?.ownership_interest || record?.ownership_interest || "").trim(),
    source: String(payload?.source || record?.source || "").trim(),
    challenges: list(payload?.challenges),
    capabilities: list(payload?.capabilities),
    notes: String(payload?.additional_notes || payload?.blockers || record?.notes || "").trim(),
    submitted_at: submittedAt,
    tenant_id: record?.tenant_id || null,
    portal_token: record?.portal_token || null,
    portal_url: record?.portal_url || null,
    approved_at: record?.approved_at || null,
    approved_by: record?.approved_by || null,
    rejected_at: record?.rejected_at || null,
    rejection_reason: record?.rejection_reason || null,
  };
}

function recordTime(record) {
  const stamp = record.approved_at || record.rejected_at || record.submitted_at;
  const time = Date.parse(stamp || "");
  return Number.isFinite(time) ? time : 0;
}

function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * Layer `extra` over `base`, but never let a blank field erase a known value.
 * Approval and reject events carry only a short payload, so a plain spread would
 * wipe the business name, phone and email the questionnaire captured.
 */
function overlay(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (isBlank(value) && !isBlank(out[key])) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Merge the Supabase rows with the fallback log.
 *
 * The log is append-only, so it holds both the original submission and any later
 * approval event. An approval always wins over a `new` row, and a stored portal
 * link survives a refresh (otherwise the owner would have to re-issue it every
 * time the page reloads).
 */
export function mergeSubmissions(dbRows = [], logRows = []) {
  const byId = new Map();
  const put = (record, index) => {
    const next = normalizeSubmission(record, index);
    const previous = byId.get(next.id);
    if (!previous) {
      byId.set(next.id, next);
      return;
    }
    if (next.status === "approved" && previous.status !== "approved") {
      byId.set(next.id, overlay(previous, next));
      return;
    }
    if (recordTime(next) >= recordTime(previous)) {
      const status = previous.status === "approved" && next.status === "new" ? "approved" : next.status;
      byId.set(next.id, { ...overlay(previous, next), status });
      return;
    }
    byId.set(next.id, overlay(next, previous));
  };

  (Array.isArray(dbRows) ? dbRows : []).forEach(put);
  (Array.isArray(logRows) ? logRows : []).forEach(put);

  return [...byId.values()].sort((a, b) => recordTime(b) - recordTime(a));
}

export function findSubmission(list = [], id = "", phone = "") {
  const wantedId = String(id || "").trim();
  const wantedPhone = normalizeKePhone(phone);
  if (wantedId) {
    const byId = list.find((row) => row.id === wantedId);
    if (byId) return byId;
  }
  if (wantedPhone) {
    return list.find((row) => normalizeKePhone(row.phone) === wantedPhone) || null;
  }
  return null;
}


