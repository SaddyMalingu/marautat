#!/usr/bin/env node
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const SB_URL = process.env.SB_URL;
const SB_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
  console.error("Missing SB_URL or SB_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY);

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("254") && digits.length >= 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits.length >= 10 ? digits : null;
}

function containsAny(text, needles) {
  const value = String(text || "").toLowerCase();
  return needles.some((needle) => value.includes(needle));
}

async function fetchAllIncomingConversations(pageSize = 1000) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("conversations")
      .select("user_id, direction, created_at")
      .eq("direction", "incoming")
      .order("created_at", { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function fetchUsersByIds(userIds, chunkSize = 200) {
  const usersById = new Map();
  const ids = [...new Set(userIds.filter(Boolean))];

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("users")
      .select("id, phone, full_name, created_at")
      .in("id", chunk);

    if (error) throw error;
    for (const row of data || []) {
      usersById.set(row.id, row);
    }
  }

  return usersById;
}

async function fetchExcludedTenantPhones() {
  const keywords = ["gideon", "kassangas"];
  const phones = new Set();

  let data = [];
  {
    let resp = await supabase
      .from("bot_tenants")
      .select("client_phone, point_of_contact_phone, client_name, point_of_contact_name, client_email");

    if (resp.error) {
      resp = await supabase
        .from("bot_tenants")
        .select("client_phone, point_of_contact_phone, client_name, point_of_contact_name");
    }
    if (resp.error) {
      resp = await supabase
        .from("bot_tenants")
        .select("client_phone, client_name");
    }
    if (resp.error) throw resp.error;
    data = resp.data || [];
  }

  for (const row of data || []) {
    const tagged =
      containsAny(row.client_name, keywords) ||
      containsAny(row.point_of_contact_name, keywords) ||
      containsAny(row.client_email, keywords);

    if (tagged) {
      const p1 = normalizePhone(row.client_phone);
      const p2 = normalizePhone(row.point_of_contact_phone);
      if (p1) phones.add(p1);
      if (p2) phones.add(p2);
    }
  }

  // Hard exclusion fallback from known records.
  ["254702245555", "0702245555", "+254702245555"].forEach((p) => {
    const n = normalizePhone(p);
    if (n) phones.add(n);
  });

  return phones;
}

function toCsvValue(value) {
  const raw = String(value ?? "");
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function isObviousTestPhone(phone) {
  const p = String(phone || "");
  return /^25470000000\d$/.test(p) || /^2547000000\d$/.test(p);
}

function daysAgo(isoDate) {
  if (!isoDate) return Number.POSITIVE_INFINITY;
  const ts = new Date(isoDate).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

async function main() {
  const incoming = await fetchAllIncomingConversations();
  const userIds = incoming.map((row) => row.user_id).filter(Boolean);
  const usersById = await fetchUsersByIds(userIds);
  const excludedPhones = await fetchExcludedTenantPhones();

  const excludedNameKeywords = ["gideon", "kassangas"];
  const manualExcludedPhones = new Set(
    ["254117604817", "254743780542"].map((p) => normalizePhone(p)).filter(Boolean)
  );
  const perPhone = new Map();

  for (const row of incoming) {
    const user = usersById.get(row.user_id);
    const normalizedPhone = normalizePhone(user?.phone);
    if (!normalizedPhone) continue;

    const fullName = String(user?.full_name || "");
    if (excludedPhones.has(normalizedPhone)) continue;
    if (manualExcludedPhones.has(normalizedPhone)) continue;
    if (containsAny(fullName, excludedNameKeywords)) continue;
    if (isObviousTestPhone(normalizedPhone)) continue;

    const existing = perPhone.get(normalizedPhone) || {
      phone: normalizedPhone,
      full_name: fullName || "Unknown",
      first_seen_at: row.created_at || user?.created_at || null,
      last_seen_at: row.created_at || user?.created_at || null,
      incoming_messages: 0,
    };

    existing.incoming_messages += 1;
    if (row.created_at && (!existing.first_seen_at || row.created_at < existing.first_seen_at)) {
      existing.first_seen_at = row.created_at;
    }
    if (row.created_at && (!existing.last_seen_at || row.created_at > existing.last_seen_at)) {
      existing.last_seen_at = row.created_at;
    }
    if ((!existing.full_name || existing.full_name === "Unknown") && fullName) {
      existing.full_name = fullName;
    }

    perPhone.set(normalizedPhone, existing);
  }

  const leads = [...perPhone.values()].sort((a, b) => {
    const ta = new Date(a.last_seen_at || 0).getTime();
    const tb = new Date(b.last_seen_at || 0).getTime();
    return tb - ta;
  });

  const outDir = path.join(process.cwd(), "leads");
  fs.mkdirSync(outDir, { recursive: true });

  const priorityLeads = leads.filter((row) => {
    const recentEnough = daysAgo(row.last_seen_at) <= 120;
    const engagedEnough = Number(row.incoming_messages || 0) >= 2;
    return recentEnough && engagedEnough;
  });

  const txtPath = path.join(outDir, "all_inbound_non_kassangas.txt");
  fs.writeFileSync(txtPath, leads.map((x) => x.phone).join("\n") + (leads.length ? "\n" : ""), "utf8");

  const csvHeader = ["phone", "full_name", "incoming_messages", "first_seen_at", "last_seen_at"];
  const csvRows = [
    csvHeader.join(","),
    ...leads.map((row) => [
      toCsvValue(row.phone),
      toCsvValue(row.full_name),
      toCsvValue(row.incoming_messages),
      toCsvValue(row.first_seen_at),
      toCsvValue(row.last_seen_at),
    ].join(",")),
  ];

  const csvPath = path.join(outDir, "all_inbound_non_kassangas.csv");
  fs.writeFileSync(csvPath, csvRows.join("\n") + "\n", "utf8");

  const priorityTxtPath = path.join(outDir, "priority_inbound_non_kassangas.txt");
  fs.writeFileSync(
    priorityTxtPath,
    priorityLeads.map((x) => x.phone).join("\n") + (priorityLeads.length ? "\n" : ""),
    "utf8"
  );

  const priorityCsvPath = path.join(outDir, "priority_inbound_non_kassangas.csv");
  const priorityRows = [
    csvHeader.join(","),
    ...priorityLeads.map((row) => [
      toCsvValue(row.phone),
      toCsvValue(row.full_name),
      toCsvValue(row.incoming_messages),
      toCsvValue(row.first_seen_at),
      toCsvValue(row.last_seen_at),
    ].join(",")),
  ];
  fs.writeFileSync(priorityCsvPath, priorityRows.join("\n") + "\n", "utf8");

  console.log("Lead preparation complete.");
  console.log(`Incoming conversation rows scanned: ${incoming.length}`);
  console.log(`Unique leads prepared: ${leads.length}`);
  console.log(`Priority leads prepared: ${priorityLeads.length}`);
  console.log(`Excluded phones (Gideon/Kassangas): ${excludedPhones.size}`);
  console.log(`Manual excluded phones: ${manualExcludedPhones.size}`);
  console.log(`TXT output: ${txtPath}`);
  console.log(`CSV output: ${csvPath}`);
  console.log(`Priority TXT output: ${priorityTxtPath}`);
  console.log(`Priority CSV output: ${priorityCsvPath}`);
}

main().catch((err) => {
  console.error("Failed to prepare leads:", err.message || err);
  process.exit(1);
});
