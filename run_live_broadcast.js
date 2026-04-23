#!/usr/bin/env node
import dotenv from "dotenv";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const BASE_URL = process.env.DEPLOY_BASE_URL || "https://alphadome.onrender.com";
const SB_URL = process.env.SB_URL;
const SB_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
  console.error("Missing SB_URL or SB_SERVICE_ROLE_KEY in local env.");
  process.exit(1);
}

const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY);

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("254") && digits.length >= 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

function isExcludedTenant(row) {
  const txt = `${row?.client_name || ""} ${row?.point_of_contact_name || ""}`.toLowerCase();
  return txt.includes("kassangas") || txt.includes("gideon");
}

function buildCampaignMessage() {
  return [
    "Hi! This is Alphadome.",
    "",
    "We are helping businesses set up practical AI workflows, starting with WhatsApp automation.",
    "",
    "No pressure to buy, but if useful, reply with your profession/business and one challenge slowing you down right now.",
    "",
    "I can share a quick tailored workflow idea you can implement immediately.",
    "",
    "If it fits your goals, we can then help you start on Alphadome Basic and begin building your system.",
  ].join("\n");
}

async function getCandidateTenantPhone() {
  let data = [];
  {
    let resp = await supabase
      .from("bot_tenants")
      .select("client_name, point_of_contact_name, client_phone, status")
      .eq("status", "active")
      .limit(50);

    if (resp.error) {
      resp = await supabase
        .from("bot_tenants")
        .select("client_name, point_of_contact_name, client_phone")
        .limit(50);
    }

    if (resp.error) {
      resp = await supabase
        .from("bot_tenants")
        .select("client_name, client_phone")
        .limit(50);
    }

    if (resp.error) throw new Error(`bot_tenants lookup failed: ${resp.error.message}`);
    data = resp.data || [];
  }

  const candidate = (data || [])
    .filter((row) => !isExcludedTenant(row))
    .map((row) => ({ ...row, normalized_phone: normalizePhone(row.client_phone) }))
    .find((row) => row.normalized_phone);

  if (!candidate) throw new Error("No eligible active tenant found for live broadcast.");
  return candidate;
}

async function tryLogin(tenantPhone, key) {
  const resp = await axios.post(`${BASE_URL}/tenant/session/login`, {
    tenant_phone: tenantPhone,
    key,
  }, { timeout: 30000 });
  return resp.data;
}

async function main() {
  const candidate = await getCandidateTenantPhone();
  console.log(`Using tenant: ${candidate.client_name} (${candidate.normalized_phone})`);

  const keyCandidates = [process.env.TENANT_DASHBOARD_PASS, process.env.ADMIN_PASS]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  if (!keyCandidates.length) {
    throw new Error("No dashboard key candidates found in local env (TENANT_DASHBOARD_PASS/ADMIN_PASS).");
  }

  let session = null;
  let keyUsed = null;
  for (const key of keyCandidates) {
    try {
      const data = await tryLogin(candidate.normalized_phone, key);
      if (data?.token) {
        session = data;
        keyUsed = key;
        break;
      }
    } catch (err) {
      const detail = err?.response?.data?.error || err.message;
      console.log(`Login attempt failed with one key: ${detail}`);
    }
  }

  if (!session?.token) {
    throw new Error("Unable to create tenant session on deployed app with available keys.");
  }

  console.log(`Tenant session acquired. Expires at: ${session.expires_at}`);

  const audience = await axios.get(`${BASE_URL}/tenant/broadcast/audience`, {
    params: {
      window_hours: 8760,
      segment: "all",
      tenant_phone: candidate.normalized_phone,
    },
    headers: {
      "x-tenant-session": session.token,
    },
    timeout: 15000,
  });

  console.log(`Broadcast audience count: ${audience.data?.count || 0}`);

  const message = buildCampaignMessage();
  const sendResp = await axios.post(`${BASE_URL}/tenant/broadcast`, {
    message,
    window_hours: 8760,
    segment: "all",
    tenant_phone: candidate.normalized_phone,
  }, {
    headers: {
      "x-tenant-session": session.token,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  console.log("Live broadcast result:");
  console.log(JSON.stringify(sendResp.data, null, 2));

  await axios.post(`${BASE_URL}/tenant/session/logout`, {}, {
    headers: {
      "x-tenant-session": session.token,
    },
    timeout: 10000,
  }).catch(() => {});

  console.log(`Completed live broadcast using key source: ${keyUsed === process.env.TENANT_DASHBOARD_PASS ? "TENANT_DASHBOARD_PASS" : "ADMIN_PASS"}`);
}

main().catch((err) => {
  const detail = err?.response?.data || err.message;
  console.error("Live broadcast failed:", typeof detail === "string" ? detail : JSON.stringify(detail));
  process.exit(1);
});
