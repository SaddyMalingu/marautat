#!/usr/bin/env node
/**
 * re_engage_all_contacts.js
 * Sends a warm re-engagement message to every number that has ever texted the bot.
 * Uses the existing /tenant/broadcast API on the live Render deployment.
 *
 * Usage:
 *   node re_engage_all_contacts.js
 *
 * Required env vars (set locally or in a .env file):
 *   SB_URL                — Supabase project URL
 *   SB_SERVICE_ROLE_KEY   — Supabase service-role key
 *   TENANT_DASHBOARD_PASS or ADMIN_PASS — tenant session key
 *   DEPLOY_BASE_URL       — optional, defaults to https://alphadome.onrender.com
 */
import dotenv from "dotenv";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const BASE_URL = process.env.DEPLOY_BASE_URL || "https://alphadome.onrender.com";
const SB_URL = process.env.SB_URL || process.env.SUPABASE_URL;
const SB_KEY = process.env.SB_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error("❌ Missing SB_URL / SB_SERVICE_ROLE_KEY. Add them to your local .env and retry.");
  process.exit(1);
}

const supabase = createClient(SB_URL, SB_KEY);

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("254") && digits.length >= 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits.length >= 10 ? digits : null;
}

function buildMessage() {
  return [
    "👋 Hi, this is Alphadome.",
    "",
    "You've chatted with us before — thank you for that.",
    "",
    "We're reaching out because we're now helping businesses set up practical AI workflows fast, starting with WhatsApp automation, lead follow-up, and M-Pesa-ready sales flows.",
    "",
    "No pressure. But if you're open to it, just reply with:",
    "- Your business or profession",
    "- One challenge that's slowing you down right now",
    "",
    "We'll come back with a quick, tailored workflow idea you can start using immediately. 🚀",
    "",
    "Or call/WhatsApp David directly: +254743780542",
    "Website: https://alphadome.onrender.com",
  ].join("\n");
}

async function findEligibleTenant() {
  const { data, error } = await supabase
    .from("bot_tenants")
    .select("client_name, client_phone, whatsapp_phone_number_id")
    .limit(50);

  if (error) throw new Error(`bot_tenants lookup failed: ${error.message}`);

  const ALPHADOME_MAIN = "254786817637";
  const candidate = (data || []).find((row) => {
    const phone = normalizePhone(row.client_phone);
    return phone && !phone.includes("kassangas") && phone !== ALPHADOME_MAIN;
  });

  if (!candidate) {
    // Fall back to using the Alphadome main number itself
    return { client_name: "Alphadome", client_phone: ALPHADOME_MAIN, normalized_phone: ALPHADOME_MAIN };
  }

  return { ...candidate, normalized_phone: normalizePhone(candidate.client_phone) };
}

async function loginTenant(tenantPhone) {
  const keyCandidates = [process.env.TENANT_DASHBOARD_PASS, process.env.ADMIN_PASS].filter(Boolean);
  if (!keyCandidates.length) throw new Error("No TENANT_DASHBOARD_PASS or ADMIN_PASS set in env.");

  for (const key of keyCandidates) {
    try {
      const resp = await axios.post(`${BASE_URL}/tenant/session/login`, { tenant_phone: tenantPhone, key }, { timeout: 20000 });
      if (resp.data?.token) return resp.data;
    } catch (err) {
      const detail = err?.response?.data?.error || err.message;
      console.log(`  Login attempt: ${detail}`);
    }
  }
  throw new Error("Could not create tenant session with available keys.");
}

async function main() {
  console.log("=== Alphadome Re-engagement Broadcast ===\n");

  const tenant = await findEligibleTenant();
  console.log(`Tenant: ${tenant.client_name} (${tenant.normalized_phone})`);

  const session = await loginTenant(tenant.normalized_phone);
  console.log(`Session token acquired. Expires: ${session.expires_at}\n`);

  // Check audience (all time window = 2 years)
  const audience = await axios.get(`${BASE_URL}/tenant/broadcast/audience`, {
    params: { window_hours: 17520, segment: "all" },
    headers: { "x-tenant-session": session.token },
    timeout: 15000,
  });

  const count = audience.data?.count || 0;
  console.log(`Audience: ${count} contacts reachable`);

  if (count === 0) {
    console.log("\n⚠️  No contacts found in the broadcast audience.");
    console.log("  This means the conversations table may not have user_id links yet.");
    console.log("  Alternative: use run_live_broadcast.js or send manually via WhatsApp dashboard.");
    return;
  }

  console.log(`\n📤 Sending re-engagement message to ${count} contacts...`);
  const message = buildMessage();
  console.log("\n--- Message preview ---");
  console.log(message);
  console.log("--- end preview ---\n");

  const result = await axios.post(`${BASE_URL}/tenant/broadcast`, {
    message,
    window_hours: 17520,
    segment: "all",
  }, {
    headers: { "x-tenant-session": session.token, "Content-Type": "application/json" },
    timeout: 120000,
  });

  console.log("\n✅ Broadcast complete:");
  console.log(JSON.stringify(result.data, null, 2));

  // Logout
  await axios.post(`${BASE_URL}/tenant/session/logout`, {}, {
    headers: { "x-tenant-session": session.token },
    timeout: 10000,
  }).catch(() => {});
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
