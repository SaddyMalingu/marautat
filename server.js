
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { log } from "./utils/logger.js";
import { sendMessage, sendImage, sendInteractiveList } from "./utils/messenger.js";
import { startHealthMonitor, runHealthCheck, incrementErrorCount } from "./utils/healthMonitor.js";

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString("utf8") : "";
  },
}));
// Tenant APIs are defined below with session protection.

// Robust request logging middleware (console + file)
const logStream = fs.createWriteStream(path.join(process.cwd(), 'request.log'), { flags: 'a' });
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLine = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms\n`;
    console.log(logLine.trim());
    logStream.write(logLine);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      const logLine = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} CLOSED BEFORE END\n`;
      console.log(logLine.trim());
      logStream.write(logLine);
    }
  });
  next();
});

// Helper: Register WhatsApp webhook with Meta Graph API
async function registerMetaWebhook({
  whatsapp_business_account_id,
  whatsapp_access_token,
  webhook_url
}) {
  try {
    const url = `https://graph.facebook.com/v19.0/${whatsapp_business_account_id}/subscribed_apps`;
    const response = await axios.post(
      url,
      {
        subscribed_fields: ["messages", "message_deliveries", "message_reads", "message_reactions"],
        object: "whatsapp_business_account",
        callback_url: webhook_url,
        verify_token: process.env.META_VERIFY_TOKEN || "your-verify-token"
      },
      {
        headers: {
          Authorization: `Bearer ${whatsapp_access_token}`,
          "Content-Type": "application/json"
        }
      }
    );
    return { ok: true, data: response.data };
  } catch (err) {
    return { ok: false, error: err.response?.data || err.message };
  }
}

// ===== TENANT: Automated Onboarding API =====
// POST /tenant/onboard - Create a new tenant from portal onboarding
app.post('/tenant/onboard', async (req, res) => {
  try {
    const {
      client_name,
      client_phone,
      client_email,
      point_of_contact_name,
      business_address,
      business_description,
      logo,
      industry,
      agent_description,
      whatsapp_phone_number_id,
      whatsapp_business_account_id,
      whatsapp_access_token
    } = req.body;
    if (!client_name || !client_phone || !whatsapp_phone_number_id || !whatsapp_business_account_id || !whatsapp_access_token) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    // Insert tenant with is_active and is_verified false by default
    const { data, error } = await supabase
      .from('bot_tenants')
      .upsert([
        {
          client_name,
          client_phone,
          client_email,
          point_of_contact_name,
          is_active: false,
          is_verified: false,
          whatsapp_phone_number_id,
          whatsapp_business_account_id,
          whatsapp_access_token,
          metadata: {
            business_address,
            business_description,
            logo,
            industry,
            agent_description
          }
        }
      ], { onConflict: ['client_phone'] });
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    // Register webhook with Meta after onboarding
    const webhook_url = process.env.WHATSAPP_WEBHOOK_URL || "https://yourdomain.com/webhook";
    const metaResult = await registerMetaWebhook({
      whatsapp_business_account_id,
      whatsapp_access_token,
      webhook_url
    });
    // Optionally update verification status if registration is successful
    if (metaResult.ok) {
      await supabase
        .from('bot_tenants')
        .update({ webhook_registered: true })
        .eq('client_phone', client_phone);
    }
    res.json({ ok: true, data, meta: metaResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ===== REVENUE PERFORMANCE LAB API =====
app.get('/admin/api/revenue-lab', adminAuth, async (req, res) => {
  try {
    // Campaign experiments (last 30)
    const { data: campaigns, error: campErr } = await supabase
      .from('campaign_history')
      .select('id, name, status, sent_at, audience, template, total, success, failed, funnel, cohort, recovery_ladder')
      .order('sent_at', { ascending: false })
      .limit(30);
    if (campErr) return res.status(500).json({ error: campErr.message });

    // Funnel summary (aggregate)
    const funnel = {
      attempts: campaigns.reduce((a, c) => a + (c.funnel?.attempts || 0), 0),
      success: campaigns.reduce((a, c) => a + (c.funnel?.success || 0), 0),
      failed: campaigns.reduce((a, c) => a + (c.funnel?.failed || 0), 0),
      pending: campaigns.reduce((a, c) => a + (c.funnel?.pending || 0), 0),
    };

    // Cohort summary (aggregate)
    const cohort = {};
    campaigns.forEach(c => {
      if (c.cohort) {
        Object.entries(c.cohort).forEach(([k, v]) => {
          cohort[k] = (cohort[k] || 0) + v;
        });
      }
    });

    // Recovery ladder (aggregate)
    const recovery = {};
    campaigns.forEach(c => {
      if (c.recovery_ladder) {
        Object.entries(c.recovery_ladder).forEach(([k, v]) => {
          recovery[k] = (recovery[k] || 0) + v;
        });
      }
    });

    res.json({ campaigns, funnel, cohort, recovery });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== TENANT SUCCESS & CHURN PREVENTION API =====
app.get('/admin/api/tenant-success', adminAuth, async (req, res) => {
  try {
    // Get all tenants
    const { data: tenants, error } = await supabase
      .from('bot_tenants')
      .select('id, client_name, client_phone, status, created_at, updated_at, onboarding_status, churn_risk, last_active_at, metadata')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Health 2.0: readiness, onboarding, activity
    const now = Date.now();
    const health = tenants.map(t => {
      const daysSinceActive = t.last_active_at ? (now - new Date(t.last_active_at).getTime()) / (1000 * 60 * 60 * 24) : null;
      const onboarding = t.onboarding_status || (t.metadata?.onboarding_status) || 'unknown';
      const churnRisk = t.churn_risk || (t.metadata?.churn_risk) || 0;
      return {
        id: t.id,
        name: t.client_name,
        phone: t.client_phone,
        status: t.status,
        onboarding,
        churn_risk: Number(churnRisk),
        last_active_at: t.last_active_at,
        days_since_active: daysSinceActive,
        created_at: t.created_at,
        updated_at: t.updated_at,
      };
    });

    // Churn prediction: high risk = churn_risk >= 0.7, inactive > 30d, onboarding incomplete
    const atRisk = health.filter(t => t.churn_risk >= 0.7 || (t.days_since_active !== null && t.days_since_active > 30) || (t.onboarding !== 'completed'));
    const onboardingStuck = health.filter(t => t.onboarding !== 'completed');
    const churnSpark = health.map(t => t.churn_risk).slice(0, 30); // last 30 tenants

    // Summary
    const summary = {
      total: health.length,
      healthy: health.filter(t => t.churn_risk < 0.3 && t.onboarding === 'completed' && (t.days_since_active !== null && t.days_since_active <= 30)).length,
      at_risk: atRisk.length,
      onboarding_stuck: onboardingStuck.length,
      avg_churn_risk: health.length ? (health.reduce((a, t) => a + t.churn_risk, 0) / health.length).toFixed(2) : '0.00',
    };

    res.json({ summary, at_risk: atRisk, onboarding_stuck: onboardingStuck, churn_spark: churnSpark, tenants: health });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== OWNER/ADMIN: SLO BOARD & INCIDENTS API =====
app.get('/admin/api/slo-board', adminAuth, async (req, res) => {
  try {
    // SLO board (recovery board)
    const slo = await buildSlaRecoveryBoard(30);

    // Error budget: % of failed/pending/overdue out of total
    const total = slo.summary.total || 0;
    const errorBudget = total > 0
      ? Math.round(((slo.summary.failed + slo.summary.pending + slo.summary.manual_pending_verification + slo.summary.cod_pending_delivery) / total) * 1000) / 10
      : null;

    // Recent and closed incidents (timeline)
    let incidents = [];
    try {
      // Try to read both active and closed incidents from file
      const fs = require('fs');
      const path = require('path');
      const incidentFile = path.join(process.cwd(), 'logs', 'admin_incident.json');
      if (fs.existsSync(incidentFile)) {
        const raw = fs.readFileSync(incidentFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          incidents = parsed.slice(-10).reverse(); // last 10 incidents, newest first
        } else if (parsed && typeof parsed === 'object') {
          incidents = [parsed];
        }
      }
    } catch {}

    // Also include active incident if not already present
    try {
      const active = await readActiveIncident();
      if (active && !incidents.some(i => i.id === active.id)) {
        incidents.unshift(active);
      }
    } catch {}

    return res.json({
      generated_at: new Date().toISOString(),
      slo_board: slo,
      error_budget_percent: errorBudget,
      incidents,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Serve static files from public directory
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Secure route to download request.log for debugging
app.get('/debug/request-log', (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== ADMIN_PASS) {
    return res.status(401).send('Unauthorized');
  }
  const logPath = path.join(process.cwd(), 'request.log');
  if (!fs.existsSync(logPath)) {
    return res.status(404).send('Log file not found');
  }
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="request.log"');
  fs.createReadStream(logPath).pipe(res);
});

// Serve public/index.html at root
app.get('/', (req, res) => {
  log(`Landing page loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Serve agent-demo-modal.html explicitly for isolated modal demo
app.get('/agent-demo-modal.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'agent-demo-modal.html'));
});


// Only instantiate OpenAI if the API key is present
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE_KEY
);

// ===== ADMIN: ADD AGENT/TENANT API =====
// POST /admin/agents - Add a new agent/tenant
app.post('/admin/agents', tenantDashboardAuth, async (req, res) => {
  const {
    client_name,
    client_phone,
    client_email,
    point_of_contact_name,
    business_address,
    business_description,
    logo,
    industry,
    status,
    agent_description
  } = req.body;
  if (!client_name || !client_phone) {
    return res.status(400).json({ error: 'Business Name and Contact Phone are required.' });
  }
  const { data, error } = await supabase
    .from('bot_tenants')
    .upsert([
      {
        client_name,
        client_phone,
        client_email,
        point_of_contact_name,
        is_active: status === 'active',
        metadata: {
          business_address,
          business_description,
          logo,
          industry,
          agent_description
        }
      }
    ], { onConflict: ['client_phone'] });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true, data });
});

// ✅ Default brand UUID (your platform brand)
const DEFAULT_BRAND_ID =
  process.env.DEFAULT_BRAND_ID || "1af71403-b4c3-4eac-9aab-48ee2576a9bb";

const ADMIN_PASS = process.env.ADMIN_PASS;
const TENANT_DASHBOARD_PASS = process.env.TENANT_DASHBOARD_PASS;

// ⚠️ Enforce separation: both must be set AND different
if (!ADMIN_PASS || !TENANT_DASHBOARD_PASS) {
  console.warn(`⚠️  WARNING: Both ADMIN_PASS and TENANT_DASHBOARD_PASS must be set separately.`);
  console.warn(`   - ADMIN_PASS set: ${!!ADMIN_PASS}`);
  console.warn(`   - TENANT_DASHBOARD_PASS set: ${!!TENANT_DASHBOARD_PASS}`);
}
if (ADMIN_PASS && TENANT_DASHBOARD_PASS && ADMIN_PASS === TENANT_DASHBOARD_PASS) {
  console.warn(`⚠️  WARNING: ADMIN_PASS and TENANT_DASHBOARD_PASS must be DIFFERENT for security.`);
}

const TENANT_SESSION_TTL_MS = parseInt(process.env.TENANT_SESSION_TTL_MS || "28800000", 10);
const ADMIN_DASHBOARD_ENABLED = process.env.ADMIN_DASHBOARD_ENABLED !== "false";
const ADMIN_UPLOAD_BUCKET = process.env.ADMIN_UPLOAD_BUCKET || "product-images";
const ADMIN_UPLOAD_MAX_MB = parseInt(process.env.ADMIN_UPLOAD_MAX_MB || "10", 10);
const CAMPAIGN_HISTORY_FILE = path.join(process.cwd(), "logs", "admin_campaign_runs.jsonl");
const ADMIN_ACTION_HISTORY_FILE = path.join(process.cwd(), "logs", "admin_action_history.jsonl");
const ADMIN_APPROVALS_FILE = path.join(process.cwd(), "logs", "admin_approvals.json");
const ADMIN_INCIDENT_FILE = path.join(process.cwd(), "logs", "admin_incident.json");
const ADMIN_POLICY_REQUIRE_LIVE_CONFIRM = process.env.ADMIN_POLICY_REQUIRE_LIVE_CONFIRM === "true";
const ADMIN_POLICY_REQUIRE_DRY_RUN_FIRST = process.env.ADMIN_POLICY_REQUIRE_DRY_RUN_FIRST === "true";
const ADMIN_DEFAULT_ROLE = process.env.ADMIN_DEFAULT_ROLE || "super_admin";
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(",").map((n) => n.trim())
  : [];

startHealthMonitor(ADMIN_NUMBERS, 200);
runHealthCheck(ADMIN_NUMBERS);

let pendingClearConfirmations = {};

// ===== ADMIN: simple auth middleware =====
function adminAuth(req, res, next) {
  if (!ADMIN_PASS) {
    return res.status(500).json({ error: "ADMIN_PASS not set" });
  }
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_PASS) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function appendCampaignHistory(record) {
  try {
    await fs.promises.mkdir(path.dirname(CAMPAIGN_HISTORY_FILE), { recursive: true });
    await fs.promises.appendFile(CAMPAIGN_HISTORY_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    log(`Campaign history append warning: ${err.message}`, "WARN");
  }
}

async function appendAdminAction(record) {
  try {
    await fs.promises.mkdir(path.dirname(ADMIN_ACTION_HISTORY_FILE), { recursive: true });
    await fs.promises.appendFile(ADMIN_ACTION_HISTORY_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    log(`Admin action append warning: ${err.message}`, "WARN");
  }
}

function parseAdminActionFilters(query = {}) {
  const statusRaw = String(query.status || "").trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(query.limit || "100", 10)));
  return {
    limit,
    from: parseDateFilter(query.from, false),
    to: parseDateFilter(query.to, true),
    action: String(query.action || "").trim().toLowerCase(),
    status: statusRaw === "all" ? "" : statusRaw,
    actor: String(query.actor || "").trim().toLowerCase(),
  };
}

function filterAdminActionRecords(records, filters) {
  const fromMs = filters.from ? filters.from.getTime() : null;
  const toMs = filters.to ? filters.to.getTime() : null;
  return records.filter((item) => {
    const ts = parseIsoDate(item.when || item.ran_at || item.created_at || 0);
    if (fromMs !== null && ts < fromMs) return false;
    if (toMs !== null && ts > toMs) return false;
    if (filters.action && !String(item.action || "").toLowerCase().includes(filters.action)) return false;
    if (filters.status && String(item.status || "").toLowerCase() !== filters.status) return false;
    if (filters.actor && !String(item.actor || "").toLowerCase().includes(filters.actor)) return false;
    return true;
  });
}

async function readAdminActions(options = {}) {
  const resolved = typeof options === "number" ? { limit: options } : (options || {});
  const filters = {
    limit: Math.min(500, Math.max(1, parseInt(resolved.limit || "100", 10))),
    from: resolved.from || null,
    to: resolved.to || null,
    action: String(resolved.action || "").trim().toLowerCase(),
    status: String(resolved.status || "").trim().toLowerCase(),
    actor: String(resolved.actor || "").trim().toLowerCase(),
  };
  try {
    const content = await fs.promises.readFile(ADMIN_ACTION_HISTORY_FILE, "utf8");
    const all = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => parseIsoDate(b.when || 0) - parseIsoDate(a.when || 0));
    const filtered = filterAdminActionRecords(all, filters);
    return {
      all_count: all.length,
      filtered_count: filtered.length,
      items: filtered.slice(0, filters.limit),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { all_count: 0, filtered_count: 0, items: [] };
    }
    log(`Admin action read warning: ${err.message}`, "WARN");
    return { all_count: 0, filtered_count: 0, items: [] };
  }
}

function normalizeAdminRole(rawRole) {
  const role = String(rawRole || "").trim().toLowerCase();
  if (["super_admin", "operations", "finance", "campaign_manager", "support"].includes(role)) {
    return role;
  }
  return ADMIN_DEFAULT_ROLE;
}

function getAdminRole(req) {
  return normalizeAdminRole(req.headers["x-admin-role"] || req.query.role || ADMIN_DEFAULT_ROLE);
}

function getAdminActor(req) {
  return String(req.headers["x-admin-actor"] || req.query.actor || "admin").trim() || "admin";
}

function ensureAdminRole(req, allowedRoles = []) {
  const role = getAdminRole(req);
  return allowedRoles.includes(role) ? role : null;
}

async function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallbackValue;
    log(`JSON read warning (${path.basename(filePath)}): ${err.message}`, "WARN");
    return fallbackValue;
  }
}

async function writeJsonFileSafe(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readApprovalRequests() {
  const rows = await readJsonFileSafe(ADMIN_APPROVALS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

async function saveApprovalRequests(rows) {
  await writeJsonFileSafe(ADMIN_APPROVALS_FILE, rows);
}

async function createApprovalRequest({ action, requested_by, requested_role, payload, note, source_ip }) {
  const approvals = await readApprovalRequests();
  const record = {
    id: `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    action,
    requested_by,
    requested_role,
    status: "pending",
    payload: payload || {},
    note: note || "",
    source_ip: source_ip || "",
    requested_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
  };
  approvals.unshift(record);
  await saveApprovalRequests(approvals);
  return record;
}

async function resolveApprovalRequest(approvalId, { reviewer, status, note }) {
  const approvals = await readApprovalRequests();
  const updated = approvals.map((item) => {
    if (item.id !== approvalId) return item;
    return {
      ...item,
      status,
      review_note: note || item.review_note || "",
      reviewed_by: reviewer,
      reviewed_at: new Date().toISOString(),
    };
  });
  await saveApprovalRequests(updated);
  return updated.find((item) => item.id === approvalId) || null;
}

async function readActiveIncident() {
  return readJsonFileSafe(ADMIN_INCIDENT_FILE, null);
}

async function writeActiveIncident(payload) {
  if (!payload) {
    try {
      await fs.promises.unlink(ADMIN_INCIDENT_FILE);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return;
  }
  await writeJsonFileSafe(ADMIN_INCIDENT_FILE, payload);
}

function getSlaTargetMinutes(status) {
  const value = String(status || "").toLowerCase();
  if (value === "failed") return 30;
  if (value === "pending") return 20;
  if (value === "manual_pending_verification") return 60;
  if (value === "cod_pending_delivery") return 180;
  return 60;
}

async function buildSlaRecoveryBoard(limit = 30) {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let { data: subs, error: subsErr } = await supabase
    .from("subscriptions")
    .select("id, user_id, phone, amount, plan_type, level, status, product_sku, metadata, created_at, updated_at")
    .gte("created_at", since30d)
    .in("status", ["failed", "pending", "manual_pending_verification", "cod_pending_delivery"]);
  if (subsErr && isMissingColumnError(subsErr)) {
    ({ data: subs, error: subsErr } = await supabase
      .from("subscriptions")
      .select("id, user_id, phone, amount, plan_type, level, status, metadata, created_at, updated_at")
      .gte("created_at", since30d)
      .in("status", ["failed", "pending", "manual_pending_verification", "cod_pending_delivery"]));
  }
  if (subsErr) throw subsErr;

  const items = subs || [];
  const userIds = [...new Set(items.map((item) => item.user_id).filter(Boolean))];
  let users = [];
  let conversations = [];
  if (userIds.length) {
    const [{ data: userRows, error: userErr }, { data: convRows, error: convErr }] = await Promise.all([
      supabase.from("users").select("id, phone, full_name").in("id", userIds),
      supabase.from("conversations").select("user_id, direction, message_text, created_at").in("user_id", userIds).order("created_at", { ascending: false }).limit(800),
    ]);
    if (userErr) throw userErr;
    if (convErr) throw convErr;
    users = userRows || [];
    conversations = convRows || [];
  }

  const userMap = new Map(users.map((item) => [item.id, item]));
  const lastInbound = new Map();
  const lastOutbound = new Map();
  for (const row of conversations) {
    if (row.direction === "incoming" && !lastInbound.has(row.user_id)) lastInbound.set(row.user_id, row);
    if (row.direction === "outgoing" && !lastOutbound.has(row.user_id)) lastOutbound.set(row.user_id, row);
  }

  const rows = items
    .map((item) => {
      const user = userMap.get(item.user_id);
      const updatedMs = parseIsoDate(item.updated_at || item.created_at || 0);
      const ageMinutes = updatedMs ? Math.max(0, Math.round((Date.now() - updatedMs) / 60000)) : 0;
      const slaTargetMinutes = getSlaTargetMinutes(item.status);
      const overdueMinutes = Math.max(0, ageMinutes - slaTargetMinutes);
      return {
        subscription_id: item.id,
        status: item.status,
        amount: Number(item.amount) || 0,
        plan: `${String(item.plan_type || "checkout").toUpperCase()}${item.level ? ` L${item.level}` : ""}`,
        product_sku: item.product_sku || item.metadata?.sku || null,
        customer_name: user?.full_name || "Unknown User",
        wa_phone: normalizeCampaignPhone(user?.phone) || extractWaTargetFromSubscription(item),
        age_minutes: ageMinutes,
        sla_target_minutes: slaTargetMinutes,
        overdue_minutes: overdueMinutes,
        next_action: getLeadActionHint(item),
        last_inbound_at: lastInbound.get(item.user_id)?.created_at || null,
        last_inbound_message: lastInbound.get(item.user_id)?.message_text || null,
        last_outbound_at: lastOutbound.get(item.user_id)?.created_at || null,
        updated_at: item.updated_at || item.created_at || null,
      };
    })
    .sort((a, b) => b.overdue_minutes - a.overdue_minutes || b.age_minutes - a.age_minutes)
    .slice(0, Math.min(100, Math.max(5, Number(limit || 30))));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total: rows.length,
      overdue: rows.filter((item) => item.overdue_minutes > 0).length,
      failed: rows.filter((item) => String(item.status).toLowerCase() === "failed").length,
      pending: rows.filter((item) => String(item.status).toLowerCase() === "pending").length,
      manual_pending_verification: rows.filter((item) => String(item.status).toLowerCase() === "manual_pending_verification").length,
      cod_pending_delivery: rows.filter((item) => String(item.status).toLowerCase() === "cod_pending_delivery").length,
    },
    items: rows,
  };
}

async function loadSubscriptionForAdminAction(subscriptionId) {
  let { data, error } = await supabase
    .from("subscriptions")
    .select("id, user_id, phone, amount, plan_type, level, status, product_sku, metadata, created_at, updated_at")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await supabase
      .from("subscriptions")
      .select("id, user_id, phone, amount, plan_type, level, status, metadata, created_at, updated_at")
      .eq("id", subscriptionId)
      .maybeSingle());
  }
  if (error) throw error;
  return data || null;
}

async function performAdminRecoveryAction({ action, subscriptionId, actor, sourceIp }) {
  const subscription = await loadSubscriptionForAdminAction(subscriptionId);
  if (!subscription) throw new Error("Subscription not found");
  const waPhone = normalizeCampaignPhone(subscription.metadata?.customer_wa) || normalizeCampaignPhone(subscription.phone);
  if (!waPhone) throw new Error("Unable to resolve customer phone");

  if (action === "retry_prompt") {
    await sendMessage(waPhone, `Hi, your Alphadome payment is still incomplete. Reply with *RETRY PAYMENT* if you want us to restart the checkout immediately.`);
  } else if (action === "fallback_options") {
    await sendFallbackPaymentOptions(
      waPhone,
      subscription.plan_type || "checkout",
      subscription.level || null,
      Number(subscription.amount) || 0,
      subscription.id,
      Boolean(subscription.product_sku || subscription.metadata?.sku)
    );
  } else if (action === "mark_bank_verified") {
    const metadata = subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata : {};
    const { error } = await supabase
      .from("subscriptions")
      .update({
        status: "active",
        updated_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          admin_bank_verified_at: new Date().toISOString(),
          admin_bank_verified_by: actor,
        },
      })
      .eq("id", subscriptionId);
    if (error) throw error;
  } else if (action === "mark_cod_dispatched") {
    const metadata = subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata : {};
    const { error } = await supabase
      .from("subscriptions")
      .update({
        updated_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          admin_cod_dispatched_at: new Date().toISOString(),
          admin_cod_dispatched_by: actor,
        },
      })
      .eq("id", subscriptionId);
    if (error) throw error;
  } else if (action === "assign_manual_followup") {
    const metadata = subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata : {};
    const { error } = await supabase
      .from("subscriptions")
      .update({
        updated_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          admin_manual_followup_at: new Date().toISOString(),
          admin_manual_followup_by: actor,
        },
      })
      .eq("id", subscriptionId);
    if (error) throw error;
  } else {
    throw new Error("Unsupported recovery action");
  }

  await appendAdminAction({
    when: new Date().toISOString(),
    action: `recovery.${action}`,
    status: "success",
    actor,
    source_ip: sourceIp,
    note: `Recovery action ${action} applied to ${subscriptionId}`,
    metadata: { subscription_id: subscriptionId, wa_phone: waPhone },
  });

  return { ok: true, subscription_id: subscriptionId, action, wa_phone: waPhone };
}

async function buildTenantReadinessReport(limit = 50) {
  const tenantResp = await supabase
    .from("bot_tenants")
    .select("id, client_name, client_phone, status, is_active, whatsapp_phone_number_id, whatsapp_access_token, updated_at, created_at")
    .limit(Math.min(200, Math.max(1, Number(limit || 50))));
  if (tenantResp.error && !isMissingColumnError(tenantResp.error)) throw tenantResp.error;
  const tenants = tenantResp.data || [];

  let productRows = [];
  const productsResp = await supabase.from("bot_products").select("bot_tenant_id, is_active");
  if (!productsResp.error) productRows = productsResp.data || [];

  let trainingRows = [];
  const trainingResp = await supabase.from("bot_training_data").select("bot_tenant_id, is_active");
  if (!trainingResp.error && !isMissingTableInSchemaCache(trainingResp.error)) trainingRows = trainingResp.data || [];

  const productCountByTenant = new Map();
  for (const row of productRows) {
    const count = productCountByTenant.get(row.bot_tenant_id) || 0;
    productCountByTenant.set(row.bot_tenant_id, count + (row.is_active === false ? 0 : 1));
  }
  const trainingCountByTenant = new Map();
  for (const row of trainingRows) {
    const count = trainingCountByTenant.get(row.bot_tenant_id) || 0;
    trainingCountByTenant.set(row.bot_tenant_id, count + (row.is_active === false ? 0 : 1));
  }

  const now = Date.now();
  const scored = tenants.map((tenant) => {
    const productCount = productCountByTenant.get(tenant.id) || 0;
    const trainingCount = trainingCountByTenant.get(tenant.id) || 0;
    const updatedMs = parseIsoDate(tenant.updated_at || tenant.created_at || 0);
    const recent = updatedMs && (now - updatedMs) <= (30 * 24 * 60 * 60 * 1000);
    let score = 0;
    const checks = [];
    const pushCheck = (label, ok, weight) => {
      checks.push({ label, ok });
      if (ok) score += weight;
    };
    pushCheck("Tenant active", isTenantRecordActive(tenant), 20);
    pushCheck("Valid tenant phone", Boolean(normalizeCampaignPhone(tenant.client_phone)), 10);
    pushCheck("WhatsApp phone ID", Boolean(tenant.whatsapp_phone_number_id), 15);
    pushCheck("WhatsApp access token", Boolean(tenant.whatsapp_access_token), 15);
    pushCheck("Active catalog products", productCount > 0, 20);
    pushCheck("Training data present", trainingCount > 0, 10);
    pushCheck("Recently maintained", Boolean(recent), 10);
    const level = score >= 80 ? "ready" : score >= 50 ? "needs_attention" : "critical";
    return {
      id: tenant.id,
      client_name: tenant.client_name || "Unknown tenant",
      client_phone: tenant.client_phone || "",
      status: tenant.status || (isTenantRecordActive(tenant) ? "active" : "inactive"),
      readiness_score: score,
      readiness_level: level,
      product_count: productCount,
      training_count: trainingCount,
      updated_at: tenant.updated_at || tenant.created_at || null,
      checks,
    };
  }).sort((a, b) => a.readiness_score - b.readiness_score);

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total: scored.length,
      ready: scored.filter((item) => item.readiness_level === "ready").length,
      needs_attention: scored.filter((item) => item.readiness_level === "needs_attention").length,
      critical: scored.filter((item) => item.readiness_level === "critical").length,
    },
    tenants: scored,
  };
}

async function buildSupportInbox(limit = 40) {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("user_id, direction, message_text, created_at")
    .gte("created_at", since7d)
    .order("created_at", { ascending: false })
    .limit(1200);
  if (convErr) throw convErr;
  const userIds = [...new Set((convRows || []).map((row) => row.user_id).filter(Boolean))];
  const { data: users, error: userErr } = userIds.length
    ? await supabase.from("users").select("id, phone, full_name").in("id", userIds)
    : { data: [], error: null };
  if (userErr) throw userErr;
  const userMap = new Map((users || []).map((user) => [user.id, user]));

  const latestInbound = new Map();
  const latestOutbound = new Map();
  for (const row of convRows || []) {
    if (row.direction === "incoming" && !latestInbound.has(row.user_id)) latestInbound.set(row.user_id, row);
    if (row.direction === "outgoing" && !latestOutbound.has(row.user_id)) latestOutbound.set(row.user_id, row);
  }

  const unresolved = [...latestInbound.entries()]
    .map(([userId, inbound]) => {
      const outbound = latestOutbound.get(userId);
      const unresolved = !outbound || parseIsoDate(inbound.created_at) > parseIsoDate(outbound.created_at);
      const ageMinutes = Math.max(0, Math.round((Date.now() - parseIsoDate(inbound.created_at)) / 60000));
      return {
        user_id: userId,
        unresolved,
        age_minutes: ageMinutes,
        inbound_at: inbound.created_at,
        message_text: inbound.message_text || "",
        customer_name: userMap.get(userId)?.full_name || "Unknown User",
        wa_phone: normalizeCampaignPhone(userMap.get(userId)?.phone) || "",
      };
    })
    .filter((item) => item.unresolved)
    .sort((a, b) => b.age_minutes - a.age_minutes)
    .slice(0, Math.min(100, Math.max(1, Number(limit || 40))));

  return {
    generated_at: new Date().toISOString(),
    summary: {
      unresolved: unresolved.length,
      over_60m: unresolved.filter((item) => item.age_minutes >= 60).length,
      over_240m: unresolved.filter((item) => item.age_minutes >= 240).length,
    },
    items: unresolved,
  };
}

async function buildFinanceReconciliation(limit = 50) {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id, phone, amount, status, metadata, created_at, updated_at")
    .gte("created_at", since30d)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const items = subs || [];
  const unresolved = items.filter((item) => ["pending", "failed", "manual_pending_verification", "cod_pending_delivery"].includes(String(item.status || "").toLowerCase()));
  const revenueCaptured = items
    .filter((item) => ["active", "completed", "subscribed"].includes(String(item.status || "").toLowerCase()))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {
    generated_at: new Date().toISOString(),
    summary: {
      revenue_captured: revenueCaptured,
      unresolved_count: unresolved.length,
      manual_pending_verification: unresolved.filter((item) => String(item.status || "").toLowerCase() === "manual_pending_verification").length,
      cod_pending_delivery: unresolved.filter((item) => String(item.status || "").toLowerCase() === "cod_pending_delivery").length,
    },
    items: unresolved.slice(0, Math.min(100, Math.max(1, Number(limit || 50)))).map((item) => ({
      id: item.id,
      phone: normalizeCampaignPhone(item.phone) || item.phone || "",
      amount: Number(item.amount) || 0,
      status: item.status,
      created_at: item.created_at,
      updated_at: item.updated_at,
      reason: getFailureReason(item) || item.metadata?.receipt_number || null,
    })),
  };
}

async function buildRevenueCommandCenter() {
  const ops = await buildAdminOpsOverview();
  const sla = await buildSlaRecoveryBoard(50);
  const finance = await buildFinanceReconciliation(50);
  const funnel = {
    incoming_messages_24h: Number(ops.kpis.incoming_messages_24h || 0),
    payment_attempts_30d: Number(ops.kpis.payment_attempts_30d || 0),
    successful_payments_30d: Number(ops.kpis.successful_payments_30d || 0),
    failed_payments_30d: Number(ops.kpis.failed_payments_30d || 0),
    pending_payments_30d: Number(ops.kpis.pending_payments_30d || 0),
  };
  return {
    generated_at: new Date().toISOString(),
    funnel,
    revenue_kes_30d: Number(ops.kpis.total_revenue_kes_30d || 0),
    conversion_rate_pct_30d: Number(ops.kpis.conversion_rate_pct_30d || 0),
    blocked_cases: sla.summary.overdue,
    blocked_value_kes: finance.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
    priorities: ops.strategies || [],
  };
}

async function fetchAllTemplateDefinitions() {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error("Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN");
  }

  const phoneRes = await axios.get(`https://graph.facebook.com/v21.0/${phoneNumberId}`, {
    params: { fields: "whatsapp_business_account" },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  const wabaId = phoneRes?.data?.whatsapp_business_account?.id;
  if (!wabaId) throw new Error("Unable to resolve whatsapp_business_account id");

  const tmplRes = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
    params: {
      fields: "name,status,category,language,components",
      limit: 100,
    },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
  });
  return {
    waba_id: wabaId,
    data: tmplRes?.data?.data || [],
    paging: tmplRes?.data?.paging || null,
  };
}

async function buildTemplateOpsCenter() {
  let templates = { waba_id: null, data: [], paging: null, degraded: false, degraded_reason: null };
  try {
    templates = await fetchAllTemplateDefinitions();
  } catch (err) {
    templates = {
      waba_id: null,
      data: [],
      paging: null,
      degraded: true,
      degraded_reason: err.message || "template provider unavailable",
    };
  }
  const history = await readCampaignHistory({ limit: 200 });
  const usage = new Map();
  for (const row of history.items || []) {
    const key = String(row.template || "unknown");
    const prev = usage.get(key) || { sends: 0, success: 0, failed: 0 };
    prev.sends += Number(row.total || 0);
    prev.success += Number(row.success || 0);
    prev.failed += Number(row.failed || 0);
    usage.set(key, prev);
  }
  const items = (templates.data || []).map((tpl) => ({
    name: tpl.name,
    status: tpl.status,
    category: tpl.category,
    language: tpl.language,
    usage: usage.get(tpl.name) || { sends: 0, success: 0, failed: 0 },
  }));
  return {
    generated_at: new Date().toISOString(),
    count: items.length,
    degraded: Boolean(templates.degraded),
    degraded_reason: templates.degraded_reason || null,
    templates: items,
  };
}

async function buildExecutiveSnapshot() {
  const [ops, revenue, readiness, incident] = await Promise.all([
    buildAdminOpsOverview(),
    buildRevenueCommandCenter(),
    buildTenantReadinessReport(50),
    readActiveIncident(),
  ]);

  // Revenue today
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayIso = `${yyyy}-${mm}-${dd}`;
  let revenueToday = 0;
  try {
    const paymentsToday = await supabase
      .from("payments")
      .select("amount, status, created_at")
      .gte("created_at", `${todayIso}T00:00:00.000Z`)
      .lte("created_at", `${todayIso}T23:59:59.999Z`)
      .eq("status", "success");
    if (paymentsToday.data && Array.isArray(paymentsToday.data)) {
      revenueToday = paymentsToday.data.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    }
  } catch {}

  // Estimate cost and margin (LLM + messaging cost, if available)
  let costToday = 0;
  let cost30d = 0;
  let marginEstimate = null;
  let burnRate = null;
  try {
    // If you have a cost table, use it; else fallback to 0
    const costResp = await supabase
      .from("platform_costs")
      .select("amount, cost_type, created_at")
      .gte("created_at", `${todayIso}T00:00:00.000Z`);
    if (costResp.data && Array.isArray(costResp.data)) {
      costToday = costResp.data.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    }
    // 30d cost
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const cost30dResp = await supabase
      .from("platform_costs")
      .select("amount, cost_type, created_at")
      .gte("created_at", since30d);
    if (cost30dResp.data && Array.isArray(cost30dResp.data)) {
      cost30d = cost30dResp.data.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    }
    marginEstimate = revenueToday - costToday;
    burnRate = cost30d / 30;
  } catch {}

  // Cash at risk (pending payments)
  let cashAtRisk = 0;
  try {
    const pending = await supabase
      .from("payments")
      .select("amount, status")
      .eq("status", "pending");
    if (pending.data && Array.isArray(pending.data)) {
      cashAtRisk = pending.data.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    }
  } catch {}

  // Deltas (change vs yesterday)
  let deltaRevenue = null;
  let deltaMargin = null;
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yyy = yesterday.getFullYear();
    const ymm = String(yesterday.getMonth() + 1).padStart(2, '0');
    const ydd = String(yesterday.getDate()).padStart(2, '0');
    const yIso = `${yyy}-${ymm}-${ydd}`;
    let revenueYesterday = 0;
    let costYesterday = 0;
    const paymentsY = await supabase
      .from("payments")
      .select("amount, status, created_at")
      .gte("created_at", `${yIso}T00:00:00.000Z`)
      .lte("created_at", `${yIso}T23:59:59.999Z`)
      .eq("status", "success");
    if (paymentsY.data && Array.isArray(paymentsY.data)) {
      revenueYesterday = paymentsY.data.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    }
    const costY = await supabase
      .from("platform_costs")
      .select("amount, cost_type, created_at")
      .gte("created_at", `${yIso}T00:00:00.000Z`)
      .lte("created_at", `${yIso}T23:59:59.999Z`);
    if (costY.data && Array.isArray(costY.data)) {
      costYesterday = costY.data.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    }
    deltaRevenue = revenueToday - revenueYesterday;
    deltaMargin = (marginEstimate !== null && !isNaN(costYesterday)) ? (marginEstimate - (revenueYesterday - costYesterday)) : null;
  } catch {}

  // Auto-brief summary
  const autoBrief = `Revenue today: KES ${revenueToday.toLocaleString()} | Margin: ${marginEstimate !== null ? `KES ${marginEstimate.toLocaleString()}` : 'N/A'} | Burn rate: ${burnRate !== null ? `KES ${Math.round(burnRate).toLocaleString()}/day` : 'N/A'} | Cash at risk: KES ${cashAtRisk.toLocaleString()} | ΔRevenue: ${deltaRevenue !== null ? (deltaRevenue >= 0 ? '+' : '') + deltaRevenue.toLocaleString() : 'N/A'}`;

  // --- Profit & Cost Intelligence ---
  const costBreakdown = {};
  try {
    const cost30dResp = await supabase
      .from("platform_costs")
      .select("amount, cost_type, created_at")
      .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (cost30dResp.data && Array.isArray(cost30dResp.data)) {
      for (const c of cost30dResp.data) {
        const type = c.cost_type || 'other';
        costBreakdown[type] = (costBreakdown[type] || 0) + (Number(c.amount) || 0);
      }
    }
  } catch {}

  // Margin % and profit per tenant
  const marginPercent = (revenueToday > 0 && marginEstimate !== null) ? Math.round((marginEstimate / revenueToday) * 1000) / 10 : null;
  const profitPerTenant = (marginEstimate !== null && ops.kpis.active_tenants > 0) ? Math.round(marginEstimate / ops.kpis.active_tenants) : null;

  // Anomaly detection (simple: spike if today > 2x 30d avg)
  const avgRevenue = ops.kpis.total_revenue_kes_30d / 30;
  const avgCost = cost30d / 30;
  const revenueSpike = (revenueToday > 2 * avgRevenue);
  const costSpike = (costToday > 2 * avgCost);
  const guardrails = [];
  if (revenueSpike) guardrails.push('Revenue spike detected');
  if (costSpike) guardrails.push('Cost spike detected');
  if (marginPercent !== null && marginPercent < 10) guardrails.push('Margin below 10%');

  return {
    generated_at: new Date().toISOString(),
    headline: {
      revenue_kes_30d: Number(ops.kpis.total_revenue_kes_30d || 0),
      active_tenants: Number(ops.kpis.active_tenants || 0),
      blocked_cases: Number(revenue.blocked_cases || 0),
      critical_tenants: Number(readiness.summary.critical || 0),
      health_status: ops.kpis.health_status || "unknown",
      active_incident: incident ? incident.title || incident.message || "incident" : null,
      revenue_today: revenueToday,
      margin_estimate: marginEstimate,
      margin_percent: marginPercent,
      profit_per_tenant: profitPerTenant,
      cost_today: costToday,
      cost_30d: cost30d,
      cost_breakdown: costBreakdown,
      burn_rate: burnRate,
      cash_at_risk: cashAtRisk,
      delta_revenue: deltaRevenue,
      delta_margin: deltaMargin,
      auto_brief: autoBrief,
      guardrails,
    },
    priorities: [
      ...(revenue.priorities || []).slice(0, 3),
      ...(guardrails.length ? guardrails : []),
      ...(incident ? [`Incident active: ${incident.title || incident.message}`] : []),
    ].slice(0, 5),
  };
}

function parseDateFilter(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = isDateOnly
    ? new Date(`${raw}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCampaignHistoryFilters(query = {}) {
  const limit = Math.min(500, Math.max(1, parseInt(query.limit || "25", 10)));
  return {
    limit,
    from: parseDateFilter(query.from, false),
    to: parseDateFilter(query.to, true),
    audience: String(query.audience || "").trim().toLowerCase(),
    template: String(query.template || "").trim().toLowerCase(),
    status: String(query.status || "").trim().toLowerCase(),
  };
}

function filterCampaignHistoryRecords(records, filters) {
  const fromMs = filters.from ? filters.from.getTime() : null;
  const toMs = filters.to ? filters.to.getTime() : null;
  return records.filter((item) => {
    const ranAtMs = parseIsoDate(item.ran_at || item.created_at || item.updated_at || 0);
    if (fromMs !== null && ranAtMs < fromMs) return false;
    if (toMs !== null && ranAtMs > toMs) return false;
    if (filters.audience && String(item.audience || "").toLowerCase() !== filters.audience) return false;
    if (filters.status && String(item.status || "").toLowerCase() !== filters.status) return false;
    if (filters.template && !String(item.template || "").toLowerCase().includes(filters.template)) return false;
    return true;
  });
}

async function readCampaignHistory(options = {}) {
  const resolved = typeof options === "number" ? { limit: options } : (options || {});
  const filters = {
    limit: Math.min(500, Math.max(1, parseInt(resolved.limit || "25", 10))),
    from: resolved.from || null,
    to: resolved.to || null,
    audience: String(resolved.audience || "").trim().toLowerCase(),
    template: String(resolved.template || "").trim().toLowerCase(),
    status: String(resolved.status || "").trim().toLowerCase(),
  };
  try {
    const content = await fs.promises.readFile(CAMPAIGN_HISTORY_FILE, "utf8");
    const all = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.ran_at || 0).getTime() - new Date(a.ran_at || 0).getTime());
    const filtered = filterCampaignHistoryRecords(all, filters);
    return {
      all_count: all.length,
      filtered_count: filtered.length,
      items: filtered.slice(0, filters.limit),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { all_count: 0, filtered_count: 0, items: [] };
    }
    log(`Campaign history read warning: ${err.message}`, "WARN");
    return { all_count: 0, filtered_count: 0, items: [] };
  }
}

function buildCsvFromRows(rows) {
  const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return (rows || []).map((row) => row.map(csvEscape).join(",")).join("\n");
}

function normalizeTenantAdminPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 9) return `254${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return "";
}

function buildSimplePdfBuffer(tableRows, meta = {}) {
  const sanitize = (value) => String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");

  const title = sanitize(meta.title || "Alphadome Performance Report");
  const subtitle = sanitize(meta.subtitle || "Operational snapshot");
  const generatedAt = sanitize(meta.generated_at || new Date().toISOString());
  const columns = ["Section", "Metric", "Value"];
  const rows = Array.isArray(tableRows) ? tableRows.slice(0, 24) : [];

  const streamCommands = [];
  const pushFillRect = (x, y, w, h, r, g, b) => {
    streamCommands.push(`${r} ${g} ${b} rg`);
    streamCommands.push(`${x} ${y} ${w} ${h} re`);
    streamCommands.push("f");
  };
  const pushLine = (x1, y1, x2, y2, width = 1, r = 0.8, g = 0.84, b = 0.9) => {
    streamCommands.push(`${r} ${g} ${b} RG`);
    streamCommands.push(`${width} w`);
    streamCommands.push(`${x1} ${y1} m`);
    streamCommands.push(`${x2} ${y2} l`);
    streamCommands.push("S");
  };
  const pushText = (text, x, y, size = 10, bold = false, r = 0.08, g = 0.12, b = 0.2) => {
    streamCommands.push("BT");
    streamCommands.push(`/${bold ? "F2" : "F1"} ${size} Tf`);
    streamCommands.push(`${r} ${g} ${b} rg`);
    streamCommands.push(`1 0 0 1 ${x} ${y} Tm`);
    streamCommands.push(`(${sanitize(text)}) Tj`);
    streamCommands.push("ET");
  };

  pushFillRect(0, 730, 612, 62, 0.09, 0.2, 0.36);
  pushText(title, 42, 760, 18, true, 1, 1, 1);
  pushText(subtitle, 42, 742, 10, false, 0.86, 0.92, 1);
  pushText("ALPHADOME", 486, 760, 11, true, 0.98, 0.99, 1);
  pushText(`Generated: ${generatedAt}`, 42, 718, 9, false, 0.42, 0.49, 0.6);

  const colX = [42, 168, 346, 570];
  const rowHeight = 22;
  const tableTop = 686;
  const headerY = tableTop - rowHeight;

  pushFillRect(colX[0], headerY, colX[3] - colX[0], rowHeight, 0.16, 0.3, 0.5);
  pushText(columns[0], colX[0] + 8, headerY + 7, 10, true, 1, 1, 1);
  pushText(columns[1], colX[1] + 8, headerY + 7, 10, true, 1, 1, 1);
  pushText(columns[2], colX[2] + 8, headerY + 7, 10, true, 1, 1, 1);

  rows.forEach((row, index) => {
    const y = headerY - ((index + 1) * rowHeight);
    if (index % 2 === 0) {
      pushFillRect(colX[0], y, colX[3] - colX[0], rowHeight, 0.96, 0.97, 0.99);
    }
    pushText(String(row?.[0] || ""), colX[0] + 8, y + 7, 9.5, false, 0.14, 0.17, 0.26);
    pushText(String(row?.[1] || ""), colX[1] + 8, y + 7, 9.5, false, 0.14, 0.17, 0.26);
    pushText(String(row?.[2] || ""), colX[2] + 8, y + 7, 9.5, false, 0.14, 0.17, 0.26);
    pushLine(colX[0], y, colX[3], y, 0.8, 0.84, 0.88, 0.94);
  });

  const tableBottom = headerY - ((rows.length + 1) * rowHeight);
  pushLine(colX[0], headerY + rowHeight, colX[3], headerY + rowHeight, 1.1, 0.34, 0.45, 0.6);
  pushLine(colX[0], tableBottom, colX[3], tableBottom, 1, 0.34, 0.45, 0.6);
  colX.forEach((x, idx) => {
    const width = idx === 0 || idx === colX.length - 1 ? 1 : 0.8;
    pushLine(x, tableBottom, x, headerY + rowHeight, width, 0.34, 0.45, 0.6);
  });

  pushText("Generated by Alphadome Admin Portal", 42, 40, 9, false, 0.45, 0.5, 0.6);
  if ((Array.isArray(tableRows) ? tableRows.length : 0) > rows.length) {
    pushText("Note: Report truncated for single-page export.", 42, 26, 9, false, 0.63, 0.36, 0.09);
  }

  const stream = streamCommands.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
    `6 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }
  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

const tenantSessions = new Map();

function getTenantPhoneFromRequest(req) {
  const headerPhone = req.headers["x-tenant-phone"];
  return (
    req.query.tenant_phone ||
    req.body?.tenant_phone ||
    (typeof headerPhone === "string" ? headerPhone : "")
  );
}

function getTenantSessionToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return req.headers["x-tenant-session"] || req.query.session || "";
}

function cleanupExpiredTenantSessions() {
  const now = Date.now();
  for (const [token, session] of tenantSessions.entries()) {
    if (session.expiresAt <= now) {
      tenantSessions.delete(token);
    }
  }
}

function createTenantSession(tenant) {
  cleanupExpiredTenantSessions();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + TENANT_SESSION_TTL_MS;
  tenantSessions.set(token, {
    tenantId: tenant.id,
    tenantPhone: tenant.client_phone,
    expiresAt,
  });
  return {
    token,
    expiresAt,
  };
}

function isTenantRecordActive(tenant) {
  if (!tenant) return false;
  if (typeof tenant.is_active === "boolean") {
    return tenant.is_active;
  }
  const status = String(tenant.status || "").trim().toLowerCase();
  if (!status) return true;
  return status === "active";
}

function buildPhoneCandidates(tenantPhone) {
  const raw = String(tenantPhone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return [];

  const candidates = new Set([digits]);
  if (digits.startsWith("0") && digits.length >= 10) {
    candidates.add(`254${digits.slice(1)}`);
  }
  if (digits.startsWith("254") && digits.length >= 12) {
    candidates.add(`0${digits.slice(3)}`);
  }
  if (digits.length === 9) {
    candidates.add(`254${digits}`);
    candidates.add(`0${digits}`);
  }
  return [...candidates];
}

async function findTenantByPhone(tenantPhone, requireActive = true) {
  const candidates = buildPhoneCandidates(tenantPhone);
  if (!candidates.length) return null;

  const { data, error } = await supabase
    .from("bot_tenants")
    .select("*")
    .in("client_phone", candidates)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    throw error;
  }

  const rows = data || [];
  if (!rows.length) return null;
  if (!requireActive) return rows[0];

  return rows.find(isTenantRecordActive) || null;
}

function isMissingTableInSchemaCache(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("could not find the table") || msg.includes("schema cache");
}

async function resolveAlphadomeTenantByPhone(tenantPhone) {
  const candidates = buildPhoneCandidates(tenantPhone);
  for (const phone of candidates) {
    const { data, error } = await supabase.rpc("get_tenant_by_wa", {
      business_phone: phone,
    });
    if (error) {
      throw error;
    }
    if (data?.tenant?.id) {
      return data.tenant;
    }
  }
  return null;
}

async function deleteAlphadomeProductByTenantPhoneAndSku(tenantPhone, sku) {
  const alphaTenant = await resolveAlphadomeTenantByPhone(tenantPhone);
  if (!alphaTenant?.id) return null;

  const knownItems = await fetchCatalogForTenant(tenantPhone, sku);
  const knownItem = knownItems.find((item) => String(item.sku || "").toLowerCase() === String(sku || "").toLowerCase()) || null;
  if (!knownItem?.id) return null;

  const url = `${process.env.SB_URL}/rest/v1/bot_products?bot_tenant_id=eq.${encodeURIComponent(alphaTenant.id)}&sku=eq.${encodeURIComponent(sku)}`;
  try {
    await axios.delete(url, {
      headers: {
        apikey: process.env.SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "alphadome",
      },
    });
  } catch (err) {
    // Some PostgREST setups return 406 for DELETE when no representation is requested.
    if (err?.response?.status !== 406) {
      throw err;
    }
  }

  return { id: knownItem.id };
}

function tenantDashboardAuth(req, res, next) {
  if (!TENANT_DASHBOARD_PASS) {
    return res.status(500).send("TENANT_DASHBOARD_PASS environment variable must be set (separate from ADMIN_PASS)");
  }

  const key = req.query.key || req.headers["x-tenant-key"];
  if (key !== TENANT_DASHBOARD_PASS) {
    return res.status(401).send("Unauthorized");
  }

  next();
}

function tenantSessionAuth(req, res, next) {
  cleanupExpiredTenantSessions();

  const token = String(getTenantSessionToken(req) || "").trim();
  if (!token) {
    return res.status(401).json({ error: "Missing tenant session token" });
  }

  const session = tenantSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    tenantSessions.delete(token);
    return res.status(401).json({ error: "Tenant session expired or invalid" });
  }

  const requestPhone = String(getTenantPhoneFromRequest(req) || "").trim();
  if (requestPhone && requestPhone !== session.tenantPhone) {
    return res.status(403).json({ error: "Tenant mismatch for current session" });
  }

  req.tenantSession = session;
  next();
}

app.post("/tenant/session/login", async (req, res) => {
  try {
    const tenantPhone = String(req.body?.tenant_phone || "").trim();
    const key = req.body?.key || req.query.key;

    if (!tenantPhone || !key) {
      return res.status(400).json({ error: "tenant_phone and key are required" });
    }

    if (!TENANT_DASHBOARD_PASS || key !== TENANT_DASHBOARD_PASS) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tenant = await findTenantByPhone(tenantPhone, true);
    if (!tenant) {
      const existingTenant = await findTenantByPhone(tenantPhone, false);
      if (existingTenant) {
        return res.status(403).json({ error: "Tenant found but inactive" });
      }
      return res.status(404).json({ error: "Tenant not found for provided phone" });
    }

    const session = createTenantSession(tenant);
    return res.json({
      ok: true,
      token: session.token,
      tenant_phone: tenant.client_phone,
      tenant_name: tenant.client_name,
      expires_at: new Date(session.expiresAt).toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/tenant/session/logout", (req, res) => {
  const token = String(getTenantSessionToken(req) || "").trim();
  if (!token) {
    return res.status(400).json({ error: "Missing tenant session token" });
  }

  const revoked = tenantSessions.delete(token);
  return res.json({ ok: true, revoked });
});

// ===== TENANT TRAINING DATA/FAQ MANAGEMENT API =====
app.get("/tenant/training", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const { data, error } = await supabase
      .from("bot_training_data")
      .select("*")
      .eq("bot_tenant_id", tenantId)
      .order("priority", { ascending: false })
      .order("confidence_score", { ascending: false });

    if (error && isMissingTableInSchemaCache(error)) {
      const tenant = await resolveAlphadomeTenantByPhone(tenantPhone);
      if (!tenant?.id) {
        return res.json({ training: [] });
      }
      const { data: rpcData, error: rpcError } = await supabase.rpc("get_training_by_tenant", {
        p_tenant_id: tenant.id,
      });
      if (rpcError) return res.status(500).json({ error: rpcError.message });
      return res.json({ training: rpcData?.items || [] });
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ training: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/tenant/training", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { question, answer, category, priority, confidence_score, data_type } = req.body || {};

    if (!question || !answer) {
      return res.status(400).json({ error: "question and answer are required" });
    }

    const { data, error } = await supabase
      .from("bot_training_data")
      .insert([
        {
          bot_tenant_id: tenantId,
          data_type: data_type || "faq",
          question,
          answer,
          category: category || null,
          priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
          confidence_score: Number.isFinite(Number(confidence_score)) ? Number(confidence_score) : 1.0,
          is_active: true,
        },
      ])
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ training: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.patch("/tenant/training/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { id } = req.params;
    const updates = {
      question: req.body?.question,
      answer: req.body?.answer,
      category: req.body?.category,
      priority: Number.isFinite(Number(req.body?.priority)) ? Number(req.body.priority) : undefined,
      confidence_score: Number.isFinite(Number(req.body?.confidence_score)) ? Number(req.body.confidence_score) : undefined,
      is_active: typeof req.body?.is_active === "boolean" ? req.body.is_active : undefined,
      updated_at: new Date().toISOString(),
    };

    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    const { data, error } = await supabase
      .from("bot_training_data")
      .update(updates)
      .eq("id", id)
      .eq("bot_tenant_id", tenantId)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Training entry not found" });
    return res.json({ training: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/tenant/training/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { id } = req.params;

    const { data, error } = await supabase
      .from("bot_training_data")
      .delete()
      .eq("id", id)
      .eq("bot_tenant_id", tenantId)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Training entry not found" });
    return res.json({ ok: true, deleted_id: data.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

function normalizeCatalogItem(item = {}) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const primaryImage =
    item.primary_image ||
    item.image_url ||
    metadata.image_url ||
    null;
  const storeUrl =
    item.store_url ||
    metadata.store_url ||
    metadata.product_url ||
    metadata.url ||
    null;

  return {
    ...item,
    metadata,
    primary_image: primaryImage,
    image_url: item.image_url || primaryImage || null,
    store_url: storeUrl,
  };
}

function normalizeCatalogItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeCatalogItem(item));
}

function detectNaturalLanguageBuyIntent(text = "") {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;

  if (/^buy\s+/i.test(value)) return true;

  const intentPatterns = [
    /\b(i\s*(want|wanna|would like|need|am ready)\s*(to\s*)?(buy|purchase|order|checkout|pay))\b/i,
    /\b(can i|please|help me)\b.*\b(buy|purchase|order|checkout|pay)\b/i,
    /\b(buy|purchase|order|checkout|pay)\b.*\b(it|this|that|one)\b/i,
    /\bproceed\s+to\s+(checkout|payment|buy)\b/i,
  ];

  return intentPatterns.some((pattern) => pattern.test(value));
}

function extractSkuFromMessage(text = "") {
  const value = String(text || "").trim();
  if (!value) return null;

  const directBuy = value.match(/^buy\s+([A-Za-z0-9._-]{2,})\b/i);
  if (directBuy?.[1]) return directBuy[1];

  const skuLabel = value.match(/\bsku\s*[:\-]?\s*([A-Za-z0-9._-]{2,})\b/i);
  if (skuLabel?.[1]) return skuLabel[1];

  const actionSku = value.match(/\b(?:buy|purchase|order|checkout)\s+([A-Za-z0-9._-]{2,})\b/i);
  if (actionSku?.[1]) {
    const candidate = String(actionSku[1]).toLowerCase();
    const stopWords = new Set(["it", "this", "that", "one", "now", "please"]);
    if (!stopWords.has(candidate)) return actionSku[1];
  }

  return null;
}

// Helper: Determine attribution source from message context
function determineAttributionSource(text = "", sessionContext = {}) {
  const lowerText = text.toLowerCase();
  
  // Check for referral in context
  if (sessionContext?.referral_code) return "referral";
  
  // Check for catalog/product keywords
  if (/\b(buy|product|order|catalog|sku|price)\b/i.test(text)) return "catalog";
  
  // Check for subscription keywords
  if (/\b(subscribe|plan|level|join|membership)\b/i.test(text)) return "subscription";
  
  // Check for writer's flow keywords
  if (/(writersflow|pitch|opportunity|supply|product)/i.test(text)) return "writers_flow";
  
  // Default to organic
  return "organic";
}

async function mergeUserSessionContext(phone, patch = {}) {
  const { data: existing } = await supabase
    .from("user_sessions")
    .select("context")
    .eq("phone", phone)
    .maybeSingle();

  const existingContext = existing?.context && typeof existing.context === "object"
    ? existing.context
    : {};

  const merged = {
    ...existingContext,
    ...patch,
  };

  await supabase
    .from("user_sessions")
    .upsert({
      phone,
      context: merged,
      updated_at: new Date().toISOString(),
    });

  return merged;
}

const paymentReminderTimers = new Map();

function scheduleUniqueReminder(key, delayMs, task) {
  const existingTimer = paymentReminderTimers.get(key);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(async () => {
    paymentReminderTimers.delete(key);
    try {
      await task();
    } catch (err) {
      log(`Reminder task failed [${key}]: ${err.message}`, "ERROR");
    }
  }, delayMs);

  paymentReminderTimers.set(key, timer);
}

function schedulePendingPaymentReminder({ waPhone, checkoutId, amount, planType, level }) {
  if (!waPhone || !checkoutId) return;

  const key = `pending:${checkoutId}`;
  scheduleUniqueReminder(key, 10 * 60 * 1000, async () => {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status")
      .eq("mpesa_checkout_request_id", checkoutId)
      .limit(1)
      .maybeSingle();

    if (!sub || sub.status !== "pending") return;

    await sendMessage(
      waPhone,
      `⏰ Quick reminder: your *${String(planType || "plan").toUpperCase()}${level ? ` Level ${level}` : ""}* payment (KES ${amount}) is still pending.\n\nIf the M-Pesa prompt expired, reply *RETRY*. If it refunded, reply *BANK* or *COD* and we'll complete your order.`
    );

    await mergeUserSessionContext(waPhone, {
      pending_payment_reminder_sent_at: new Date().toISOString(),
      pending_payment_checkout_id: checkoutId,
    });

    log(`PENDING_PAYMENT_REMINDER_SENT checkout=${checkoutId} wa=${waPhone}`, "PAYMENT");
  });
}

function scheduleFallbackReminder({ waPhone, subscriptionId, amount, planType, level }) {
  if (!waPhone || !subscriptionId) return;

  const key = `fallback:${subscriptionId}`;
  scheduleUniqueReminder(key, 10 * 60 * 1000, async () => {
    const [{ data: sub }, { data: sess }] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("status")
        .eq("id", subscriptionId)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("user_sessions")
        .select("context")
        .eq("phone", waPhone)
        .maybeSingle(),
    ]);

    if (!sub || sub.status !== "failed") return;

    const ctx = sess?.context && typeof sess.context === "object" ? sess.context : {};
    const hasSelectedMethod = Boolean(ctx.selected_fallback_method || ctx.bank_receipt_verified || ctx.cod_address_confirmed);
    if (hasSelectedMethod) return;

    await sendMessage(
      waPhone,
      `⏰ Friendly follow-up: we can still complete your *${String(planType || "plan").toUpperCase()}${level ? ` Level ${level}` : ""}* payment (KES ${amount}).\n\nReply *RETRY* for a new STK push, *BANK* for transfer details, or *COD* to pay on delivery.`
    );

    await mergeUserSessionContext(waPhone, {
      fallback_followup_sent_at: new Date().toISOString(),
      fallback_followup_subscription_id: subscriptionId,
    });

    log(`FALLBACK_REMINDER_SENT subscription=${subscriptionId} wa=${waPhone}`, "PAYMENT");
  });
}

// ===== TENANT CATALOG API =====
app.get("/tenant/catalog", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const q = String(req.query.q || "").trim();
    let query = supabase
      .from("bot_products")
      .select("*")
      .eq("bot_tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (q) {
      const needle = `%${q}%`;
      query = query.or(`sku.ilike.${needle},name.ilike.${needle},description.ilike.${needle}`);
    }

    const { data, error } = await query;
    if (error && isMissingTableInSchemaCache(error)) {
      const { data: rpcData, error: rpcError } = await supabase.rpc("get_catalog", {
        tenant_phone: tenantPhone,
        q: q || null,
      });
      if (rpcError) return res.status(500).json({ error: rpcError.message });
      return res.json({ items: normalizeCatalogItems(rpcData?.items || []) });
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: normalizeCatalogItems(data || []) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/tenant/catalog", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const payload = req.body || {};
    const sku = String(payload.sku || "").trim() || generateSku(payload.name || "ITEM", "TEN");
    const name = String(payload.name || "").trim();

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const rawMetadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const metadata = {
      ...rawMetadata,
      ...(payload.store_url !== undefined ? { store_url: payload.store_url || null } : {}),
    };

    const entity = {
      bot_tenant_id: tenantId,
      sku,
      name,
      description: payload.description || null,
      price: Number.isFinite(Number(payload.price)) ? Number(payload.price) : null,
      currency: payload.currency || "KES",
      stock_count: Number.isFinite(Number(payload.stock_count)) ? Number(payload.stock_count) : 0,
      image_url: payload.image_url || null,
      metadata,
      is_active: payload.is_active !== false,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("bot_products")
      .select("id")
      .eq("bot_tenant_id", tenantId)
      .eq("sku", sku)
      .limit(1)
      .maybeSingle();

    const query = existing
      ? supabase.from("bot_products").update(entity).eq("id", existing.id)
      : supabase.from("bot_products").insert([{ ...entity, created_at: new Date().toISOString() }]);

    const { data, error } = await query.select("*").maybeSingle();
    if (error && isMissingTableInSchemaCache(error)) {
      const rpcPayload = {
        products: [
          {
            sku,
            name,
            description: payload.description || null,
            price: Number.isFinite(Number(payload.price)) ? Number(payload.price) : null,
            currency: payload.currency || "KES",
            stock_count: Number.isFinite(Number(payload.stock_count)) ? Number(payload.stock_count) : 0,
            image_url: payload.image_url || null,
            metadata,
          },
        ],
      };
      const { error: rpcError } = await supabase.rpc("seed_portfolio", {
        tenant_phone: tenantPhone,
        payload: rpcPayload,
      });
      if (rpcError) return res.status(500).json({ error: rpcError.message });

      const refreshed = await fetchCatalogForTenant(tenantPhone, sku);
      const saved = refreshed.find((item) => String(item.sku || "").toLowerCase() === sku.toLowerCase()) || refreshed[0] || null;
      return res.json({ item: normalizeCatalogItem(saved || {}), mode: existing ? "updated" : "created" });
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ item: normalizeCatalogItem(data || {}), mode: existing ? "updated" : "created" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/tenant/catalog", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const sku = String(req.query.sku || "").trim();

    if (!sku) {
      return res.status(400).json({ error: "sku is required" });
    }

    const { data, error } = await supabase
      .from("bot_products")
      .delete()
      .eq("bot_tenant_id", tenantId)
      .eq("sku", sku)
      .select("id")
      .maybeSingle();

    if (error && isMissingTableInSchemaCache(error)) {
      const deleted = await deleteAlphadomeProductByTenantPhoneAndSku(tenantPhone, sku);
      if (!deleted) return res.status(404).json({ error: "Product not found" });
      return res.json({ ok: true, deleted_id: deleted.id });
    }
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Product not found" });
    return res.json({ ok: true, deleted_id: data.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/suppliers — supplier/vendor rollup from product metadata
app.get("/tenant/suppliers", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data, error } = await supabase
      .from("bot_products")
      .select("sku, name, stock_count, is_active, metadata")
      .eq("bot_tenant_id", tenantId);

    if (error) return res.status(500).json({ error: error.message });

    const bySupplier = {};
    (data || []).forEach((item) => {
      const md = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const supplierName = String(md.supplier_name || md.vendor_name || "Unassigned").trim() || "Unassigned";
      const supplierId = String(md.supplier_id || md.vendor_id || "").trim();
      const supplierContact = String(md.supplier_contact || md.vendor_contact || "").trim();
      const key = `${supplierName.toLowerCase()}::${supplierId.toLowerCase()}`;
      if (!bySupplier[key]) {
        bySupplier[key] = {
          supplier_name: supplierName,
          supplier_id: supplierId || null,
          supplier_contact: supplierContact || null,
          products_count: 0,
          active_products: 0,
          low_stock_products: 0,
          sample_products: [],
        };
      }
      bySupplier[key].products_count += 1;
      if (item.is_active !== false) bySupplier[key].active_products += 1;
      if (Number(item.stock_count || 0) > 0 && Number(item.stock_count || 0) <= 5) bySupplier[key].low_stock_products += 1;
      if (bySupplier[key].sample_products.length < 5) {
        bySupplier[key].sample_products.push({ sku: item.sku, name: item.name, stock_count: item.stock_count || 0 });
      }
    });

    const suppliers = Object.values(bySupplier).sort((a, b) => b.products_count - a.products_count);
    return res.json({ suppliers, total_products: (data || []).length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT ORDERS API =====
app.get("/tenant/orders", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data, error } = await supabase
      .from("bot_orders")
      .select("*")
      .eq("bot_tenant_id", tenantId)
      .order("created_at", { ascending: false });

    if (error && isMissingTableInSchemaCache(error)) {
      // Orders RPC is not available in this deployment yet; keep dashboard usable.
      return res.json({ orders: [] });
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ orders: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/tenant/orders", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { customer_name, customer_phone, order_items, total_amount, currency, status, notes } = req.body || {};

    if (!Array.isArray(order_items) || !order_items.length) {
      return res.status(400).json({ error: "order_items must be a non-empty array" });
    }

    if (!Number.isFinite(Number(total_amount))) {
      return res.status(400).json({ error: "total_amount must be numeric" });
    }

    const { data, error } = await supabase
      .from("bot_orders")
      .insert([
        {
          bot_tenant_id: tenantId,
          customer_name: customer_name || null,
          customer_phone: customer_phone || null,
          order_items,
          total_amount: Number(total_amount),
          currency: currency || "KES",
          status: status || "pending",
          notes: notes || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ order: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.patch("/tenant/orders/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { id } = req.params;
    const updates = {
      status: req.body?.status,
      notes: req.body?.notes,
      updated_at: new Date().toISOString(),
    };

    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    const { data, error } = await supabase
      .from("bot_orders")
      .update(updates)
      .eq("id", id)
      .eq("bot_tenant_id", tenantId)
      .select("*")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Order not found" });
    return res.json({ order: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete("/tenant/orders/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { id } = req.params;

    const { data, error } = await supabase
      .from("bot_orders")
      .delete()
      .eq("id", id)
      .eq("bot_tenant_id", tenantId)
      .select("id")
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Order not found" });
    return res.json({ ok: true, deleted_id: data.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== HELPER: Write to alphadome.bot_tenants via PostgREST schema header =====
async function updateAlphadomeTenantByPhone(tenantPhone, updates) {
  const candidates = buildPhoneCandidates(tenantPhone);
  if (!candidates.length) return [];
  console.log('[updateAlphadomeTenantByPhone] candidates:', candidates);
  for (const phone of candidates) {
    const urlSafe = encodeURIComponent(phone);
    const url = `${process.env.SB_URL}/rest/v1/bot_tenants?client_phone=eq.${urlSafe}`;
    try {
      console.log(`[updateAlphadomeTenantByPhone] PATCH url: ${url}`);
      const response = await axios.patch(url, updates, {
        headers: {
          apikey: process.env.SB_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Content-Profile": "public",
          Prefer: "return=representation",
        },
      });
      console.log(`[updateAlphadomeTenantByPhone] PATCH status: ${response.status}, data:`, response.data);
      // Always fetch the tenant after PATCH, treat existence as success
      const { data: check, error: fetchError } = await supabase
        .from("bot_tenants")
        .select("id, client_name, client_phone, status, updated_at")
        .eq("client_phone", phone)
        .limit(1);
      console.log(`[updateAlphadomeTenantByPhone] Fetch after PATCH for phone ${phone}:`, check, fetchError);
      if (Array.isArray(check) && check.length) return check;
    } catch (err) {
      console.error(`[updateAlphadomeTenantByPhone] Error for phone ${phone}:`, err?.response?.data || err.message);
      if (err.response?.status !== 404 && err.response?.status !== 406) throw err;
    }
  }
  console.warn('[updateAlphadomeTenantByPhone] No tenant updated for candidates:', candidates);
  return [];
}

// ===== TENANT BROADCAST API =====

// HELPER: Apply segment filters to user list
async function filterUsersBySegment(userIds, brandId, tenantId, segment = "all") {
  let filtered = userIds;
  if (segment === "have_purchased") {
    const { data: purchasers } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .in("status", ["completed", "active"]);
    const purchaserIds = new Set((purchasers || []).map((p) => p.user_id).filter(Boolean));
    filtered = filtered.filter((uid) => purchaserIds.has(uid));
  } else if (segment === "inactive_30plus") {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: activeUsers } = await supabase
      .from("conversations")
      .select("user_id")
      .eq("brand_id", brandId)
      .gte("created_at", thirtyDaysAgo);
    const activeIds = new Set((activeUsers || []).map((u) => u.user_id).filter(Boolean));
    filtered = filtered.filter((uid) => !activeIds.has(uid)); // Exclude active, keep inactive
  } else if (segment === "high_value") {
    const { data: highSpenders } = await supabase
      .from("subscriptions")
      .select("user_id, amount")
      .eq("tenant_id", tenantId)
      .in("status", ["completed", "active"]);
    const userTotals = {};
    (highSpenders || []).forEach((s) => {
      if (s.user_id) userTotals[s.user_id] = (userTotals[s.user_id] || 0) + parseFloat(s.amount || 0);
    });
    filtered = filtered.filter((uid) => (userTotals[uid] || 0) >= 1000);
  } else if (segment === "first_time") {
    const { data: purchasers } = await supabase
      .from("subscriptions")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .in("status", ["completed", "active"]);
    const purchaserIds = new Set((purchasers || []).map((p) => p.user_id).filter(Boolean));
    filtered = filtered.filter((uid) => !purchaserIds.has(uid)); // Exclude buyers, keep non-buyers
  }
  return filtered;
}

// GET /tenant/broadcast/audience — returns count + sample of reachable users with segment filter
app.get("/tenant/broadcast/audience", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const segment = req.query.segment || "all"; // all, have_purchased, inactive_30plus, high_value, first_time

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id || null;
    if (!brandId) return res.json({ count: 0, users: [], warning: "Brand ID not linked yet." });

    const windowHours = parseInt(req.query.window_hours || "168", 10); // default 7 days
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    // Get distinct user_ids from inbound conversations within window
    const { data: convRows, error: convErr } = await supabase
      .from("conversations")
      .select("user_id")
      .eq("brand_id", brandId)
      .eq("direction", "incoming")
      .gte("created_at", since);

    if (convErr) return res.status(500).json({ error: convErr.message });

    let distinctUserIds = [...new Set((convRows || []).map((r) => r.user_id).filter(Boolean))];
    if (!distinctUserIds.length) return res.json({ count: 0, users: [], segment });

    // Apply segment filter
    distinctUserIds = await filterUsersBySegment(distinctUserIds, brandId, tenantId, segment);
    if (!distinctUserIds.length) return res.json({ count: 0, users: [], segment, message: "No users match this segment." });

    // Cap at 500 per send for safety
    const cappedIds = distinctUserIds.slice(0, 500);

    const { data: userRows, error: userErr } = await supabase
      .from("users")
      .select("id, phone, full_name")
      .in("id", cappedIds);

    if (userErr) return res.status(500).json({ error: userErr.message });

    const users = (userRows || []).filter((u) => u.phone);
    return res.json({
      count: users.length,
      segment,
      capped: distinctUserIds.length > 500,
      users: users.slice(0, 5).map((u) => ({ phone: u.phone, name: u.full_name || "User" })),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /tenant/broadcast — sends a WhatsApp message to segmented users
app.post("/tenant/broadcast", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { message, window_hours = 168, segment = "all" } = req.body || {};

    if (!message || String(message).trim().length < 3) {
      return res.status(400).json({ error: "Message must be at least 3 characters." });
    }
    if (String(message).trim().length > 1024) {
      return res.status(400).json({ error: "Message exceeds 1024 character limit." });
    }

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id, metadata, whatsapp_access_token, whatsapp_phone_number_id, ai_api_key, ai_provider, ai_model")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id || null;
    if (!brandId) return res.status(400).json({ error: "Brand ID not linked. Cannot send broadcast." });

    const windowMs = Math.min(parseInt(window_hours, 10), 720) * 60 * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();

    const { data: convRows } = await supabase
      .from("conversations")
      .select("user_id")
      .eq("brand_id", brandId)
      .eq("direction", "incoming")
      .gte("created_at", since);

    let distinctUserIds = [...new Set((convRows || []).map((r) => r.user_id).filter(Boolean))].slice(0, 500);
    
    // Apply segment filter
    distinctUserIds = await filterUsersBySegment(distinctUserIds, brandId, tenantId, segment);
    
    if (!distinctUserIds.length) return res.json({ sent: 0, failed: 0, message: "No users match this segment in the selected window." });

    const { data: userRows } = await supabase
      .from("users")
      .select("id, phone")
      .in("id", distinctUserIds);

    const phones = (userRows || []).map((u) => u.phone).filter(Boolean);
    if (!phones.length) return res.json({ sent: 0, failed: 0, message: "No valid phone numbers found." });

    const creds = getDecryptedCredentials(pubTenant);
    const safeMsg = String(message).trim();

    let sent = 0;
    let failed = 0;

    for (const phone of phones) {
      try {
        await sendMessage(phone, safeMsg, creds);
        sent++;
      } catch (sendErr) {
        log(`Broadcast send failed to ${phone}: ${sendErr.message}`, "WARN");
        failed++;
      }
      // 350ms gap between messages — conservative rate limit
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    // Store last 20 broadcast records in tenant metadata
    const existing = pubTenant?.metadata || {};
    const history = Array.isArray(existing.broadcast_history) ? existing.broadcast_history : [];
    history.unshift({
      sent_at: new Date().toISOString(),
      message: safeMsg.slice(0, 120) + (safeMsg.length > 120 ? "…" : ""),
      total: sent + failed,
      sent,
      failed,
      window_hours: parseInt(window_hours, 10),
      segment,
    });
    const trimmedHistory = history.slice(0, 20);
    await supabase
      .from("bot_tenants")
      .update({ metadata: { ...existing, broadcast_history: trimmedHistory }, updated_at: new Date().toISOString() })
      .eq("id", tenantId);

    log(`Broadcast by tenant ${tenantId} (segment: ${segment}): ${sent} sent, ${failed} failed`, "SYSTEM");
    return res.json({ sent, failed, total: sent + failed, segment });
  } catch (error) {
    log(`Broadcast error: ${error.message}`, "ERROR");
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/broadcast/history — returns past broadcast records
app.get("/tenant/broadcast/history", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("metadata")
      .eq("id", tenantId)
      .maybeSingle();
    const history = pubTenant?.metadata?.broadcast_history || [];
    return res.json({ history });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/abandoned-carts — find users who viewed product but didn't buy in last 24h
app.get("/tenant/abandoned-carts", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get user sessions with last_selected_sku in the last 24h
    const { data: sessions } = await supabase
      .from("user_sessions")
      .select("phone, context")
      .eq("tenant_id", tenantId)
      .gte("updated_at", since24h);

    const abandoned = [];
    const seen = new Set();

    for (const session of sessions || []) {
      const context = session.context || {};
      const sku = context.last_selected_sku;
      const phone = session.phone;

      if (!sku || !phone) continue;
      const key = `${phone}:${sku}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Check if this user bought this sku
      const { data: purchases } = await supabase
        .from("subscriptions")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("user_id", phone) // Assuming user_id can be phone
        .eq("product_sku", sku)
        .in("status", ["completed", "active"])
        .limit(1);

      if (!purchases || purchases.length === 0) {
        // Not purchased — user abandoned this product
        // Get product name by sku
        const { data: product } = await supabase
          .from("bot_products")
          .select("name, price")
          .eq("sku", sku)
          .eq("tenant_id", tenantId)
          .maybeSingle();

        abandoned.push({
          phone,
          sku,
          product_name: product?.name || sku,
          price: product?.price || null,
          last_viewed: session.updated_at,
        });
      }
    }

    // Cap at 100 for performance
    res.json({ carts: abandoned.slice(0, 100), total: abandoned.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /tenant/abandoned-cart-recovery — send recovery message to specific user for abandoned product
app.post("/tenant/abandoned-cart-recovery", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { phone, sku, message } = req.body;

    if (!phone || !sku || !message || String(message).trim().length < 3) {
      return res.status(400).json({ error: "phone, sku, and message (3+ chars) are required" });
    }

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("whatsapp_access_token, whatsapp_phone_number_id")
      .eq("id", tenantId)
      .maybeSingle();

    if (!pubTenant?.whatsapp_access_token) {
      return res.status(400).json({ error: "WhatsApp not configured" });
    }

    const creds = getDecryptedCredentials(pubTenant);
    const safeMsg = String(message).trim().slice(0, 1024);

    try {
      await sendMessage(phone, safeMsg, creds);
      log(`Abandoned cart recovery sent to ${phone} for SKU ${sku}`, "SYSTEM");
      return res.json({ success: true, message: `Message sent to ${phone}` });
    } catch (sendErr) {
      return res.status(502).json({ error: `Send failed: ${sendErr.message}` });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== CUSTOMER INTELLIGENCE APIS =====

// GET /tenant/customers — customer directory with search/filter
app.get("/tenant/customers", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const search = String(req.query.search || "").trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id;
    if (!brandId) return res.json({ customers: [] });

    // Get all users who have chatted with this brand
    const { data: convRows } = await supabase
      .from("conversations")
      .select("user_id, created_at")
      .eq("brand_id", brandId)
      .eq("direction", "incoming")
      .order("created_at", { ascending: false });

    const userLastSeen = {};
    const userMsgCount = {};
    (convRows || []).forEach((c) => {
      if (!userLastSeen[c.user_id]) userLastSeen[c.user_id] = c.created_at;
      userMsgCount[c.user_id] = (userMsgCount[c.user_id] || 0) + 1;
    });

    const allUserIds = Object.keys(userLastSeen);
    if (!allUserIds.length) return res.json({ customers: [] });

    const { data: userRows } = await supabase
      .from("users")
      .select("id, phone, full_name, email")
      .in("id", allUserIds);

    // Get purchase counts
    const { data: subRows } = await supabase
      .from("subscriptions")
      .select("user_id, amount, status")
      .eq("tenant_id", tenantId);

    const userPurchaseCount = {};
    const userSpend = {};
    (subRows || []).filter((s) => s.status === "completed" || s.status === "active").forEach((s) => {
      if (s.user_id) {
        userPurchaseCount[s.user_id] = (userPurchaseCount[s.user_id] || 0) + 1;
        userSpend[s.user_id] = (userSpend[s.user_id] || 0) + parseFloat(s.amount || 0);
      }
    });

    let customers = (userRows || []).map((u) => ({
      id: u.id,
      phone: u.phone,
      name: u.full_name || u.phone || "Unknown",
      email: u.email || null,
      messages: userMsgCount[u.id] || 0,
      purchases: userPurchaseCount[u.id] || 0,
      total_spent: Math.round((userSpend[u.id] || 0) * 100) / 100,
      last_seen: userLastSeen[u.id] || null,
    }));

    // Apply search
    if (search) {
      customers = customers.filter(
        (c) =>
          c.name.toLowerCase().includes(search) ||
          (c.phone || "").includes(search) ||
          (c.email || "").toLowerCase().includes(search)
      );
    }

    customers.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));

    return res.json({ customers: customers.slice(0, limit), total: customers.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/customers/:phone — Customer 360 view: full conversation + purchase history
app.get("/tenant/customers/:phone", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = decodeURIComponent(req.params.phone);

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id;

    // Get user record
    const { data: user } = await supabase
      .from("users")
      .select("id, phone, full_name, email, created_at")
      .eq("phone", phone)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: "Customer not found" });

    // Get conversation history
    const { data: conversations } = await supabase
      .from("conversations")
      .select("id, message, direction, created_at, llm_used")
      .eq("brand_id", brandId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    // Get purchase history
    const { data: purchases } = await supabase
      .from("subscriptions")
      .select("id, amount, product_sku, plan_type, status, created_at, mpesa_receipt_no")
      .eq("tenant_id", tenantId)
      .in("user_id", [user.id, phone])
      .order("created_at", { ascending: false });

    // Get session context
    const { data: session } = await supabase
      .from("user_sessions")
      .select("context, updated_at")
      .eq("phone", phone)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const totalSpent = (purchases || [])
      .filter((p) => p.status === "completed" || p.status === "active")
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    return res.json({
      customer: {
        id: user.id,
        phone: user.phone,
        name: user.full_name || "Unknown",
        email: user.email,
        joined: user.created_at,
        total_spent: Math.round(totalSpent * 100) / 100,
        purchase_count: (purchases || []).filter((p) => p.status === "completed" || p.status === "active").length,
        last_session: session?.context || {},
        last_active: session?.updated_at || null,
      },
      conversations: (conversations || []).map((c) => ({
        id: c.id,
        text: c.message,
        direction: c.direction,
        time: c.created_at,
        ai: c.llm_used || false,
      })),
      purchases: purchases || [],
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/conversations/search — full-text search across all conversations
app.get("/tenant/conversations/search", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ results: [] });

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id;
    if (!brandId) return res.json({ results: [] });

    const { data: convRows } = await supabase
      .from("conversations")
      .select("id, message, direction, user_id, created_at")
      .eq("brand_id", brandId)
      .ilike("message", `%${q}%`)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!convRows || !convRows.length) return res.json({ results: [] });

    const userIds = [...new Set(convRows.map((c) => c.user_id).filter(Boolean))];
    const { data: userRows } = await supabase
      .from("users")
      .select("id, phone, full_name")
      .in("id", userIds);

    const userMap = {};
    (userRows || []).forEach((u) => (userMap[u.id] = u));

    const results = convRows.map((c) => {
      const user = userMap[c.user_id] || {};
      return {
        id: c.id,
        message: c.message,
        direction: c.direction,
        time: c.created_at,
        phone: user.phone || "Unknown",
        name: user.full_name || user.phone || "Unknown",
        user_id: c.user_id,
      };
    });

    return res.json({ results, query: q });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/preferences — customer opt-ins and preference profile
app.get("/tenant/preferences", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const q = String(req.query.q || "").trim().toLowerCase();

    const { data: tenantRow } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = tenantRow?.brand_id;
    if (!brandId) return res.json({ customers: [] });

    const { data: convRows } = await supabase
      .from("conversations")
      .select("user_id, created_at")
      .eq("brand_id", brandId)
      .eq("direction", "incoming")
      .order("created_at", { ascending: false })
      .limit(1000);

    const seen = new Map();
    (convRows || []).forEach((row) => {
      if (!row?.user_id || seen.has(row.user_id)) return;
      seen.set(row.user_id, row.created_at);
    });
    const userIds = [...seen.keys()];
    if (!userIds.length) return res.json({ customers: [] });

    const { data: users } = await supabase
      .from("users")
      .select("id, phone, full_name, email")
      .in("id", userIds);

    const phones = (users || []).map((u) => u.phone).filter(Boolean);
    const { data: sessions } = phones.length
      ? await supabase
          .from("user_sessions")
          .select("phone, context, updated_at")
          .eq("tenant_id", tenantId)
          .in("phone", phones)
      : { data: [] };

    const sessionMap = new Map((sessions || []).map((s) => [s.phone, s]));
    let customers = (users || []).map((u) => {
      const s = sessionMap.get(u.phone) || {};
      const ctx = s.context && typeof s.context === "object" ? s.context : {};
      return {
        phone: u.phone,
        name: u.full_name || u.phone || "Unknown",
        email: u.email || null,
        marketing_opt_in: ctx.marketing_opt_in !== false,
        do_not_disturb: ctx.do_not_disturb === true,
        preferred_language: ctx.preferred_language || null,
        preferred_categories: Array.isArray(ctx.preferred_categories) ? ctx.preferred_categories.slice(0, 10) : [],
        updated_at: s.updated_at || null,
      };
    });

    if (q) {
      customers = customers.filter((c) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      );
    }

    return res.json({ customers });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /tenant/preferences/:phone
app.patch("/tenant/preferences/:phone", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = decodeURIComponent(req.params.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const { data: existing } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle();

    const context = existing?.context && typeof existing.context === "object" ? existing.context : {};
    const preferredCategories = Array.isArray(req.body?.preferred_categories)
      ? req.body.preferred_categories.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 10)
      : context.preferred_categories || [];

    const nextContext = {
      ...context,
      marketing_opt_in: req.body?.marketing_opt_in !== undefined ? Boolean(req.body.marketing_opt_in) : context.marketing_opt_in !== false,
      do_not_disturb: req.body?.do_not_disturb !== undefined ? Boolean(req.body.do_not_disturb) : context.do_not_disturb === true,
      preferred_language: req.body?.preferred_language !== undefined ? String(req.body.preferred_language || "").trim().slice(0, 20) || null : context.preferred_language || null,
      preferred_categories: preferredCategories,
    };

    const { error } = await supabase
      .from("user_sessions")
      .upsert({ phone, tenant_id: tenantId, context: nextContext, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, preferences: nextContext });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/favorites — favorite SKUs grouped by customer
app.get("/tenant/favorites", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: sessions, error } = await supabase
      .from("user_sessions")
      .select("phone, context, updated_at")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (error) return res.status(500).json({ error: error.message });

    const allSkus = new Set();
    const byCustomer = (sessions || []).map((s) => {
      const ctx = s.context && typeof s.context === "object" ? s.context : {};
      const favorites = Array.isArray(ctx.favorite_skus) ? ctx.favorite_skus.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 30) : [];
      favorites.forEach((sku) => allSkus.add(sku));
      return { phone: s.phone, favorite_skus: favorites, updated_at: s.updated_at };
    }).filter((row) => row.favorite_skus.length > 0);

    const skuList = [...allSkus];
    const { data: products } = skuList.length
      ? await supabase
          .from("bot_products")
          .select("sku, name, price, currency")
          .eq("bot_tenant_id", tenantId)
          .in("sku", skuList)
      : { data: [] };

    const productMap = new Map((products || []).map((p) => [p.sku, p]));
    const skuCount = {};
    byCustomer.forEach((c) => c.favorite_skus.forEach((sku) => { skuCount[sku] = (skuCount[sku] || 0) + 1; }));

    const topFavorites = Object.entries(skuCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([sku, count]) => ({ sku, count, product: productMap.get(sku) || null }));

    const customers = byCustomer.map((c) => ({
      ...c,
      favorites: c.favorite_skus.map((sku) => ({ sku, product: productMap.get(sku) || null })),
    }));

    return res.json({ customers, top_favorites: topFavorites });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /tenant/favorites/:phone — add favorite sku
app.post("/tenant/favorites/:phone", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = decodeURIComponent(req.params.phone || "").trim();
    const sku = String(req.body?.sku || "").trim();
    if (!phone || !sku) return res.status(400).json({ error: "phone and sku are required" });

    const { data: product } = await supabase
      .from("bot_products")
      .select("sku")
      .eq("bot_tenant_id", tenantId)
      .eq("sku", sku)
      .maybeSingle();
    if (!product) return res.status(404).json({ error: "SKU not found" });

    const { data: existing } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle();
    const ctx = existing?.context && typeof existing.context === "object" ? existing.context : {};
    const favoriteSet = new Set(Array.isArray(ctx.favorite_skus) ? ctx.favorite_skus : []);
    favoriteSet.add(sku);

    const nextContext = { ...ctx, favorite_skus: [...favoriteSet].slice(0, 50) };
    const { error } = await supabase
      .from("user_sessions")
      .upsert({ phone, tenant_id: tenantId, context: nextContext, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, favorite_skus: nextContext.favorite_skus });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /tenant/favorites/:phone/:sku
app.delete("/tenant/favorites/:phone/:sku", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = decodeURIComponent(req.params.phone || "").trim();
    const sku = decodeURIComponent(req.params.sku || "").trim();
    if (!phone || !sku) return res.status(400).json({ error: "phone and sku are required" });

    const { data: existing } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle();
    const ctx = existing?.context && typeof existing.context === "object" ? existing.context : {};
    const next = Array.isArray(ctx.favorite_skus) ? ctx.favorite_skus.filter((v) => String(v) !== sku) : [];
    const nextContext = { ...ctx, favorite_skus: next };

    const { error } = await supabase
      .from("user_sessions")
      .upsert({ phone, tenant_id: tenantId, context: nextContext, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, favorite_skus: next });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/referrals — summary of referral code usage and pipeline
app.get("/tenant/referrals", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;

    const [{ data: subs }, { data: sessions }] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("id, user_id, amount, status, created_at, metadata")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("user_sessions")
        .select("phone, context, updated_at")
        .eq("tenant_id", tenantId)
        .order("updated_at", { ascending: false })
        .limit(1000),
    ]);

    const codeStats = {};
    (subs || []).forEach((s) => {
      const md = s?.metadata && typeof s.metadata === "object" ? s.metadata : {};
      const code = String(md.referral_code || md.ref_code || "").trim().toUpperCase();
      if (!code) return;
      if (!codeStats[code]) {
        codeStats[code] = {
          referral_code: code,
          attributed_sales: 0,
          attributed_revenue: 0,
          completed_sales: 0,
          last_seen: null,
        };
      }
      codeStats[code].attributed_sales += 1;
      if (s.status === "completed" || s.status === "active") {
        codeStats[code].completed_sales += 1;
        codeStats[code].attributed_revenue += Number(s.amount || 0);
      }
      if (!codeStats[code].last_seen || new Date(s.created_at) > new Date(codeStats[code].last_seen)) {
        codeStats[code].last_seen = s.created_at;
      }
    });

    const leads = (sessions || []).map((s) => {
      const ctx = s.context && typeof s.context === "object" ? s.context : {};
      if (!ctx.referral_code) return null;
      return {
        phone: s.phone,
        referral_code: String(ctx.referral_code || "").toUpperCase(),
        referrer_phone: ctx.referrer_phone || null,
        captured_at: ctx.referral_captured_at || s.updated_at,
      };
    }).filter(Boolean);

    const codes = Object.values(codeStats).sort((a, b) => b.attributed_sales - a.attributed_sales);
    return res.json({
      totals: {
        referral_codes_used: codes.length,
        attributed_sales: codes.reduce((sum, c) => sum + c.attributed_sales, 0),
        attributed_revenue: Math.round(codes.reduce((sum, c) => sum + c.attributed_revenue, 0) * 100) / 100,
        pending_leads: leads.length,
      },
      codes,
      leads: leads.slice(0, 200),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /tenant/referrals/track — set referral context for a phone
app.post("/tenant/referrals/track", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = String(req.body?.phone || "").trim();
    const referralCode = String(req.body?.referral_code || "").trim().toUpperCase();
    const referrerPhone = String(req.body?.referrer_phone || "").trim() || null;
    if (!phone || !referralCode) return res.status(400).json({ error: "phone and referral_code are required" });

    const { data: existing } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle();
    const ctx = existing?.context && typeof existing.context === "object" ? existing.context : {};
    const nextContext = {
      ...ctx,
      referral_code: referralCode,
      referrer_phone: referrerPhone,
      referral_captured_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("user_sessions")
      .upsert({ phone, tenant_id: tenantId, context: nextContext, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, referral_code: referralCode });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/products/performance — product conversion metrics
app.get("/tenant/products/performance", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const brandId = pubTenant?.brand_id;

    // Get products
    const { data: products } = await supabase
      .from("bot_products")
      .select("sku, name, price, stock_quantity, is_available")
      .eq("tenant_id", tenantId)
      .eq("is_available", true);

    // Get sessions to count SKU views
    const { data: sessions } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("tenant_id", tenantId)
      .gte("updated_at", since30d);

    const skuViews = {};
    (sessions || []).forEach((s) => {
      const sku = s.context?.last_selected_sku;
      if (sku) skuViews[sku] = (skuViews[sku] || 0) + 1;
    });

    // Get conversions from subscriptions
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("product_sku, amount, status")
      .eq("tenant_id", tenantId)
      .gte("created_at", since30d);

    const skuRevenue = {};
    const skuConversions = {};
    (subs || []).filter((s) => s.status === "completed" || s.status === "active").forEach((s) => {
      const sku = s.product_sku;
      if (sku) {
        skuRevenue[sku] = (skuRevenue[sku] || 0) + parseFloat(s.amount || 0);
        skuConversions[sku] = (skuConversions[sku] || 0) + 1;
      }
    });

    const performance = (products || []).map((p) => {
      const views = skuViews[p.sku] || 0;
      const conversions = skuConversions[p.sku] || 0;
      const revenue = skuRevenue[p.sku] || 0;
      const convRate = views > 0 ? Math.round((conversions / views) * 100) : 0;

      return {
        sku: p.sku,
        name: p.name,
        price: p.price,
        stock: p.stock_quantity ?? null,
        low_stock: p.stock_quantity !== null && p.stock_quantity <= 5,
        views,
        conversions,
        revenue: Math.round(revenue * 100) / 100,
        conversion_rate: convRate,
      };
    });

    performance.sort((a, b) => b.revenue - a.revenue);
    return res.json({ performance, period: "30 days" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT PROFILE API =====

app.get("/tenant/profile", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const { data: pubTenant, error: pubErr } = await supabase
      .from("bot_tenants")
      .select("id, client_name, client_phone, description, brand_id, status, point_of_contact_name, point_of_contact_phone, metadata, created_at")
      .eq("id", tenantId)
      .maybeSingle();
    if (pubErr) return res.status(500).json({ error: pubErr.message });
    const alpha = await resolveAlphadomeTenantByPhone(tenantPhone);
    return res.json({
      profile: {
        client_name: alpha?.client_name || pubTenant?.client_name || "",
        client_phone: alpha?.client_phone || pubTenant?.client_phone || tenantPhone,
        client_email: alpha?.client_email || "",
        point_of_contact_name: alpha?.point_of_contact_name || pubTenant?.point_of_contact_name || "",
        point_of_contact_phone: alpha?.point_of_contact_phone || pubTenant?.point_of_contact_phone || "",
        description: pubTenant?.description || alpha?.metadata?.description || "",
        business_address: alpha?.metadata?.business_address || pubTenant?.metadata?.business_address || "",
        industry: alpha?.metadata?.industry || pubTenant?.metadata?.industry || "",
        logo: alpha?.metadata?.logo || pubTenant?.metadata?.logo || "",
        status: alpha?.is_active ? "active" : (pubTenant?.status || "unknown"),
        is_verified: alpha?.is_verified || false,
        brand_id: pubTenant?.brand_id || null,
        member_since: pubTenant?.created_at || alpha?.created_at || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.patch("/tenant/profile", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId, tenantPhone } = req.tenantSession;
    const body = req.body || {};
    const pubUpdates = {};
    if (body.client_name !== undefined) pubUpdates.client_name = String(body.client_name).trim();
    if (body.point_of_contact_name !== undefined) pubUpdates.point_of_contact_name = String(body.point_of_contact_name).trim();
    if (body.description !== undefined) pubUpdates.description = String(body.description).trim();
    if (Object.keys(pubUpdates).length) {
      pubUpdates.updated_at = new Date().toISOString();
      await supabase.from("bot_tenants").update(pubUpdates).eq("id", tenantId);
    }
    const alphaUpdates = { updated_at: new Date().toISOString() };
    if (body.client_name !== undefined) alphaUpdates.client_name = String(body.client_name).trim();
    if (body.client_email !== undefined) alphaUpdates.client_email = String(body.client_email).trim().toLowerCase();
    if (body.point_of_contact_name !== undefined) alphaUpdates.point_of_contact_name = String(body.point_of_contact_name).trim();
    if (body.point_of_contact_phone !== undefined) alphaUpdates.point_of_contact_phone = String(body.point_of_contact_phone).trim();
    const metaKeys = ["business_address", "industry", "logo", "description"];
    const newMeta = {};
    metaKeys.forEach((k) => { if (body[k] !== undefined) newMeta[k] = body[k]; });
    if (Object.keys(newMeta).length) {
      const existing = await resolveAlphadomeTenantByPhone(tenantPhone);
      alphaUpdates.metadata = { ...(existing?.metadata || {}), ...newMeta };
    }
    await updateAlphadomeTenantByPhone(tenantPhone, alphaUpdates);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT SMTP CONFIG API =====

app.get("/tenant/smtp", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantPhone } = req.tenantSession;
    const tenant = await resolveAlphadomeTenantByPhone(tenantPhone);
    if (!tenant) return res.status(404).json({ error: "Tenant config not found" });
    return res.json({
      smtp: {
        smtp_host: tenant.smtp_host || "",
        smtp_port: tenant.smtp_port || 587,
        smtp_user: tenant.smtp_user || "",
        smtp_from_name: tenant.smtp_from_name || "",
        has_password: Boolean(tenant.smtp_pass),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.patch("/tenant/smtp", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantPhone } = req.tenantSession;
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name } = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (smtp_host !== undefined) updates.smtp_host = String(smtp_host).trim();
    if (smtp_port !== undefined) updates.smtp_port = parseInt(smtp_port, 10) || 587;
    if (smtp_user !== undefined) updates.smtp_user = String(smtp_user).trim();
    if (smtp_from_name !== undefined) updates.smtp_from_name = String(smtp_from_name).trim();
    if (smtp_pass !== undefined && smtp_pass !== "") updates.smtp_pass = String(smtp_pass);
    const rows = await updateAlphadomeTenantByPhone(tenantPhone, updates);
    if (!rows.length) return res.status(404).json({ error: "Tenant not found — SMTP config not updated" });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT BOT SETTINGS API =====

app.get("/tenant/bot-settings", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantPhone } = req.tenantSession;
    const tenant = await resolveAlphadomeTenantByPhone(tenantPhone);
    if (!tenant) return res.status(404).json({ error: "Tenant config not found" });
    return res.json({
      settings: {
        ai_model: tenant.ai_model || "gpt-3.5-turbo",
        ai_provider: tenant.ai_provider || "openai",
        has_ai_key: Boolean(tenant.ai_api_key),
        whatsapp_phone_number_id: tenant.whatsapp_phone_number_id || "",
        whatsapp_business_account_id: tenant.whatsapp_business_account_id || "",
        has_wa_token: Boolean(tenant.whatsapp_access_token),
        is_active: tenant.is_active || false,
        is_verified: tenant.is_verified || false,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.patch("/tenant/bot-settings", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantPhone } = req.tenantSession;
    const { ai_model, ai_provider, ai_api_key, whatsapp_access_token, whatsapp_phone_number_id, whatsapp_business_account_id } = req.body || {};
    const ALLOWED_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4", "gpt-3.5-turbo", "claude-3-haiku-20240307", "claude-3-5-sonnet-20241022"];
    if (ai_model && !ALLOWED_MODELS.includes(ai_model)) {
      return res.status(400).json({ error: `Invalid ai_model. Allowed: ${ALLOWED_MODELS.join(", ")}` });
    }
    const updates = { updated_at: new Date().toISOString() };
    if (ai_model) updates.ai_model = ai_model;
    if (ai_provider) updates.ai_provider = String(ai_provider).trim();
    if (ai_api_key) updates.ai_api_key = String(ai_api_key).trim();
    if (whatsapp_access_token) updates.whatsapp_access_token = String(whatsapp_access_token).trim();
    if (whatsapp_phone_number_id) updates.whatsapp_phone_number_id = String(whatsapp_phone_number_id).trim();
    if (whatsapp_business_account_id) updates.whatsapp_business_account_id = String(whatsapp_business_account_id).trim();
    const rows = await updateAlphadomeTenantByPhone(tenantPhone, updates);
    if (!rows.length) return res.status(404).json({ error: "Tenant not found — bot settings not updated" });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT ANALYTICS API =====

app.get("/tenant/analytics", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("brand_id")
      .eq("id", tenantId)
      .maybeSingle();
    const brandId = pubTenant?.brand_id || null;
    if (!brandId) {
      return res.json({
        analytics: {
          total_conversations: 0, inbound_count: 0, outbound_count: 0,
          llm_calls_total: 0, last_7_days: [],
          note: "Brand ID not linked yet.",
        },
      });
    }
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [allRes, llmRes, recentRes] = await Promise.all([
      supabase.from("conversations").select("direction", { count: "exact" }).eq("brand_id", brandId),
      supabase.from("conversations").select("id", { count: "exact" }).eq("brand_id", brandId).eq("llm_used", true),
      supabase.from("conversations").select("direction, created_at").eq("brand_id", brandId).gte("created_at", since7d).order("created_at", { ascending: true }),
    ]);
    const allRows = allRes.data || [];
    const total = allRes.count || 0;
    const inbound = allRows.filter((r) => r.direction === "incoming" || r.direction === "inbound").length;
    const dayMap = {};
    (recentRes.data || []).forEach((row) => {
      const day = row.created_at?.slice(0, 10);
      if (!day) return;
      if (!dayMap[day]) dayMap[day] = { date: day, messages: 0 };
      dayMap[day].messages++;
    });

    // Cohort retention: users grouped by first inbound message day in last 8 weeks,
    // then compute return rates on D7 and D30.
    const since56d = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString();
    const { data: cohortRows } = await supabase
      .from("conversations")
      .select("user_id, direction, created_at")
      .eq("brand_id", brandId)
      .gte("created_at", since56d)
      .order("created_at", { ascending: true });

    const firstInboundByUser = {};
    const inboundDaysByUser = {};
    (cohortRows || []).forEach((row) => {
      const isInbound = row.direction === "incoming" || row.direction === "inbound";
      if (!isInbound || !row.user_id) return;
      const day = row.created_at?.slice(0, 10);
      if (!day) return;
      if (!firstInboundByUser[row.user_id]) firstInboundByUser[row.user_id] = day;
      if (!inboundDaysByUser[row.user_id]) inboundDaysByUser[row.user_id] = new Set();
      inboundDaysByUser[row.user_id].add(day);
    });

    const cohortMap = {};
    Object.entries(firstInboundByUser).forEach(([userId, cohortDay]) => {
      if (!cohortMap[cohortDay]) cohortMap[cohortDay] = { cohort_day: cohortDay, users: 0, retained_d7: 0, retained_d30: 0 };
      cohortMap[cohortDay].users += 1;

      const cohortDate = new Date(`${cohortDay}T00:00:00.000Z`);
      const d7 = new Date(cohortDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const d30 = new Date(cohortDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const userDays = inboundDaysByUser[userId] || new Set();
      if (userDays.has(d7)) cohortMap[cohortDay].retained_d7 += 1;
      if (userDays.has(d30)) cohortMap[cohortDay].retained_d30 += 1;
    });

    const cohorts = Object.values(cohortMap)
      .sort((a, b) => a.cohort_day.localeCompare(b.cohort_day))
      .slice(-8)
      .map((c) => ({
        ...c,
        d7_rate: c.users ? Math.round((c.retained_d7 / c.users) * 100) : 0,
        d30_rate: c.users ? Math.round((c.retained_d30 / c.users) * 100) : 0,
      }));

    return res.json({
      analytics: {
        total_conversations: total,
        inbound_count: inbound,
        outbound_count: total - inbound,
        llm_calls_total: llmRes.count || 0,
        last_7_days: Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date)),
        cohorts,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/attribution — first/last-touch attribution analytics
app.get("/tenant/attribution", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    // Get completed/active subscriptions scoped to this tenant.
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("user_id, phone, amount, created_at, status")
      .eq("tenant_id", tenantId)
      .in("status", ["completed", "active"])
      .limit(5000);
    const completedSubs = subs || [];
    if (!completedSubs.length) {
      return res.json({ attribution: { first_touch: [], last_touch: [], total_revenue: 0, total_conversions: 0 } });
    }

    // Join to user phones for rows that only have user_id.
    const userIds = [...new Set(completedSubs.map((s) => s.user_id).filter(Boolean))];
    const { data: phoneUsers } = userIds.length
      ? await supabase.from("users").select("id, phone").in("id", userIds)
      : { data: [] };
    const userIdToPhone = new Map((phoneUsers || []).map((u) => [u.id, u.phone]));

    const phonesForSubs = [...new Set(completedSubs.map((s) => s.phone || userIdToPhone.get(s.user_id)).filter(Boolean))];
    const { data: sessions } = phonesForSubs.length
      ? await supabase
          .from("user_sessions")
          .select("phone, context")
          .eq("tenant_id", tenantId)
          .in("phone", phonesForSubs)
      : { data: [] };

    const phoneToAttribution = new Map();
    (sessions || []).forEach((s) => {
      const ctx = s.context && typeof s.context === "object" ? s.context : {};
      phoneToAttribution.set(s.phone, {
        first_touch_source: ctx.first_touch_source || "unknown",
        last_touch_source: ctx.last_touch_source || ctx.first_touch_source || "unknown",
      });
    });

    // Build aggregations
    const firstTouchRevenue = {};
    const lastTouchRevenue = {};
    let totalRevenue = 0;
    let completedCount = 0;

    completedSubs.forEach((sub) => {
      const amount = Number(sub.amount) || 0;
      const phone = sub.phone || userIdToPhone.get(sub.user_id);
      const attribution = phoneToAttribution.get(phone);

      const ft = attribution?.first_touch_source || "unknown";
      const lt = attribution?.last_touch_source || ft || "unknown";

      if (!firstTouchRevenue[ft]) firstTouchRevenue[ft] = { revenue: 0, count: 0 };
      if (!lastTouchRevenue[lt]) lastTouchRevenue[lt] = { revenue: 0, count: 0 };

      firstTouchRevenue[ft].revenue += amount;
      firstTouchRevenue[ft].count += 1;
      lastTouchRevenue[lt].revenue += amount;
      lastTouchRevenue[lt].count += 1;

      totalRevenue += amount;
      completedCount += 1;
    });

    // Format response
    const firstTouchArray = Object.entries(firstTouchRevenue).map(([source, data]) => ({
      source,
      revenue: Math.round(data.revenue * 100) / 100,
      count: data.count,
      avg_value: Math.round((data.revenue / data.count) * 100) / 100,
    })).sort((a, b) => b.revenue - a.revenue);

    const lastTouchArray = Object.entries(lastTouchRevenue).map(([source, data]) => ({
      source,
      revenue: Math.round(data.revenue * 100) / 100,
      count: data.count,
      avg_value: Math.round((data.revenue / data.count) * 100) / 100,
    })).sort((a, b) => b.revenue - a.revenue);

    return res.json({
      attribution: {
        first_touch: firstTouchArray,
        last_touch: lastTouchArray,
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_conversions: completedCount,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/revenue — sales analytics for dashboard (daily trend, top products, MRR)
app.get("/tenant/revenue", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Get all completed/active subscriptions in last 30 days
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("id, amount, product_sku, status, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", since30d)
      .in("status", ["completed", "active"]);

    const subscriptions = subs || [];

    // Calculate daily trend
    const dayMap = {};
    subscriptions.forEach((sub) => {
      const day = sub.created_at?.slice(0, 10);
      if (!day) return;
      if (!dayMap[day]) dayMap[day] = { date: day, sales: 0, count: 0 };
      dayMap[day].sales += parseFloat(sub.amount || 0);
      dayMap[day].count += 1;
    });

    const dailyTrend = Object.values(dayMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, sales: Math.round(d.sales * 100) / 100 }));

    // Calculate top 5 products
    const productMap = {};
    subscriptions.forEach((sub) => {
      const sku = sub.product_sku || "unknown";
      if (!productMap[sku]) productMap[sku] = { sku, revenue: 0, count: 0 };
      productMap[sku].revenue += parseFloat(sub.amount || 0);
      productMap[sku].count += 1;
    });

    const topProducts = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map((p) => ({ ...p, revenue: Math.round(p.revenue * 100) / 100 }));

    // Calculate metrics
    const totalRevenue = subscriptions.reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
    const totalOrders = subscriptions.length;
    const avgOrderValue = totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0;

    // MRR (Monthly Recurring Revenue) — assume subscriptions are monthly
    const mrrSubscriptions = subscriptions.filter((s) => s.status === "active");
    const mrr = mrrSubscriptions.reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);

    return res.json({
      revenue: {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_orders: totalOrders,
        avg_order_value: avgOrderValue,
        mrr: Math.round(mrr * 100) / 100,
        daily_trend: dailyTrend,
        top_products: topProducts,
        period: "30 days",
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== INSIGHTS, FUNNEL, AUTOMATION APIS =====

// GET /tenant/funnel — sales funnel analysis
app.get("/tenant/funnel", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: pubTenant } = await supabase.from("bot_tenants").select("brand_id").eq("id", tenantId).maybeSingle();
    const brandId = pubTenant?.brand_id;
    if (!brandId) return res.json({ funnel: null });
    const { data: inboundConvs } = await supabase.from("conversations").select("user_id").eq("brand_id", brandId).eq("direction", "incoming").gte("created_at", since30d);
    const searched = new Set((inboundConvs || []).map((c) => c.user_id).filter(Boolean));
    const { data: sessions } = await supabase.from("user_sessions").select("phone, context").eq("tenant_id", tenantId).gte("updated_at", since30d);
    const viewed = new Set((sessions || []).filter((s) => s.context?.last_selected_sku).map((s) => s.phone));
    const { data: allSubs } = await supabase.from("subscriptions").select("user_id, status").eq("tenant_id", tenantId).gte("created_at", since30d);
    const initiated = new Set((allSubs || []).map((s) => s.user_id).filter(Boolean));
    const completed = new Set((allSubs || []).filter((s) => s.status === "completed" || s.status === "active").map((s) => s.user_id).filter(Boolean));
    const s1 = searched.size; const s2 = viewed.size; const s3 = initiated.size; const s4 = completed.size;
    return res.json({ funnel: [
      { stage: "Messaged Bot", count: s1, rate: 100 },
      { stage: "Viewed Product", count: s2, rate: s1 > 0 ? Math.round((s2/s1)*100) : 0 },
      { stage: "Checkout Started", count: s3, rate: s1 > 0 ? Math.round((s3/s1)*100) : 0 },
      { stage: "Purchase Complete", count: s4, rate: s1 > 0 ? Math.round((s4/s1)*100) : 0 },
    ], period: "30 days" });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// GET /tenant/response-time — avg bot response time
app.get("/tenant/response-time", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase.from("bot_tenants").select("brand_id").eq("id", tenantId).maybeSingle();
    const brandId = pubTenant?.brand_id;
    if (!brandId) return res.json({ avg_response_s: null });
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: convRows } = await supabase.from("conversations").select("user_id, direction, created_at").eq("brand_id", brandId).gte("created_at", since7d).order("created_at", { ascending: true });
    const rows = convRows || [];
    const responseTimes = [];
    const lastInbound = {};
    for (const row of rows) {
      if (row.direction === "incoming") { lastInbound[row.user_id] = new Date(row.created_at).getTime(); }
      else if (row.direction === "outgoing" && lastInbound[row.user_id]) {
        const delta = new Date(row.created_at).getTime() - lastInbound[row.user_id];
        if (delta > 0 && delta < 300000) { responseTimes.push(delta); delete lastInbound[row.user_id]; }
      }
    }
    const avg = responseTimes.length > 0 ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null;
    const under5s = responseTimes.filter((t) => t < 5000).length;
    return res.json({ avg_response_s: avg !== null ? Math.round(avg / 1000) : null, samples: responseTimes.length, under_5s_pct: responseTimes.length > 0 ? Math.round((under5s/responseTimes.length)*100) : null, period: "7 days" });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// GET /tenant/top-questions — word clustering from inbound chats
app.get("/tenant/top-questions", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase.from("bot_tenants").select("brand_id").eq("id", tenantId).maybeSingle();
    const brandId = pubTenant?.brand_id;
    if (!brandId) return res.json({ top_words: [], top_phrases: [] });
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: convRows } = await supabase.from("conversations").select("message").eq("brand_id", brandId).eq("direction", "incoming").gte("created_at", since7d).limit(500);
    const stopWords = new Set(["the","a","an","in","is","it","to","i","you","my","me","we","be","do","so","if","of","at","on","or","and","but","for","not","can","yes","no","hi","hey","hello","please","thanks","thank","ok","okay","how","what","when","where","who","why","this","that","with","your"]);
    const wordFreq = {}; const phraseFreq = {};
    (convRows || []).forEach((row) => {
      const text = (row.message || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
      const words = text.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
      words.forEach((w) => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
      for (let i = 0; i < words.length - 1; i++) { const p = `${words[i]} ${words[i+1]}`; phraseFreq[p] = (phraseFreq[p] || 0) + 1; }
    });
    const topWords = Object.entries(wordFreq).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([word,count])=>({word,count}));
    const topPhrases = Object.entries(phraseFreq).filter(([,c])=>c>=2).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([phrase,count])=>({phrase,count}));
    return res.json({ top_words: topWords, top_phrases: topPhrases, messages_analyzed: (convRows||[]).length });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// GET /tenant/customer-ltv — lifetime value buckets and top customers
app.get("/tenant/customer-ltv", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("user_id, phone, amount, status, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["completed", "active"])
      .order("created_at", { ascending: false })
      .limit(3000);

    const totals = {};
    (subs || []).forEach((s) => {
      const key = s.user_id || s.phone;
      if (!key) return;
      if (!totals[key]) totals[key] = { key, user_id: s.user_id || null, phone: s.phone || null, total_spent: 0, orders: 0, last_purchase: null };
      totals[key].total_spent += Number(s.amount || 0);
      totals[key].orders += 1;
      if (!totals[key].last_purchase || new Date(s.created_at) > new Date(totals[key].last_purchase)) totals[key].last_purchase = s.created_at;
    });

    const rows = Object.values(totals).map((r) => ({ ...r, total_spent: Math.round(r.total_spent * 100) / 100 }));
    const buckets = { low: 0, medium: 0, high: 0, vip: 0 };
    rows.forEach((r) => {
      if (r.total_spent < 500) buckets.low += 1;
      else if (r.total_spent < 2000) buckets.medium += 1;
      else if (r.total_spent < 10000) buckets.high += 1;
      else buckets.vip += 1;
    });

    rows.sort((a, b) => b.total_spent - a.total_spent);
    return res.json({
      summary: {
        customers_with_purchases: rows.length,
        avg_ltv: rows.length ? Math.round((rows.reduce((s, r) => s + r.total_spent, 0) / rows.length) * 100) / 100 : 0,
        buckets,
      },
      top_customers: rows.slice(0, 20),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/ai-summary — weekly AI digest from live metrics
app.get("/tenant/ai-summary", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const periodDays = Math.max(1, Math.min(30, parseInt(req.query.period_days || "7", 10)));
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    const { data: tenantRow } = await supabase
      .from("bot_tenants")
      .select("id, client_name, ai_api_key, ai_provider, ai_model, brand_id")
      .eq("id", tenantId)
      .maybeSingle();

    const [{ data: subs }, { data: convRows }] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("amount, status, created_at, product_sku")
        .eq("tenant_id", tenantId)
        .gte("created_at", since)
        .in("status", ["completed", "active"]),
      tenantRow?.brand_id
        ? supabase
            .from("conversations")
            .select("direction, message, created_at")
            .eq("brand_id", tenantRow.brand_id)
            .gte("created_at", since)
            .limit(2000)
        : Promise.resolve({ data: [] }),
    ]);

    const revenue = (subs || []).reduce((sum, s) => sum + Number(s.amount || 0), 0);
    const orders = (subs || []).length;
    const inCount = (convRows || []).filter((r) => r.direction === "incoming").length;
    const outCount = (convRows || []).filter((r) => r.direction === "outgoing").length;

    const productCount = {};
    (subs || []).forEach((s) => {
      const sku = String(s.product_sku || "").trim();
      if (!sku) return;
      productCount[sku] = (productCount[sku] || 0) + 1;
    });
    const topSku = Object.entries(productCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    let summary = `Weekly digest (${periodDays}d)\n`
      + `- Revenue: KES ${Math.round(revenue).toLocaleString()} from ${orders} paid orders\n`
      + `- Conversations: ${inCount} inbound / ${outCount} outbound\n`
      + `- Top selling SKU: ${topSku || "N/A"}\n`
      + `- Priority: ${orders === 0 ? "Boost conversions with targeted broadcasts and cart recovery" : "Scale top performers and improve response speed"}`;

    const shouldRegenerate = String(req.query.regenerate || "").toLowerCase() === "true";
    const creds = getDecryptedCredentials(tenantRow || null);
    if (shouldRegenerate && creds.aiApiKey) {
      try {
        const openaiClient = new OpenAI({ apiKey: creds.aiApiKey });
        const aiResp = await openaiClient.chat.completions.create({
          model: creds.aiModel || "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a concise business analyst. Return a short weekly digest in 5 bullet points." },
            { role: "user", content: `Create a weekly digest for this tenant metrics:\n${summary}` },
          ],
        });
        const aiText = aiResp?.choices?.[0]?.message?.content?.trim();
        if (aiText) summary = aiText;
      } catch (err) {
        log(`AI summary fallback used: ${err.message}`, "WARN");
      }
    }

    return res.json({ summary, period_days: periodDays, generated_at: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/auto-responses
app.get("/tenant/auto-responses", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    return res.json({ templates: pubTenant?.metadata?.auto_responses || [] });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// PUT /tenant/auto-responses — save templates
app.put("/tenant/auto-responses", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { templates } = req.body;
    if (!Array.isArray(templates)) return res.status(400).json({ error: "templates must be an array" });
    const sanitized = templates.slice(0,20).map((t) => ({ trigger: String(t.trigger||"").trim().slice(0,100), response: String(t.response||"").trim().slice(0,1024), enabled: Boolean(t.enabled!==false) })).filter((t) => t.trigger && t.response);
    const { data: pubTenant } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    const existing = pubTenant?.metadata || {};
    await supabase.from("bot_tenants").update({ metadata: { ...existing, auto_responses: sanitized }, updated_at: new Date().toISOString() }).eq("id", tenantId);
    return res.json({ success: true, saved: sanitized.length });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// GET /tenant/scheduled-messages
app.get("/tenant/scheduled-messages", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    const scheduled = (pubTenant?.metadata?.scheduled_messages || []).map((m, i) => ({ ...m, id: i }));
    return res.json({ scheduled });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// POST /tenant/scheduled-messages
app.post("/tenant/scheduled-messages", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { message, scheduled_at, segment = "all" } = req.body;
    if (!message || !scheduled_at) return res.status(400).json({ error: "message and scheduled_at required" });
    const scheduledTime = new Date(scheduled_at);
    if (isNaN(scheduledTime.getTime()) || scheduledTime < new Date()) return res.status(400).json({ error: "scheduled_at must be a valid future date" });
    const { data: pubTenant } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    const existing = pubTenant?.metadata || {};
    const queue = Array.isArray(existing.scheduled_messages) ? existing.scheduled_messages : [];
    queue.push({ message: String(message).trim().slice(0,1024), scheduled_at: scheduledTime.toISOString(), segment, created_at: new Date().toISOString(), status: "pending" });
    await supabase.from("bot_tenants").update({ metadata: { ...existing, scheduled_messages: queue.slice(-50) }, updated_at: new Date().toISOString() }).eq("id", tenantId);
    return res.json({ success: true, total_scheduled: queue.length });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// DELETE /tenant/scheduled-messages/:id
app.delete("/tenant/scheduled-messages/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const idx = parseInt(req.params.id, 10);
    const { data: pubTenant } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    const existing = pubTenant?.metadata || {};
    const queue = Array.isArray(existing.scheduled_messages) ? [...existing.scheduled_messages] : [];
    if (idx < 0 || idx >= queue.length) return res.status(404).json({ error: "Not found" });
    queue.splice(idx, 1);
    await supabase.from("bot_tenants").update({ metadata: { ...existing, scheduled_messages: queue }, updated_at: new Date().toISOString() }).eq("id", tenantId);
    return res.json({ success: true });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});

// POST /tenant/scheduled-messages/run — execute due pending messages now
app.post("/tenant/scheduled-messages/run", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: pubTenant } = await supabase
      .from("bot_tenants")
      .select("id, brand_id, metadata, whatsapp_access_token, whatsapp_phone_number_id, ai_api_key, ai_provider, ai_model")
      .eq("id", tenantId)
      .maybeSingle();
    if (!pubTenant) return res.status(404).json({ error: "Tenant not found" });

    const now = new Date();
    const metadata = pubTenant.metadata || {};
    const queue = Array.isArray(metadata.scheduled_messages) ? [...metadata.scheduled_messages] : [];
    const dueIndexes = [];
    queue.forEach((m, i) => {
      const when = new Date(m.scheduled_at || 0);
      if (m?.status === "pending" && !isNaN(when.getTime()) && when <= now) dueIndexes.push(i);
    });

    if (!dueIndexes.length) return res.json({ success: true, processed: 0, sent: 0, failed: 0, message: "No due scheduled messages" });

    const creds = getDecryptedCredentials(pubTenant);
    let totalSent = 0;
    let totalFailed = 0;

    for (const idx of dueIndexes) {
      const item = queue[idx];
      const segment = item?.segment || "all";
      const safeMsg = String(item?.message || "").trim().slice(0, 1024);
      if (!safeMsg) {
        queue[idx] = { ...item, status: "failed", error: "Empty message", processed_at: new Date().toISOString() };
        totalFailed += 1;
        continue;
      }

      const { data: convRows } = await supabase
        .from("conversations")
        .select("user_id")
        .eq("brand_id", pubTenant.brand_id)
        .eq("direction", "incoming")
        .gte("created_at", new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString());
      let userIds = [...new Set((convRows || []).map((r) => r.user_id).filter(Boolean))];
      userIds = await filterUsersBySegment(userIds, pubTenant.brand_id, tenantId, segment);

      if (!userIds.length) {
        queue[idx] = { ...item, status: "sent", sent: 0, failed: 0, processed_at: new Date().toISOString(), note: "No users in segment" };
        continue;
      }

      const { data: users } = await supabase.from("users").select("phone").in("id", userIds.slice(0, 500));
      const phones = (users || []).map((u) => u.phone).filter(Boolean);
      let sent = 0;
      let failed = 0;
      for (const phone of phones) {
        try {
          await sendMessage(phone, safeMsg, creds);
          sent += 1;
        } catch {
          failed += 1;
        }
      }
      totalSent += sent;
      totalFailed += failed;
      queue[idx] = {
        ...item,
        status: failed > 0 ? "partial" : "sent",
        sent,
        failed,
        processed_at: new Date().toISOString(),
      };
    }

    await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, scheduled_messages: queue }, updated_at: new Date().toISOString() })
      .eq("id", tenantId);

    return res.json({ success: true, processed: dueIndexes.length, sent: totalSent, failed: totalFailed });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== WORKFLOWS, ESCALATIONS, TEAM PERFORMANCE =====

// GET /tenant/workflows
app.get("/tenant/workflows", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: tenantRow, error } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const metadata = tenantRow?.metadata || {};
    const workflows = metadata.workflows || {};
    return res.json({
      workflows: {
        escalation_keywords: Array.isArray(workflows.escalation_keywords) ? workflows.escalation_keywords : ["human", "agent", "manager", "support", "help"],
        auto_assign_enabled: workflows.auto_assign_enabled !== false,
        default_agent: workflows.default_agent || "",
        team_agents: Array.isArray(workflows.team_agents) ? workflows.team_agents : [],
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PUT /tenant/workflows
app.put("/tenant/workflows", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const body = req.body || {};
    const escalationKeywords = Array.isArray(body.escalation_keywords)
      ? body.escalation_keywords.map((k) => String(k || "").trim().toLowerCase()).filter(Boolean).slice(0, 30)
      : [];
    const teamAgents = Array.isArray(body.team_agents)
      ? body.team_agents
          .map((a) => ({
            id: String(a?.id || "").trim().slice(0, 40),
            name: String(a?.name || "").trim().slice(0, 80),
            role: String(a?.role || "agent").trim().slice(0, 40),
            active: a?.active !== false,
          }))
          .filter((a) => a.id && a.name)
          .slice(0, 50)
      : [];

    const { data: tenantRow, error: readErr } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });

    const metadata = tenantRow?.metadata || {};
    const workflows = {
      escalation_keywords: escalationKeywords,
      auto_assign_enabled: body.auto_assign_enabled !== false,
      default_agent: String(body.default_agent || "").trim().slice(0, 40),
      team_agents: teamAgents,
      updated_at: new Date().toISOString(),
    };

    const { error: writeErr } = await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, workflows }, updated_at: new Date().toISOString() })
      .eq("id", tenantId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });
    return res.json({ success: true, workflows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/escalations
app.get("/tenant/escalations", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: tenantRow, error } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const metadata = tenantRow?.metadata || {};
    const escalations = Array.isArray(metadata.escalations) ? metadata.escalations : [];
    escalations.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    return res.json({ escalations: escalations.slice(0, 200) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /tenant/escalations
app.post("/tenant/escalations", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { phone, reason, priority = "medium", assigned_agent = "", notes = "" } = req.body || {};
    const cleanPhone = String(phone || "").trim();
    const cleanReason = String(reason || "").trim();
    if (!cleanPhone || !cleanReason) return res.status(400).json({ error: "phone and reason are required" });

    const { data: tenantRow, error: readErr } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    const metadata = tenantRow?.metadata || {};
    const escalations = Array.isArray(metadata.escalations) ? metadata.escalations : [];

    const now = new Date().toISOString();
    const item = {
      id: `esc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      phone: cleanPhone,
      reason: cleanReason.slice(0, 500),
      priority: ["low", "medium", "high", "urgent"].includes(String(priority)) ? String(priority) : "medium",
      status: "open",
      assigned_agent: String(assigned_agent || "").trim().slice(0, 40) || null,
      notes: String(notes || "").trim().slice(0, 1000) || null,
      created_at: now,
      updated_at: now,
      resolved_at: null,
    };

    escalations.push(item);

    const { error: writeErr } = await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, escalations: escalations.slice(-500) }, updated_at: now })
      .eq("id", tenantId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });
    return res.json({ success: true, escalation: item });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /tenant/escalations/:id
app.patch("/tenant/escalations/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const escalationId = String(req.params.id || "").trim();
    if (!escalationId) return res.status(400).json({ error: "id is required" });

    const { data: tenantRow, error: readErr } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    const metadata = tenantRow?.metadata || {};
    const escalations = Array.isArray(metadata.escalations) ? [...metadata.escalations] : [];
    const idx = escalations.findIndex((e) => e?.id === escalationId);
    if (idx < 0) return res.status(404).json({ error: "Escalation not found" });

    const current = escalations[idx] || {};
    const nextStatus = req.body?.status ? String(req.body.status).trim().toLowerCase() : current.status;
    const now = new Date().toISOString();
    const updated = {
      ...current,
      status: ["open", "in_progress", "resolved", "closed"].includes(nextStatus) ? nextStatus : current.status,
      priority: req.body?.priority ? String(req.body.priority).trim().toLowerCase() : current.priority,
      assigned_agent: req.body?.assigned_agent !== undefined ? String(req.body.assigned_agent || "").trim().slice(0, 40) || null : current.assigned_agent,
      notes: req.body?.notes !== undefined ? String(req.body.notes || "").trim().slice(0, 1000) || null : current.notes,
      updated_at: now,
      resolved_at: ["resolved", "closed"].includes(nextStatus) ? now : current.resolved_at || null,
    };
    escalations[idx] = updated;

    const { error: writeErr } = await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, escalations }, updated_at: now })
      .eq("id", tenantId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });
    return res.json({ success: true, escalation: updated });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/agent-performance
app.get("/tenant/agent-performance", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: tenantRow, error } = await supabase.from("bot_tenants").select("metadata").eq("id", tenantId).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    const metadata = tenantRow?.metadata || {};
    const escalations = Array.isArray(metadata.escalations) ? metadata.escalations : [];
    const teamAgents = Array.isArray(metadata?.workflows?.team_agents) ? metadata.workflows.team_agents : [];

    const buckets = {};
    teamAgents.forEach((a) => {
      const id = String(a?.id || "").trim();
      if (!id) return;
      buckets[id] = {
        agent_id: id,
        agent_name: a.name || id,
        role: a.role || "agent",
        assigned_total: 0,
        resolved_total: 0,
        open_total: 0,
        avg_resolution_hours: null,
      };
    });

    const resolutionMsByAgent = {};
    escalations.forEach((e) => {
      const agent = String(e?.assigned_agent || "").trim() || "unassigned";
      if (!buckets[agent]) {
        buckets[agent] = {
          agent_id: agent,
          agent_name: agent,
          role: agent === "unassigned" ? "queue" : "agent",
          assigned_total: 0,
          resolved_total: 0,
          open_total: 0,
          avg_resolution_hours: null,
        };
      }
      buckets[agent].assigned_total += 1;
      if (e?.status === "resolved" || e?.status === "closed") {
        buckets[agent].resolved_total += 1;
        const start = new Date(e.created_at || 0).getTime();
        const end = new Date(e.resolved_at || e.updated_at || 0).getTime();
        if (start > 0 && end > start) {
          if (!resolutionMsByAgent[agent]) resolutionMsByAgent[agent] = [];
          resolutionMsByAgent[agent].push(end - start);
        }
      } else {
        buckets[agent].open_total += 1;
      }
    });

    Object.keys(resolutionMsByAgent).forEach((agent) => {
      const arr = resolutionMsByAgent[agent] || [];
      if (!arr.length) return;
      const avgMs = arr.reduce((a, b) => a + b, 0) / arr.length;
      buckets[agent].avg_resolution_hours = Number((avgMs / (1000 * 60 * 60)).toFixed(2));
    });

    const agents = Object.values(buckets).sort((a, b) => b.assigned_total - a.assigned_total);
    const totals = {
      escalations_total: escalations.length,
      escalations_open: escalations.filter((e) => !["resolved", "closed"].includes(String(e?.status || ""))).length,
      escalations_resolved: escalations.filter((e) => ["resolved", "closed"].includes(String(e?.status || ""))).length,
    };
    return res.json({ totals, agents });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/agent-assignments
app.get("/tenant/agent-assignments", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: tenantRow, error } = await supabase
      .from("bot_tenants")
      .select("metadata")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    const metadata = tenantRow?.metadata || {};
    const workflows = metadata.workflows || {};
    const teamAgents = Array.isArray(workflows.team_agents) ? workflows.team_agents : [];
    const assignments = Array.isArray(metadata.agent_assignments) ? metadata.agent_assignments : [];

    return res.json({
      default_agent: workflows.default_agent || "",
      team_agents: teamAgents,
      assignments: assignments
        .slice()
        .sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime())
        .slice(0, 500),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PUT /tenant/agent-assignments
app.put("/tenant/agent-assignments", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = String(req.body?.phone || "").trim();
    const agentId = String(req.body?.agent_id || "").trim();
    const notes = String(req.body?.notes || "").trim().slice(0, 500);
    if (!phone || !agentId) return res.status(400).json({ error: "phone and agent_id are required" });

    const { data: tenantRow, error: readErr } = await supabase
      .from("bot_tenants")
      .select("metadata")
      .eq("id", tenantId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });

    const metadata = tenantRow?.metadata || {};
    const current = Array.isArray(metadata.agent_assignments) ? [...metadata.agent_assignments] : [];
    const idx = current.findIndex((a) => String(a?.phone || "") === phone);
    const now = new Date().toISOString();
    const item = {
      phone,
      agent_id: agentId,
      notes: notes || null,
      updated_at: now,
      created_at: idx >= 0 ? current[idx]?.created_at || now : now,
    };
    if (idx >= 0) current[idx] = item;
    else current.push(item);

    const { error: writeErr } = await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, agent_assignments: current }, updated_at: now })
      .eq("id", tenantId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });

    return res.json({ success: true, assignment: item });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /tenant/agent-assignments/:phone
app.delete("/tenant/agent-assignments/:phone", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const phone = decodeURIComponent(req.params.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const { data: tenantRow, error: readErr } = await supabase
      .from("bot_tenants")
      .select("metadata")
      .eq("id", tenantId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });

    const metadata = tenantRow?.metadata || {};
    const current = Array.isArray(metadata.agent_assignments) ? metadata.agent_assignments : [];
    const next = current.filter((a) => String(a?.phone || "") !== phone);

    const { error: writeErr } = await supabase
      .from("bot_tenants")
      .update({ metadata: { ...metadata, agent_assignments: next }, updated_at: new Date().toISOString() })
      .eq("id", tenantId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /tenant/reviews
app.get("/tenant/reviews", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const { data: subs, error } = await supabase
      .from("subscriptions")
      .select("id, user_id, phone, amount, plan_type, level, product_sku, status, created_at, metadata")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1500);
    if (error) return res.status(500).json({ error: error.message });

    const rows = (subs || []).map((s) => {
      const md = s?.metadata && typeof s.metadata === "object" ? s.metadata : {};
      const rating = Number(md.rating || md.review_rating || 0);
      return {
        id: s.id,
        phone: s.phone,
        amount: Number(s.amount || 0),
        plan_type: s.plan_type,
        level: s.level,
        product_sku: s.product_sku || md.sku || null,
        status: s.status,
        created_at: s.created_at,
        rating: rating >= 1 && rating <= 5 ? rating : null,
        review_text: md.review_text || null,
        review_at: md.review_at || null,
      };
    });

    const reviewed = rows.filter((r) => r.rating != null);
    const avgRating = reviewed.length ? reviewed.reduce((sum, r) => sum + r.rating, 0) / reviewed.length : null;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviewed.forEach((r) => { dist[r.rating] = (dist[r.rating] || 0) + 1; });

    return res.json({
      summary: {
        total_orders: rows.length,
        reviewed_orders: reviewed.length,
        review_rate_pct: rows.length ? Math.round((reviewed.length / rows.length) * 100) : 0,
        avg_rating: avgRating != null ? Number(avgRating.toFixed(2)) : null,
        distribution: dist,
      },
      reviews: rows.slice(0, 300),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /tenant/reviews/:id
app.patch("/tenant/reviews/:id", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantId } = req.tenantSession;
    const id = req.params.id;
    const rating = Number(req.body?.rating);
    const reviewText = String(req.body?.review_text || "").trim().slice(0, 800) || null;
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "rating must be between 1 and 5" });

    const { data: sub, error: readErr } = await supabase
      .from("subscriptions")
      .select("id, metadata")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!sub) return res.status(404).json({ error: "Review target not found" });

    const md = sub.metadata && typeof sub.metadata === "object" ? sub.metadata : {};
    const nextMetadata = {
      ...md,
      rating,
      review_text: reviewText,
      review_at: new Date().toISOString(),
      reviewed_via: "dashboard",
    };

    const { error: writeErr } = await supabase
      .from("subscriptions")
      .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (writeErr) return res.status(500).json({ error: writeErr.message });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ===== TENANT PAYMENTS / SUBSCRIPTIONS API =====

app.get("/tenant/payments", tenantSessionAuth, async (req, res) => {
  try {
    const { tenantPhone } = req.tenantSession;
    const candidates = buildPhoneCandidates(tenantPhone);
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id, phone, amount, plan_type, level, status, created_at, metadata")
      .in("phone", candidates)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ payments: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: ADMIN_UPLOAD_MAX_MB * 1024 * 1024 }
});

async function ensureBucket(bucket) {
  try {
    const { data } = await supabase.storage.getBucket(bucket);
    if (!data) {
      await supabase.storage.createBucket(bucket, { public: true });
    }
  } catch (err) {
    log(`Bucket check failed: ${err.message}`, "WARN");
  }
}

function getPublicUrl(bucket, objectPath) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
  return data?.publicUrl;
}

function generateSku(name = "", prefix = "SKU") {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 24);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${base || "ITEM"}-${rand}`;
}



// ========== NEW HELPER: Level-based pricing ==========
function getPaymentAmount(plan = "Monthly", level = 1) {
  level = parseInt(level);
  if (isNaN(level) || level < 1) level = 1;
  plan = plan.toLowerCase();

  if (plan.startsWith("one")) return 100 * Math.pow(2, level - 1);
  if (plan.startsWith("month")) return 900 * Math.pow(2, level - 1);
  return 900 * Math.pow(2, level - 1); // default to Monthly if unclear
}

// ========== MULTI-TENANT SUPPORT: Load Tenant Context ==========
async function loadTenantContext(req, res, next) {
  try {
    // Get the business phone number/ID that RECEIVED the message (not the sender)
    const metadata = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata;
    const businessPhone = metadata?.display_phone_number;
    const businessPhoneId = metadata?.phone_number_id;
    const businessAccountId = metadata?.business_account_id;

    // Set your Alphadome main number here (should match your config)
    const ALPHADOME_MAIN_NUMBER = process.env.PHONE_NUMBER_ALPHADOME || "0786817637";
    const normalizePhone = (phone) => (phone || "").replace(/\D/g, "");
    const toKeE164 = (phone) => {
      const digits = normalizePhone(phone);
      if (!digits) return "";
      if (digits.startsWith("254")) return digits;
      if (digits.startsWith("0")) return `254${digits.slice(1)}`;
      if (digits.length === 9) return `254${digits}`;
      return digits;
    };
    const toLocalKe = (phone) => {
      const digits = normalizePhone(phone);
      if (digits.startsWith("254") && digits.length === 12) return `0${digits.slice(3)}`;
      return digits;
    };
    const normalizedBusinessPhone = normalizePhone(businessPhone);
    const normalizedAlphadome = normalizePhone(ALPHADOME_MAIN_NUMBER);
    const businessPhoneCandidates = [...new Set([
      normalizedBusinessPhone,
      toKeE164(normalizedBusinessPhone),
      toLocalKe(normalizedBusinessPhone),
    ].filter(Boolean))];

    // If the destination number is Alphadome, do not load any tenant
    if (businessPhoneCandidates.includes(normalizedAlphadome) || businessPhoneCandidates.includes(toKeE164(normalizedAlphadome)) || businessPhoneCandidates.includes(toLocalKe(normalizedAlphadome))) {
      req.tenant = null;
      req.isTenantAware = false;
      log(`✓ Alphadome main number detected (${businessPhone}) - responding as Alphadome`, "SYSTEM");
      return next();
    }

    // Resolve tenant by phone_number_id first, then fallback to known phone formats.
    let tenant = null;
    let lastLookupError = null;

    if (businessPhoneId) {
      const { data, error } = await supabase
        .from("bot_tenants")
        .select("*")
        .eq("whatsapp_phone_number_id", businessPhoneId)
        .order("updated_at", { ascending: false })
        .limit(10);
      tenant = (data || []).find(isTenantRecordActive) || null;
      lastLookupError = error || null;
    }

    if (!tenant && businessPhoneCandidates.length) {
      const { data, error } = await supabase
        .from("bot_tenants")
        .select("*")
        .in("client_phone", businessPhoneCandidates)
        .order("updated_at", { ascending: false })
        .limit(20);
      tenant = (data || []).find(isTenantRecordActive) || null;
      lastLookupError = error || lastLookupError;
    }

    if (lastLookupError && !tenant) {
      log(
        `Tenant lookup error for ${businessPhoneId || normalizedBusinessPhone}: ${lastLookupError.message}`,
        "WARN"
      );
    }

    if (!tenant) {
      log(
        `No tenant found for business phone ${businessPhoneId || normalizedBusinessPhone} (candidates: ${businessPhoneCandidates.join(",") || "none"}) - using default`,
        "DEBUG"
      );
      req.tenant = null;
      req.isTenantAware = false;
      return next();
    }

    // Ensure we always have a usable business phone for catalog lookups
    if (!tenant.client_phone && normalizedBusinessPhone) {
      tenant.client_phone = normalizedBusinessPhone;
    }
    tenant._business_phone = normalizedBusinessPhone || tenant.client_phone || null;
    tenant._business_phone_id = businessPhoneId || null;
    tenant._business_account_id = businessAccountId || null;

    req.tenant = tenant;
    req.isTenantAware = true;
    log(
      `✓ Tenant loaded: ${tenant.client_name} (${businessPhoneId || normalizedBusinessPhone})`,
      "SYSTEM"
    );
    next();
  } catch (err) {
    log(`Error in loadTenantContext: ${err.message}`, "ERROR");
    req.tenant = null;
    req.isTenantAware = false;
    next();
  }
}

// ========== Load Tenant Templates ==========
async function loadTenantTemplates(tenantId) {
  if (!tenantId) return [];
  try {
    const { data, error } = await supabase.rpc("get_templates_by_tenant", {
      p_tenant_id: tenantId,
    });

    if (error) {
      log(`Error loading templates: ${error.message}`, "ERROR");
      return [];
    }
    return data?.items || [];
  } catch (err) {
    log(`Exception loading templates: ${err.message}`, "ERROR");
    return [];
  }
}

// ========== Load Tenant Training Data ==========
async function loadTenantTrainingData(tenantId) {
  if (!tenantId) return [];
  try {
    const { data, error } = await supabase.rpc("get_training_by_tenant", {
      p_tenant_id: tenantId,
    });

    if (error) {
      log(`Error loading training data: ${error.message}`, "ERROR");
      return [];
    }
    return data?.items || [];
  } catch (err) {
    log(`Exception loading training data: ${err.message}`, "ERROR");
    return [];
  }
}

// ========== Get System Prompt ==========
function buildTrainingContext(trainingData = []) {
  if (!trainingData.length) return "";

  // Prioritize training data by type and priority
  const priorityOrder = [
    'product_knowledge',
    'category_knowledge',
    'inventory',
    'price_knowledge',
    'recommendation',
    'inventory_alert',
    'brand_knowledge',
    'faq',
    'canned_reply'
  ];

  // Sort training data by type priority, then by entry priority
  const sortedData = [...trainingData].sort((a, b) => {
    const aTypeIdx = priorityOrder.indexOf(a.data_type) !== -1 
      ? priorityOrder.indexOf(a.data_type) 
      : 999;
    const bTypeIdx = priorityOrder.indexOf(b.data_type) !== -1 
      ? priorityOrder.indexOf(b.data_type) 
      : 999;
    
    if (aTypeIdx !== bTypeIdx) return aTypeIdx - bTypeIdx;
    return (b.priority || 0) - (a.priority || 0);
  });

  const maxItems = 20; // Increased from 15 to include more product knowledge
  const maxChars = 3000; // Increased from 2000 for better context
  let result = "";
  let itemCount = 0;

  // Group by type for better organization
  const byType = {};
  for (const entry of sortedData.slice(0, maxItems)) {
    const q = (entry.question || "").trim();
    const a = (entry.answer || "").trim();
    if (!a) continue;
    
    const type = entry.data_type || 'general';
    if (!byType[type]) byType[type] = [];
    
    const line = q ? `Q: ${q}\nA: ${a}` : `${a}`;
    if (result.length + line.length + 50 > maxChars) break;
    
    byType[type].push(line);
    itemCount++;
  }

  // Build context with sections
  const sections = [];
  
  if (byType.product_knowledge || byType.category_knowledge) {
    const productLines = [
      ...(byType.product_knowledge || []),
      ...(byType.category_knowledge || [])
    ];
    sections.push(`PRODUCT CATALOG:\n${productLines.slice(0, 8).join('\n\n')}`);
  }
  
  if (byType.price_knowledge || byType.recommendation) {
    const priceLines = [
      ...(byType.price_knowledge || []),
      ...(byType.recommendation || [])
    ];
    sections.push(`PRICING & RECOMMENDATIONS:\n${priceLines.slice(0, 5).join('\n\n')}`);
  }
  
  if (byType.inventory || byType.inventory_alert) {
    const inventoryLines = [
      ...(byType.inventory || []),
      ...(byType.inventory_alert || [])
    ];
    sections.push(`INVENTORY STATUS:\n${inventoryLines.slice(0, 3).join('\n\n')}`);
  }
  
  if (byType.faq || byType.brand_knowledge) {
    const faqLines = [
      ...(byType.brand_knowledge || []),
      ...(byType.faq || [])
    ];
    sections.push(`BUSINESS INFO:\n${faqLines.slice(0, 4).join('\n\n')}`);
  }

  return sections.join('\n\n---\n\n').trim();
}

function getSystemPrompt(tenant = null, templates = [], trainingData = []) {
  const brandName = tenant?.client_name || "Alphadome";
  const isAlphadomeBrand = /alphadome/i.test(String(brandName));
  let basePrompt = `You are a helpful WhatsApp assistant for ${brandName}. Be professional, warm, and concise.`;

  if (templates.length > 0) {
    const defaultTemplate = templates.find((t) => t.is_default) || templates[0];
    if (defaultTemplate?.system_prompt) {
      basePrompt = defaultTemplate.system_prompt.trim();
    }
  }

  // Enhanced guardrails with product expertise guidance
  const guardrails = `
IMPORTANT RULES:
1. ONLY use information from the brand's product catalog and training data below
2. When asked about products, check the PRODUCT CATALOG section first
3. For pricing questions, refer to PRICING & RECOMMENDATIONS section
4. For availability, check INVENTORY STATUS section
5. If information is unavailable, say "I don't have that information in our current catalog" and suggest:
   - Asking for a specific product name or SKU
   - Calling the business directly
   - Requesting to speak with a human agent
6. DO NOT invent product details, prices, or availability
7. DO NOT mention unrelated businesses or communities
8. Be proactive - if customer mentions a category, suggest relevant products from catalog
9. If customer mentions budget, recommend items within their price range
10. Always be helpful, professional, and encourage customers to explore the full catalog
`.trim();

  const consultativeStyle = isAlphadomeBrand
    ? `
ALPHADOME CONSULTATIVE STYLE:
1. Keep outreach low-pressure and never nag users
2. Start by understanding the user before selling: ask one short discovery question at a time
3. Prioritize business discovery: profession, business type, current workflow, and key bottleneck
4. Provide practical help first (concierge/consultant style), then suggest relevant Alphadome solutions
5. When context is sufficient, introduce Alphadome Basic as the best starting point to begin system building
6. Explain value in outcomes, not hype: saved time, faster follow-up, better lead handling, clearer operations
7. Recommend WhatsApp bot automation first, then expand to additional AI workflows based on business needs
8. Use clear CTAs only after value is established (example: "If you'd like, we can start you on Basic and set up your first workflow.")
`.trim()
    : "";

  const trainingContext = buildTrainingContext(trainingData);
  const styleBlock = consultativeStyle ? `\n\n${consultativeStyle}` : "";
  const trainingBlock = trainingContext 
    ? `\n\n${guardrails}${styleBlock}\n\n---\n\nKNOWLEDGE BASE:\n\n${trainingContext}` 
    : `\n\n${guardrails}${styleBlock}`;

  return `${basePrompt}${trainingBlock}`.trim();
}

function findTrainingAnswer(trainingData = [], userMessage = "") {
  const text = (userMessage || "").toLowerCase().trim();
  if (!text || !trainingData.length) return null;

  const candidates = trainingData
    .map((entry) => {
      const q = (entry.question || "").toLowerCase().trim();
      const a = (entry.answer || "").trim();
      if (!a) return null;
      let score = 0;
      if (q && text.includes(q)) score = 3;
      else if (q && q.includes(text)) score = 2;
      else if (entry.category && text.includes(entry.category.toLowerCase())) score = 1;
      if (score === 0) return null;
      return {
        score,
        answer: a,
        priority: entry.priority || 0,
        confidence: Number(entry.confidence_score || 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.confidence - a.confidence;
    });

  return candidates[0]?.answer || null;
}

function findAutoResponse(templates = [], userMessage = "") {
  const text = String(userMessage || "").toLowerCase().trim();
  if (!text || !Array.isArray(templates) || !templates.length) return null;

  for (const tpl of templates) {
    if (!tpl || tpl.enabled === false) continue;
    const trigger = String(tpl.trigger || "").toLowerCase().trim();
    const response = String(tpl.response || "").trim();
    if (!trigger || !response) continue;
    if (text === trigger || text.includes(trigger)) return response;
  }
  return null;
}

// ========== Get Decrypted Credentials ==========
function getDecryptedCredentials(tenant) {
  if (!tenant) {
    return {
      whatsappToken: process.env.WHATSAPP_TOKEN,
      whatsappPhoneNumberId: process.env.PHONE_NUMBER_ID,
      aiApiKey: process.env.OPENAI_API_KEY,
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
    };
  }
  const isValidWhatsAppToken = (token) => {
    if (!token) return false;
    const t = String(token).trim();
    if (!t) return false;
    if (t.includes("ACCESS_TOKEN_PLACEHOLDER")) return false;
    if (t.includes("TOKEN_PLACEHOLDER")) return false;
    return true;
  };

  const isValidPhoneNumberId = (id) => {
    if (!id) return false;
    const value = String(id).trim();
    if (!value) return false;
    if (value.includes("PHONE_NUMBER_ID")) return false;
    if (value.includes("PLACEHOLDER")) return false;
    if (!/^\d+$/.test(value)) return false;
    return value.length >= 13;
  };

  const tenantToken = tenant.whatsapp_access_token;
  const tenantPhoneId = tenant.whatsapp_phone_number_id;
  const useFallbackWhatsApp =
    !isValidWhatsAppToken(tenantToken) || !isValidPhoneNumberId(tenantPhoneId);

  return {
    whatsappToken: useFallbackWhatsApp ? process.env.WHATSAPP_TOKEN : tenantToken,
    whatsappPhoneNumberId: useFallbackWhatsApp
      ? process.env.PHONE_NUMBER_ID
      : tenantPhoneId,
    aiApiKey: tenant.ai_api_key || process.env.OPENAI_API_KEY,
    aiProvider: tenant.ai_provider || "openai",
    aiModel: tenant.ai_model || "gpt-4o-mini",
  };
}

// ===== VERIFY META WEBHOOK =====
app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === verify_token) {
    log("Webhook verified!", "SYSTEM");
    res.status(200).send(challenge);
  } else {
    log("Webhook verification failed", "WARN");
    res.sendStatus(403);
  }
});

// ===== ADMIN DASHBOARD =====
app.get("/admin", adminAuth, (req, res) => {
  log(`Admin dashboard loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  if (!ADMIN_DASHBOARD_ENABLED) {
    return res.status(403).send("Admin dashboard disabled");
  }
  const dashboardPath = path.join(process.cwd(), "admin", "dashboard.html");
  return res.sendFile(dashboardPath);
});

// ===== TENANT DASHBOARD =====
app.get("/tenant-dashboard", tenantDashboardAuth, (req, res) => {
  log(`Tenant dashboard loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  const dashboardPath = path.join(process.cwd(), "admin", "tenant_dashboard.html");
  return res.sendFile(dashboardPath);
});

app.get("/admin/campaign-tracker", adminAuth, (req, res) => {
  log(`Campaign tracker loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  return res.sendFile(path.join(process.cwd(), "admin", "campaign_tracker.html"));
});

app.get("/admin/simple", adminAuth, (req, res) => {
  log(`Admin dashboard loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  if (!ADMIN_DASHBOARD_ENABLED) {
    return res.status(403).send("Admin dashboard disabled");
  }
  const dashboardPath = path.join(process.cwd(), "admin", "simple_upload.html");
  return res.sendFile(dashboardPath);
});

app.get("/admin/catalog", adminAuth, (req, res) => {
  log(`Admin dashboard loaded by ${req.ip} at ${new Date().toISOString()}`, "PAGE");
  if (!ADMIN_DASHBOARD_ENABLED) {
    return res.status(403).send("Admin dashboard disabled");
  }
  const dashboardPath = path.join(process.cwd(), "admin", "catalog.html");
  return res.sendFile(dashboardPath);
});

function parseIsoDate(dateValue) {
  const ts = new Date(dateValue || "").getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function extractWaTargetFromSubscription(sub) {
  if (sub?.metadata?.customer_wa) return String(sub.metadata.customer_wa);
  if (sub?.phone) return String(sub.phone);
  return "unknown";
}

function getLeadActionHint(sub) {
  const status = String(sub?.status || "").toLowerCase();
  if (status === "pending") return "Send RETRY prompt and check STK completion";
  if (status === "failed") return "Offer BANK first, COD second";
  if (status === "manual_pending_verification") return "Verify bank receipt and mark subscribed";
  if (status === "cod_pending_delivery") return "Confirm dispatch and delivery timeline";
  return "Review customer context and follow up";
}

function getSubscriptionContextLabel(sub) {
  const sku = String(sub?.product_sku || sub?.metadata?.sku || "").trim();
  if (sku) return `Product checkout (${sku})`;
  const planType = String(sub?.plan_type || "").trim();
  if (!planType) return "Checkout flow";
  return `${planType.toUpperCase()}${sub?.level ? ` L${sub.level}` : ""}`;
}

function getFailureReason(sub) {
  const metadata = sub?.metadata && typeof sub.metadata === "object" ? sub.metadata : {};
  return (
    metadata?.callback?.Body?.stkCallback?.ResultDesc ||
    metadata?.failure_reason ||
    metadata?.error_message ||
    null
  );
}

function countRecentErrorsFromLog(hours = 24) {
  try {
    const logPath = path.join(process.cwd(), "logs", "bot.log");
    if (!fs.existsSync(logPath)) return 0;
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    let errors = 0;
    for (const line of lines) {
      if (!line.includes("[ERROR]")) continue;
      const tsMatch = line.match(/^\[([^\]]+)\]/);
      const ts = tsMatch?.[1] ? new Date(tsMatch[1]).getTime() : 0;
      if (ts && ts >= cutoff) errors += 1;
    }
    return errors;
  } catch (err) {
    log(`Error counting logs: ${err.message}`, "WARN");
    return 0;
  }
}

function normalizeCampaignPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("254") && digits.length >= 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return null;
}

function parseLogTs(line) {
  const match = String(line || "").match(/^\[([^\]]+)\]/);
  if (!match?.[1]) return 0;
  const ts = new Date(match[1]).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function readRecentLogLines(logPath, {
  limit = 100,
  includeRegex = null,
} = {}) {
  try {
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, "utf8");
    const rows = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => includeRegex ? includeRegex.test(line) : true)
      .slice(-Math.max(1, Number(limit || 100)));
    return rows;
  } catch (err) {
    log(`Audit log read warning (${path.basename(logPath)}): ${err.message}`, "WARN");
    return [];
  }
}

function buildAdminAuditFeed({
  requestLimit = 80,
  systemLimit = 120,
  historyLimit = 40,
} = {}) {
  const requestLogPath = path.join(process.cwd(), "request.log");
  const botLogPath = path.join(process.cwd(), "logs", "bot.log");

  const requestLines = readRecentLogLines(requestLogPath, { limit: requestLimit });
  const systemLines = readRecentLogLines(botLogPath, {
    limit: systemLimit,
    includeRegex: /\[(ERROR|WARN|PAYMENT|SYSTEM|PAGE)\]/,
  });

  const requestEvents = requestLines.map((line) => {
    const ts = parseLogTs(line);
    const isError = /\s(4\d\d|5\d\d)\s-/.test(line);
    return {
      ts,
      source: "request",
      severity: isError ? "warning" : "info",
      category: "http",
      message: line,
    };
  });

  const systemEvents = systemLines.map((line) => {
    const ts = parseLogTs(line);
    const sevMatch = line.match(/\[(ERROR|WARN|PAYMENT|SYSTEM|PAGE)\]/);
    const sev = String(sevMatch?.[1] || "INFO").toUpperCase();
    const severity = sev === "ERROR" ? "critical" : sev === "WARN" ? "warning" : "info";
    return {
      ts,
      source: "system",
      severity,
      category: sev.toLowerCase(),
      message: line,
    };
  });

  return readCampaignHistory({ limit: historyLimit }).then((historyPayload) => {
    const historyEvents = (historyPayload.items || []).map((item) => {
      const ts = parseIsoDate(item.ran_at || item.created_at || item.updated_at);
      const status = String(item.status || "unknown").toLowerCase();
      const severity = status === "failed" ? "critical" : status === "partial" ? "warning" : "info";
      return {
        ts,
        source: "campaign",
        severity,
        category: "campaign",
        message: `Campaign ${item.template || "template"} (${item.audience || "audience"}) status=${status} success=${Number(item.success || 0)} failed=${Number(item.failed || 0)}`,
      };
    });

    const items = [...requestEvents, ...systemEvents, ...historyEvents]
      .filter((event) => event.ts > 0)
      .sort((a, b) => b.ts - a.ts);

    return {
      generated_at: new Date().toISOString(),
      counts: {
        total: items.length,
        critical: items.filter((x) => x.severity === "critical").length,
        warning: items.filter((x) => x.severity === "warning").length,
        info: items.filter((x) => x.severity === "info").length,
      },
      items,
    };
  });
}

async function buildTenantRiskWatchlist(limit = 30) {
  const resolvedLimit = Math.min(100, Math.max(1, Number(limit || 30)));
  let tenantResp = await supabase
    .from("bot_tenants")
    .select("id, client_name, client_phone, status, is_active, whatsapp_phone_number_id, whatsapp_access_token, updated_at, created_at")
    .order("updated_at", { ascending: false })
    .limit(resolvedLimit);

  if (tenantResp.error && isMissingColumnError(tenantResp.error)) {
    tenantResp = await supabase
      .from("bot_tenants")
      .select("id, client_name, client_phone, status, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(resolvedLimit);
  }

  if (tenantResp.error) throw tenantResp.error;

  const tenants = tenantResp.data || [];
  const nowMs = Date.now();

  const scored = tenants.map((tenant) => {
    let score = 0;
    const reasons = [];
    const active = isTenantRecordActive(tenant);
    const tenantPhone = normalizeCampaignPhone(tenant.client_phone);
    const updatedAtMs = parseIsoDate(tenant.updated_at || tenant.created_at || 0);
    const staleDays = updatedAtMs > 0 ? Math.floor((nowMs - updatedAtMs) / (24 * 60 * 60 * 1000)) : 999;

    if (!active) {
      score += 50;
      reasons.push("Tenant marked inactive");
    }
    if (!tenantPhone) {
      score += 25;
      reasons.push("Missing/invalid tenant phone");
    }
    if (staleDays >= 60) {
      score += 25;
      reasons.push(`No profile update for ${staleDays} days`);
    } else if (staleDays >= 30) {
      score += 15;
      reasons.push(`No profile update for ${staleDays} days`);
    }
    if (Object.prototype.hasOwnProperty.call(tenant, "whatsapp_phone_number_id") && !tenant.whatsapp_phone_number_id) {
      score += 15;
      reasons.push("WhatsApp phone_number_id missing");
    }
    if (Object.prototype.hasOwnProperty.call(tenant, "whatsapp_access_token") && !tenant.whatsapp_access_token) {
      score += 20;
      reasons.push("WhatsApp access token missing");
    }

    const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
    const nextAction =
      level === "high"
        ? "Immediate owner review: validate status, phone, and WhatsApp credentials"
        : level === "medium"
          ? "Review tenant setup and recency within 24h"
          : "Healthy baseline; monitor weekly";

    return {
      id: tenant.id,
      client_name: tenant.client_name || "Unknown tenant",
      client_phone: tenant.client_phone || "",
      status: tenant.status || (active ? "active" : "inactive"),
      is_active: active,
      updated_at: tenant.updated_at || tenant.created_at || null,
      stale_days: staleDays,
      risk_score: score,
      risk_level: level,
      reasons,
      next_action: nextAction,
    };
  });

  const watchlist = scored
    .filter((item) => item.risk_level !== "low")
    .sort((a, b) => b.risk_score - a.risk_score || b.stale_days - a.stale_days);

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total: scored.length,
      high: scored.filter((x) => x.risk_level === "high").length,
      medium: scored.filter((x) => x.risk_level === "medium").length,
      low: scored.filter((x) => x.risk_level === "low").length,
      watchlist_count: watchlist.length,
    },
    watchlist,
    tenants: scored.sort((a, b) => b.risk_score - a.risk_score),
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCampaignAudience(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "existing_db_users";
  if (["existing", "existing_db_users", "db", "db_users", "current_users"].includes(value)) return "existing_db_users";
  if (["new", "new_clients", "new_leads", "prospects"].includes(value)) return "new_clients";
  return "existing_db_users";
}

function collectManualCampaignPhones(input, excludePhones = [], limit = 25) {
  const blocked = new Set((excludePhones || []).map((x) => normalizeCampaignPhone(x)).filter(Boolean));
  const source = Array.isArray(input)
    ? input
    : String(input || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

  const seen = new Set();
  const leads = [];
  for (const raw of source) {
    const phone = normalizeCampaignPhone(raw);
    if (!phone || blocked.has(phone) || seen.has(phone)) continue;
    seen.add(phone);
    leads.push({ phone, name: "New Prospect" });
    if (leads.length >= Math.max(1, Number(limit || 25))) break;
  }
  return leads;
}

async function fetchAdminCampaignLeads({
  windowHours = 8760,
  limit = 100,
  excludeKeywords = ["gideon", "kassangas"],
  excludePhones = ["254702245555", "254117604817", "254743780542"],
}) {
  const since = new Date(Date.now() - Math.max(1, Number(windowHours || 8760)) * 60 * 60 * 1000).toISOString();

  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("user_id")
    .eq("direction", "incoming")
    .gte("created_at", since);

  if (convErr) throw convErr;

  const distinctUserIds = [...new Set((convRows || []).map((r) => r.user_id).filter(Boolean))];
  if (!distinctUserIds.length) return [];

  const { data: users, error: userErr } = await supabase
    .from("users")
    .select("id, phone, full_name")
    .in("id", distinctUserIds);

  if (userErr) throw userErr;

  const kw = (excludeKeywords || []).map((x) => String(x || "").toLowerCase()).filter(Boolean);
  const blocked = new Set((excludePhones || []).map((x) => normalizeCampaignPhone(x)).filter(Boolean));
  const seen = new Set();
  const leads = [];

  for (const user of users || []) {
    const phone = normalizeCampaignPhone(user.phone);
    if (!phone || blocked.has(phone) || seen.has(phone)) continue;
    const text = `${user.full_name || ""} ${user.phone || ""}`.toLowerCase();
    if (kw.some((k) => text.includes(k))) continue;
    seen.add(phone);
    leads.push({ phone, name: user.full_name || "Unknown" });
    if (leads.length >= Math.max(1, Number(limit || 100))) break;
  }

  return leads;
}

async function sendTemplateDirect(to, templateName = "alphadome", languageCode = "en") {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error("Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN");
  }

  const response = await axios.post(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );

  return response.data || null;
}

async function fetchTemplateDefinition(templateName = "alphadome") {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error("Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN");
  }

  const phoneRes = await axios.get(
    `https://graph.facebook.com/v21.0/${phoneNumberId}`,
    {
      params: { fields: "whatsapp_business_account" },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    }
  );

  const wabaId = phoneRes?.data?.whatsapp_business_account?.id;
  if (!wabaId) {
    throw new Error("Unable to resolve whatsapp_business_account id");
  }

  const tmplRes = await axios.get(
    `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
    {
      params: {
        name: templateName,
        fields: "name,status,category,language,components",
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    }
  );

  return {
    waba_id: wabaId,
    data: tmplRes?.data?.data || [],
    paging: tmplRes?.data?.paging || null,
  };
}

function isMissingColumnError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const details = String(error?.details || "").toLowerCase();
  const hint = String(error?.hint || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  const combined = `${msg} ${details} ${hint}`;
  return (
    code === "42703" ||
    (combined.includes("column") && combined.includes("does not exist")) ||
    combined.includes("schema cache")
  );
}

function buildPerformanceReportFromOps(ops, period = "daily") {
  const k = ops?.kpis || {};
  const hotLeads = ops?.operations?.hot_leads || [];
  const conversion = Number(k.conversion_rate_pct_30d || 0);
  const attempts = Number(k.payment_attempts_30d || 0);
  const revenue = Number(k.total_revenue_kes_30d || 0);

  const summary = {
    period,
    generated_at: new Date().toISOString(),
    revenue_kes: revenue,
    attempts,
    successful_payments: Number(k.successful_payments_30d || 0),
    failed_payments: Number(k.failed_payments_30d || 0),
    pending_payments: Number(k.pending_payments_30d || 0),
    conversion_rate_pct: conversion,
    incoming_messages_24h: Number(k.incoming_messages_24h || 0),
    llm_usage_24h: Number(k.llm_usage_24h || 0),
    health_status: String(k.health_status || "unknown"),
    hot_leads_count: hotLeads.length,
  };

  const performanceBand =
    revenue >= 50000 ? "strong" :
    revenue >= 10000 ? "building" :
    attempts > 0 ? "early" : "pre-revenue";

  const actionPlan = [];
  if (attempts === 0) actionPlan.push("Launch outreach campaign immediately (min 50 contacts) to generate first payment attempts.");
  if (attempts > 0 && conversion < 20) actionPlan.push("Improve checkout completion: assign fast follow-up on all pending and failed payments.");
  if (Number(k.failed_payments_30d || 0) > Number(k.successful_payments_30d || 0)) {
    actionPlan.push("Prioritize BANK fallback in customer scripts until M-Pesa stability improves.");
  }
  if (hotLeads.length > 0) actionPlan.push(`Close ${hotLeads.length} hot leads today; target <10 minutes response per lead.`);
  if (!actionPlan.length) actionPlan.push("Maintain current cadence and scale outreach volume while protecting response speed.");

  return {
    summary,
    performance_band: performanceBand,
    strategies: ops?.strategies || [],
    action_plan: actionPlan,
    top_hot_leads: hotLeads.slice(0, 10),
    recent_progress: (ops?.progress || []).slice(0, 10),
  };
}

async function buildAdminOpsOverview() {
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  let tenants = [];
  {
    let resp = await supabase.from("bot_tenants").select("id, client_name, client_phone, status, is_active, updated_at");
    if (resp.error && isMissingColumnError(resp.error)) {
      resp = await supabase.from("bot_tenants").select("id, client_name, client_phone, status, updated_at");
    }
    if (resp.error) throw resp.error;
    tenants = resp.data || [];
  }

  let subscriptions = [];
  {
    let resp = await supabase
      .from("subscriptions")
      .select("id, user_id, phone, amount, plan_type, level, status, metadata, created_at, updated_at")
      .gte("created_at", since30d);
    if (resp.error && isMissingColumnError(resp.error)) {
      resp = await supabase
        .from("subscriptions")
        .select("id, user_id, phone, amount, status, metadata, created_at, updated_at")
        .gte("created_at", since30d);
    }
    if (resp.error) throw resp.error;
    subscriptions = resp.data || [];
  }

  let conversations = [];
  {
    let resp = await supabase
      .from("conversations")
      .select("id, user_id, direction, llm_used, created_at")
      .gte("created_at", since7d);
    if (resp.error && isMissingColumnError(resp.error)) {
      resp = await supabase
        .from("conversations")
        .select("id, user_id, direction, created_at")
        .gte("created_at", since7d);
    }
    if (resp.error) throw resp.error;
    conversations = (resp.data || []).map((row) => ({ ...row, llm_used: Boolean(row.llm_used) }));
  }

  let users = [];
  {
    let resp = await supabase.from("users").select("id, created_at").gte("created_at", since30d);
    if (resp.error && isMissingColumnError(resp.error)) {
      resp = await supabase.from("users").select("id");
    }
    if (resp.error) throw resp.error;
    users = resp.data || [];
  }

  const completedStatuses = new Set(["subscribed", "completed", "active"]);

  const successfulSubs = subscriptions.filter((s) => completedStatuses.has(String(s.status || "").toLowerCase()));
  const failedSubs = subscriptions.filter((s) => String(s.status || "").toLowerCase() === "failed");
  const pendingSubs = subscriptions.filter((s) => String(s.status || "").toLowerCase() === "pending");
  const manualPending = subscriptions.filter((s) => String(s.status || "").toLowerCase() === "manual_pending_verification");
  const codPending = subscriptions.filter((s) => String(s.status || "").toLowerCase() === "cod_pending_delivery");

  const revenueKes = successfulSubs.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const attemptsCount = subscriptions.length;
  const successCount = successfulSubs.length;
  const failedCount = failedSubs.length;
  const pendingCount = pendingSubs.length;
  const conversionRate = attemptsCount > 0 ? Math.round((successCount / attemptsCount) * 100) : 0;

  const recentIncoming24h = conversations.filter((c) => {
    const ts = parseIsoDate(c.created_at);
    return ts >= parseIsoDate(since24h) && c.direction === "incoming";
  });
  const recentOutgoing24h = conversations.filter((c) => {
    const ts = parseIsoDate(c.created_at);
    return ts >= parseIsoDate(since24h) && c.direction === "outgoing";
  });
  const llmUsage24h = conversations.filter((c) => parseIsoDate(c.created_at) >= parseIsoDate(since24h) && c.llm_used).length;

  const hotLeads = subscriptions
    .filter((s) => {
      const status = String(s.status || "").toLowerCase();
      if (!["pending", "failed", "manual_pending_verification", "cod_pending_delivery"].includes(status)) return false;
      return parseIsoDate(s.updated_at || s.created_at) >= parseIsoDate(since24h);
    })
    .sort((a, b) => parseIsoDate(b.updated_at || b.created_at) - parseIsoDate(a.updated_at || a.created_at))
    .slice(0, 15)
    .map((s) => ({
      subscription_id: s.id,
      wa_phone: extractWaTargetFromSubscription(s),
      amount: Number(s.amount) || 0,
      status: s.status,
      plan: `${String(s.plan_type || "").toUpperCase()}${s.level ? ` L${s.level}` : ""}`,
      updated_at: s.updated_at || s.created_at,
      action_hint: getLeadActionHint(s),
    }));

  const outreachCandidates = subscriptions
    .filter((s) => ["failed", "pending", "manual_pending_verification", "cod_pending_delivery"].includes(String(s.status || "").toLowerCase()))
    .slice()
    .sort((a, b) => parseIsoDate(b.updated_at || b.created_at) - parseIsoDate(a.updated_at || a.created_at))
    .slice(0, 12);

  const outreachUserIds = [...new Set(outreachCandidates.map((s) => s.user_id).filter(Boolean))];
  let outreachUsers = [];
  let outreachConversations = [];
  if (outreachUserIds.length) {
    const [{ data: userRows, error: userErr }, { data: convRows, error: convErr }] = await Promise.all([
      supabase.from("users").select("id, phone, full_name").in("id", outreachUserIds),
      supabase
        .from("conversations")
        .select("user_id, direction, message_text, created_at")
        .in("user_id", outreachUserIds)
        .gte("created_at", since30d)
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    if (userErr) throw userErr;
    if (convErr) throw convErr;
    outreachUsers = userRows || [];
    outreachConversations = convRows || [];
  }

  const outreachUserMap = new Map((outreachUsers || []).map((u) => [u.id, u]));
  const lastInboundByUser = new Map();
  const lastConversationByUser = new Map();
  for (const row of outreachConversations || []) {
    if (!lastConversationByUser.has(row.user_id)) lastConversationByUser.set(row.user_id, row);
    if (row.direction === "incoming" && !lastInboundByUser.has(row.user_id)) lastInboundByUser.set(row.user_id, row);
  }

  const failedPaymentOutreach = outreachCandidates
    .filter((s) => String(s.status || "").toLowerCase() === "failed")
    .map((s) => {
      const user = outreachUserMap.get(s.user_id);
      const lastInbound = lastInboundByUser.get(s.user_id);
      const lastConversation = lastConversationByUser.get(s.user_id);
      return {
        subscription_id: s.id,
        customer_name: user?.full_name || "Unknown User",
        wa_phone: normalizeCampaignPhone(user?.phone) || extractWaTargetFromSubscription(s),
        payment_phone: normalizeCampaignPhone(s.phone),
        amount: Number(s.amount) || 0,
        status: s.status,
        context_label: getSubscriptionContextLabel(s),
        action_hint: getLeadActionHint(s),
        failure_reason: getFailureReason(s),
        updated_at: s.updated_at || s.created_at,
        last_customer_message: lastInbound?.message_text || null,
        last_customer_message_at: lastInbound?.created_at || null,
        last_activity_at: lastConversation?.created_at || null,
      };
    });

  const recentProgress = subscriptions
    .slice()
    .sort((a, b) => parseIsoDate(b.updated_at || b.created_at) - parseIsoDate(a.updated_at || a.created_at))
    .slice(0, 12)
    .map((s) => ({
      when: s.updated_at || s.created_at,
      subscription_id: s.id,
      phone: extractWaTargetFromSubscription(s),
      status: s.status,
      amount: Number(s.amount) || 0,
      note: `Subscription ${s.id.slice(0, 8)} moved to ${String(s.status || "unknown").toUpperCase()}`,
    }));

  const strategies = [];
  if (recentIncoming24h.length === 0) {
    strategies.push("Traffic is zero in last 24h. Run outbound template campaign immediately and target at least 50 contacts today.");
  }
  if (attemptsCount === 0) {
    strategies.push("No payment attempts yet. Push every active chat to checkout with JOIN ALPHADOME MONTHLY LEVEL 1 flow.");
  }
  if (failedCount > successCount) {
    strategies.push("Failed payments exceed successful ones. Default recovery script to BANK first, COD second while M-Pesa EPI stabilizes.");
  }
  if (pendingCount > 0) {
    strategies.push(`There are ${pendingCount} pending payments. Use the hot lead queue and close each one within 10 minutes.`);
  }
  if (manualPending.length > 0) {
    strategies.push(`You have ${manualPending.length} bank receipts pending verification. Clear these first for fastest revenue recognition.`);
  }
  if (codPending.length > 0) {
    strategies.push(`You have ${codPending.length} COD orders pending delivery confirmation. Trigger logistics follow-up now.`);
  }
  if (!strategies.length) {
    strategies.push("Maintain current momentum: run outreach every morning, monitor hot leads hourly, and optimize top converting payment route.");
  }

  const activeTenants = tenants.filter((t) => isTenantRecordActive(t));
  const errors24h = countRecentErrorsFromLog(24);

  return {
    generated_at: new Date().toISOString(),
    kpis: {
      active_tenants: activeTenants.length,
      total_tenants: tenants.length,
      total_revenue_kes_30d: Math.round(revenueKes),
      payment_attempts_30d: attemptsCount,
      successful_payments_30d: successCount,
      failed_payments_30d: failedCount,
      pending_payments_30d: pendingCount,
      conversion_rate_pct_30d: conversionRate,
      llm_usage_24h: llmUsage24h,
      incoming_messages_24h: recentIncoming24h.length,
      outgoing_messages_24h: recentOutgoing24h.length,
      new_users_30d: users.length,
      errors_24h: errors24h,
      health_status: errors24h > 20 ? "degraded" : "healthy",
    },
    operations: {
      hot_leads: hotLeads,
      failed_payment_outreach: failedPaymentOutreach,
      fallback_pipeline: {
        failed: failedCount,
        bank_pending_verification: manualPending.length,
        cod_pending_delivery: codPending.length,
      },
    },
    progress: recentProgress,
    strategies,
  };
}

app.get("/admin/api/ops-overview", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json(payload);
  } catch (err) {
    log(`Admin ops overview error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/ops-overview", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json(payload);
  } catch (err) {
    log(`Admin ops overview alias error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/tenants/active", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.active_tenants });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/tenants/active", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.active_tenants });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/api/tenants/list", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "25", 10)));
    let resp = await supabase
      .from("bot_tenants")
      .select("id, client_name, client_phone, status, is_active, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (resp.error && isMissingColumnError(resp.error)) {
      resp = await supabase
        .from("bot_tenants")
        .select("id, client_name, client_phone, status, updated_at")
        .order("updated_at", { ascending: false })
        .limit(limit);
    }

    if (resp.error) {
      throw resp.error;
    }

    const tenants = (resp.data || []).map((tenant) => ({
      id: tenant.id,
      client_name: tenant.client_name || "Unknown tenant",
      client_phone: tenant.client_phone || "",
      status: tenant.status || (tenant.is_active === false ? "inactive" : "active"),
      is_active: tenant.is_active !== false,
      updated_at: tenant.updated_at || null,
    }));

    return res.json({ ok: true, count: tenants.length, tenants });
  } catch (err) {
    log(`Admin tenants list error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, tenants: [] });
  }
});

app.patch("/admin/api/tenants/:tenantId", adminAuth, async (req, res) => {
  try {
    const tenantId = String(req.params.tenantId || "").trim();
    const actor = String(req.headers["x-admin-actor"] || req.query.actor || "admin").trim();
    const updates = { updated_at: new Date().toISOString() };
    const body = req.body || {};
    const allowedStatuses = new Set(["active", "inactive"]);

    if (!tenantId) {
      return res.status(400).json({ error: "tenantId is required" });
    }

    const existingResp = await supabase
      .from("bot_tenants")
      .select("id, client_name, client_phone, status, is_active, updated_at")
      .eq("id", tenantId)
      .maybeSingle();

    if (existingResp.error) {
      throw existingResp.error;
    }
    if (!existingResp.data) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    if (typeof body.client_name === "string" && body.client_name.trim()) {
      updates.client_name = body.client_name.trim().replace(/\s+/g, " ");
    }
    if (typeof body.client_phone === "string" && body.client_phone.trim()) {
      const normalizedPhone = normalizeTenantAdminPhone(body.client_phone);
      if (!normalizedPhone) {
        return res.status(400).json({ error: "Invalid client_phone format. Use an international number like 2547XXXXXXXX." });
      }
      updates.client_phone = normalizedPhone;
    }
    if (typeof body.status === "string" && body.status.trim()) {
      const normalizedStatus = body.status.trim().toLowerCase();
      if (!allowedStatuses.has(normalizedStatus)) {
        return res.status(400).json({ error: "Invalid status. Allowed values: active, inactive." });
      }
      updates.status = normalizedStatus;
      updates.is_active = normalizedStatus === "active";
    }
    if (typeof body.is_active === "boolean") {
      if (updates.status && body.is_active !== (updates.status === "active")) {
        return res.status(400).json({ error: "status and is_active values are inconsistent." });
      }
      updates.is_active = body.is_active;
      if (!updates.status) {
        updates.status = body.is_active ? "active" : "inactive";
      }
    }

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: "No editable fields provided" });
    }

    if (updates.client_phone) {
      const phoneCandidates = buildPhoneCandidates(updates.client_phone);
      if (!phoneCandidates.length) {
        return res.status(400).json({ error: "Unable to normalize tenant phone for duplicate validation." });
      }
      const duplicateResp = await supabase
        .from("bot_tenants")
        .select("id, client_name, client_phone")
        .in("client_phone", phoneCandidates)
        .neq("id", tenantId)
        .limit(1);
      if (duplicateResp.error) {
        throw duplicateResp.error;
      }
      if (Array.isArray(duplicateResp.data) && duplicateResp.data.length) {
        const duplicate = duplicateResp.data[0];
        return res.status(409).json({
          error: "Another tenant already uses this phone number.",
          duplicate: {
            id: duplicate.id,
            client_name: duplicate.client_name,
            client_phone: duplicate.client_phone,
          },
        });
      }
    }

    let updateResp = await supabase
      .from("bot_tenants")
      .update(updates)
      .eq("id", tenantId)
      .select("id, client_name, client_phone, status, is_active, updated_at")
      .maybeSingle();

    if (updateResp.error && isMissingColumnError(updateResp.error) && Object.prototype.hasOwnProperty.call(updates, "is_active")) {
      const fallbackUpdates = { ...updates };
      delete fallbackUpdates.is_active;
      updateResp = await supabase
        .from("bot_tenants")
        .update(fallbackUpdates)
        .eq("id", tenantId)
        .select("id, client_name, client_phone, status, updated_at")
        .maybeSingle();
    }

    if (updateResp.error) throw updateResp.error;
    if (!updateResp.data) return res.status(404).json({ error: "Tenant not found" });

    await appendAdminAction({
      when: new Date().toISOString(),
      action: "tenant.update",
      status: "success",
      actor,
      source_ip: req.ip,
      tenant_id: tenantId,
      note: `Updated tenant ${tenantId}`,
      metadata: {
        fields: Object.keys(updates).filter((field) => field !== "updated_at"),
      },
    });

    return res.json({ ok: true, tenant: updateResp.data });
  } catch (err) {
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "tenant.update",
      status: "failed",
      actor: String(req.headers["x-admin-actor"] || req.query.actor || "admin").trim(),
      source_ip: req.ip,
      tenant_id: String(req.params.tenantId || "").trim(),
      note: err.message,
    });
    log(`Admin tenant edit error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/llm/usage", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.llm_usage_24h });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/llm/usage", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.llm_usage_24h });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/api/errors/count", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.errors_24h });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/errors/count", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ count: payload.kpis.errors_24h });
  } catch (err) {
    return res.status(500).json({ error: err.message, count: "--" });
  }
});

app.get("/admin/api/health", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ status: payload.kpis.health_status });
  } catch (err) {
    return res.status(500).json({ error: err.message, status: "unknown" });
  }
});

app.get("/admin/api/performance-report", adminAuth, async (req, res) => {
  try {
    const period = String(req.query.period || "daily").toLowerCase() === "weekly" ? "weekly" : "daily";
    const ops = await buildAdminOpsOverview();
    const report = buildPerformanceReportFromOps(ops, period);
    return res.json(report);
  } catch (err) {
    log(`Admin performance report error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/performance-report/export", adminAuth, async (req, res) => {
  try {
    const period = String(req.query.period || "daily").toLowerCase() === "weekly" ? "weekly" : "daily";
    const format = String(req.query.format || "csv").toLowerCase() === "pdf" ? "pdf" : "csv";
    const ops = await buildAdminOpsOverview();
    const report = buildPerformanceReportFromOps(ops, period);
    const summary = report.summary || {};
    const actionPlan = Array.isArray(report.action_plan) ? report.action_plan : [];
    const kpis = ops?.kpis || {};

    const rows = [
      ["section", "metric", "value"],
      ["summary", "generated_at", summary.generated_at || new Date().toISOString()],
      ["summary", "period", summary.period || period],
      ["summary", "performance_band", report.performance_band || "n/a"],
      ["summary", "revenue_kes", summary.revenue_kes || 0],
      ["summary", "conversion_rate_pct", summary.conversion_rate_pct || 0],
      ["summary", "hot_leads_count", summary.hot_leads_count || 0],
      ["kpi", "active_tenants", kpis.active_tenants || 0],
      ["kpi", "payment_attempts_30d", kpis.payment_attempts_30d || 0],
      ["kpi", "successful_payments_30d", kpis.successful_payments_30d || 0],
      ["kpi", "failed_payments_30d", kpis.failed_payments_30d || 0],
      ["kpi", "pending_payments_30d", kpis.pending_payments_30d || 0],
      ["kpi", "incoming_messages_24h", kpis.incoming_messages_24h || 0],
      ["kpi", "llm_usage_24h", kpis.llm_usage_24h || 0],
    ];

    actionPlan.forEach((item, index) => {
      rows.push(["action_plan", String(index + 1), item]);
    });

    if (format === "pdf") {
      const pdfBuffer = buildSimplePdfBuffer(rows.slice(1), {
        title: `Alphadome Performance Report (${period.toUpperCase()})`,
        subtitle: `Revenue, conversion, tenant health, and action priorities`,
        generated_at: summary.generated_at || new Date().toISOString(),
      });
      const fileName = `alphadome-performance-${period}-${new Date().toISOString().slice(0, 10)}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
      return res.send(pdfBuffer);
    }

    const csv = buildCsvFromRows(rows);
    const fileName = `alphadome-performance-${period}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    return res.send(csv);
  } catch (err) {
    log(`Admin performance report export error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/campaign/history", adminAuth, async (req, res) => {
  try {
    const filters = parseCampaignHistoryFilters(req.query || {});
    const exportAsCsv = String(req.query.export || "").toLowerCase() === "csv";
    const result = await readCampaignHistory(filters);

    if (exportAsCsv) {
      const rows = [
        ["run_id", "ran_at", "status", "dry_run", "audience", "template", "language", "total", "success", "failed"],
        ...result.items.map((item) => [
          item.run_id || "",
          item.ran_at || "",
          item.status || "",
          item.dry_run ? "true" : "false",
          item.audience || "",
          item.template || "",
          item.language || "",
          Number(item.total || 0),
          Number(item.success || 0),
          Number(item.failed || 0),
        ]),
      ];
      const fileName = `alphadome-campaign-history-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
      return res.send(buildCsvFromRows(rows));
    }

    return res.json({
      ok: true,
      total_count: result.all_count,
      filtered_count: result.filtered_count,
      last_run: result.items[0] || null,
      history: result.items,
      applied_filters: {
        from: filters.from ? filters.from.toISOString() : "",
        to: filters.to ? filters.to.toISOString() : "",
        audience: filters.audience,
        template: filters.template,
        status: filters.status,
      },
    });
  } catch (err) {
    log(`Admin campaign history error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, history: [], last_run: null, filtered_count: 0, total_count: 0 });
  }
});

app.get("/admin/api/policies", adminAuth, async (req, res) => {
  return res.json({
    ok: true,
    policies: {
      require_live_confirm: ADMIN_POLICY_REQUIRE_LIVE_CONFIRM,
      require_dry_run_first: ADMIN_POLICY_REQUIRE_DRY_RUN_FIRST,
    },
  });
});

app.get("/admin/api/audit/actions", adminAuth, async (req, res) => {
  try {
    const filters = parseAdminActionFilters(req.query || {});
    const exportAsCsv = String(req.query.export || "").toLowerCase() === "csv";
    const result = await readAdminActions(filters);

    if (exportAsCsv) {
      const rows = [
        ["when", "action", "status", "actor", "source_ip", "note"],
        ...result.items.map((item) => [
          item.when || "",
          item.action || "",
          item.status || "",
          item.actor || "",
          item.source_ip || "",
          item.note || "",
        ]),
      ];
      const fileName = `alphadome-admin-actions-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
      return res.send(buildCsvFromRows(rows));
    }

    return res.json({
      ok: true,
      total_count: result.all_count,
      filtered_count: result.filtered_count,
      actions: result.items,
    });
  } catch (err) {
    log(`Admin action audit error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, actions: [], filtered_count: 0, total_count: 0 });
  }
});

// Campaign reply tracker — shows sent numbers vs who replied
app.get("/admin/api/campaign/replies", adminAuth, async (req, res) => {
  try {
    const phones = String(req.query.phones || "").split(",").map(p => normalizeCampaignPhone(p.trim())).filter(Boolean);
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (isNaN(since.getTime())) return res.status(400).json({ error: "Invalid since date" });
    if (!phones.length) return res.status(400).json({ error: "phones required (comma-separated)" });

    // Resolve phones → user_ids
    const { data: userRows } = await supabase.from("users").select("id, phone, full_name").in("phone", phones);
    const phoneToUser = new Map((userRows || []).map(u => [normalizeCampaignPhone(u.phone), u]));

    // For each user, get their inbound messages after `since`
    const userIds = (userRows || []).map(u => u.id).filter(Boolean);
    let replyMap = new Map();
    if (userIds.length) {
      const { data: replies } = await supabase
        .from("conversations")
        .select("user_id, message, created_at")
        .in("user_id", userIds)
        .eq("direction", "incoming")
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: true });
      for (const r of replies || []) {
        if (!replyMap.has(r.user_id)) replyMap.set(r.user_id, { first_reply_at: r.created_at, message: r.message, count: 0 });
        replyMap.get(r.user_id).count++;
      }
    }

    const rows = phones.map(phone => {
      const user = phoneToUser.get(phone);
      const reply = user ? replyMap.get(user.id) : null;
      return {
        phone,
        name: user?.full_name || "Unknown",
        replied: !!reply,
        reply_count: reply?.count || 0,
        first_reply_at: reply?.first_reply_at || null,
        first_message: reply?.message ? reply.message.substring(0, 120) : null,
      };
    });

    const replied = rows.filter(r => r.replied).length;
    return res.json({ ok: true, since: since.toISOString(), total: phones.length, replied, pending: phones.length - replied, rows });
  } catch (err) {
    log(`Campaign replies error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

// DB tables health check — confirms key tables are accessible
app.get("/admin/api/db-tables", adminAuth, async (req, res) => {
  const tables = ["conversations", "users", "bot_tenants", "bot_products", "subscriptions", "user_sessions", "bot_orders", "whatsapp_logs"];
  const results = [];
  for (const t of tables) {
    const { count, error } = await supabase.from(t).select("*", { count: "exact", head: true });
    results.push({ table: t, ok: !error, count: count ?? 0, error: error?.message || null });
  }
  const allOk = results.every(r => r.ok);
  return res.json({ ok: allOk, tables: results });
});

app.get("/admin/api/audit/feed", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(20, parseInt(req.query.limit || "120", 10)));
    const source = String(req.query.source || "all").toLowerCase();
    const severity = String(req.query.severity || "all").toLowerCase();

    const payload = await buildAdminAuditFeed({
      requestLimit: Math.max(60, limit),
      systemLimit: Math.max(80, limit),
      historyLimit: Math.max(30, Math.floor(limit / 2)),
    });

    let items = payload.items || [];
    if (source !== "all") items = items.filter((item) => item.source === source);
    if (severity !== "all") items = items.filter((item) => item.severity === severity);

    return res.json({
      ok: true,
      generated_at: payload.generated_at,
      counts: payload.counts,
      filtered_count: items.length,
      items: items.slice(0, limit),
    });
  } catch (err) {
    log(`Admin audit feed error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, items: [] });
  }
});

app.get("/admin/api/tenants/risk", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || "30", 10)));
    const minLevel = String(req.query.min_level || "all").toLowerCase();
    const payload = await buildTenantRiskWatchlist(limit);

    let watchlist = payload.watchlist || [];
    if (minLevel === "high") watchlist = watchlist.filter((item) => item.risk_level === "high");
    if (minLevel === "medium") watchlist = watchlist.filter((item) => ["high", "medium"].includes(item.risk_level));

    return res.json({
      ok: true,
      generated_at: payload.generated_at,
      summary: payload.summary,
      watchlist_count: watchlist.length,
      watchlist,
      tenants: payload.tenants,
    });
  } catch (err) {
    log(`Admin tenant risk error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, watchlist: [], tenants: [] });
  }
});

app.get("/admin/api/sla/recovery-board", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || "40", 10)));
    const payload = await buildSlaRecoveryBoard(limit);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin SLA board error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, items: [] });
  }
});

app.post("/admin/api/recovery/action", adminAuth, async (req, res) => {
  try {
    const role = ensureAdminRole(req, ["super_admin", "operations", "finance", "support"]);
    if (!role) {
      return res.status(403).json({ error: "Role not allowed for recovery actions" });
    }
    const action = String(req.body?.action || "").trim();
    const subscriptionId = String(req.body?.subscription_id || "").trim();
    if (!action || !subscriptionId) {
      return res.status(400).json({ error: "action and subscription_id are required" });
    }
    const result = await performAdminRecoveryAction({
      action,
      subscriptionId,
      actor: getAdminActor(req),
      sourceIp: req.ip,
    });
    return res.json(result);
  } catch (err) {
    await appendAdminAction({
      when: new Date().toISOString(),
      action: `recovery.${String(req.body?.action || "unknown")}`,
      status: "failed",
      actor: getAdminActor(req),
      source_ip: req.ip,
      note: err.message,
      metadata: { subscription_id: String(req.body?.subscription_id || "") },
    });
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.get("/admin/api/tenants/readiness", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(5, parseInt(req.query.limit || "60", 10)));
    const payload = await buildTenantReadinessReport(limit);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin tenant readiness error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, tenants: [] });
  }
});

app.get("/admin/api/revenue/command-center", adminAuth, async (req, res) => {
  try {
    const payload = await buildRevenueCommandCenter();
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin revenue center error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.get("/admin/api/templates/ops", adminAuth, async (req, res) => {
  try {
    const payload = await buildTemplateOpsCenter();
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin template ops error: ${err.message}`, "ERROR");
    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      count: 0,
      templates: [],
      degraded: true,
      degraded_reason: err.message,
    });
  }
});

app.get("/admin/api/support/inbox", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || "40", 10)));
    const payload = await buildSupportInbox(limit);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin support inbox error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, items: [] });
  }
});

app.get("/admin/api/finance/reconciliation", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(5, parseInt(req.query.limit || "60", 10)));
    const payload = await buildFinanceReconciliation(limit);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    log(`Admin finance reconciliation error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message, ok: false, items: [] });
  }
});

app.get("/admin/api/incidents/active", adminAuth, async (req, res) => {
  const incident = await readActiveIncident();
  return res.json({ ok: true, incident: incident || null });
});

app.post("/admin/api/incidents/active", adminAuth, async (req, res) => {
  try {
    const role = ensureAdminRole(req, ["super_admin", "operations"]);
    if (!role) return res.status(403).json({ error: "Role not allowed to manage incidents" });
    const resolve = Boolean(req.body?.resolve);
    if (resolve) {
      await writeActiveIncident(null);
      await appendAdminAction({
        when: new Date().toISOString(),
        action: "incident.resolve",
        status: "success",
        actor: getAdminActor(req),
        source_ip: req.ip,
        note: "Active incident cleared",
      });
      return res.json({ ok: true, incident: null });
    }
    const payload = {
      id: `inc_${Date.now()}`,
      title: String(req.body?.title || "Platform Incident").trim(),
      message: String(req.body?.message || "").trim(),
      severity: String(req.body?.severity || "warning").trim().toLowerCase(),
      status: String(req.body?.status || "active").trim().toLowerCase(),
      declared_by: getAdminActor(req),
      declared_role: role,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await writeActiveIncident(payload);
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "incident.declare",
      status: "success",
      actor: getAdminActor(req),
      source_ip: req.ip,
      note: payload.title,
      metadata: { severity: payload.severity },
    });
    return res.json({ ok: true, incident: payload });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.get("/admin/api/approvals", adminAuth, async (req, res) => {
  try {
    const rows = await readApprovalRequests();
    return res.json({ ok: true, count: rows.length, approvals: rows.slice(0, 200) });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false, approvals: [] });
  }
});

app.post("/admin/api/approvals", adminAuth, async (req, res) => {
  try {
    const record = await createApprovalRequest({
      action: String(req.body?.action || "manual_request").trim(),
      requested_by: getAdminActor(req),
      requested_role: getAdminRole(req),
      payload: req.body?.payload || {},
      note: String(req.body?.note || "").trim(),
      source_ip: req.ip,
    });
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "approval.create",
      status: "success",
      actor: getAdminActor(req),
      source_ip: req.ip,
      note: `${record.action} requested`,
      metadata: { approval_id: record.id },
    });
    return res.status(201).json({ ok: true, approval: record });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.post("/admin/api/approvals/:approvalId/resolve", adminAuth, async (req, res) => {
  try {
    const role = ensureAdminRole(req, ["super_admin"]);
    if (!role) return res.status(403).json({ error: "Only super_admin can resolve approvals" });
    const approval = await resolveApprovalRequest(String(req.params.approvalId || "").trim(), {
      reviewer: getAdminActor(req),
      status: String(req.body?.status || "approved").trim().toLowerCase(),
      note: String(req.body?.note || "").trim(),
    });
    if (!approval) return res.status(404).json({ error: "Approval not found" });
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "approval.resolve",
      status: "success",
      actor: getAdminActor(req),
      source_ip: req.ip,
      note: `${approval.id} -> ${approval.status}`,
      metadata: { approval_id: approval.id },
    });
    return res.json({ ok: true, approval });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.post("/admin/api/tenants/bulk", adminAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    const tenantIds = Array.isArray(req.body?.tenant_ids) ? req.body.tenant_ids.map((id) => String(id).trim()).filter(Boolean) : [];
    const dryRun = Boolean(req.body?.dry_run);
    const role = getAdminRole(req);
    const actor = getAdminActor(req);
    if (!action || !tenantIds.length) {
      return res.status(400).json({ error: "action and tenant_ids are required" });
    }

    let { data: tenants, error } = await supabase
      .from("bot_tenants")
      .select("id, client_name, client_phone, status, is_active")
      .in("id", tenantIds);
    if (error && isMissingColumnError(error)) {
      ({ data: tenants, error } = await supabase
        .from("bot_tenants")
        .select("id, client_name, client_phone, status")
        .in("id", tenantIds));
    }
    if (error) throw error;
    const preview = (tenants || []).map((tenant) => ({
      id: tenant.id,
      client_name: tenant.client_name,
      current_status: tenant.status || (tenant.is_active === false ? "inactive" : "active"),
      next_status: action === "activate" ? "active" : action === "deactivate" ? "inactive" : tenant.status,
    }));

    if (dryRun) {
      return res.json({ ok: true, dry_run: true, count: preview.length, preview });
    }

    if (action === "deactivate" && role !== "super_admin") {
      const approval = await createApprovalRequest({
        action: "tenant.bulk_deactivate",
        requested_by: actor,
        requested_role: role,
        payload: { tenant_ids: tenantIds },
        note: `Bulk deactivate requested for ${tenantIds.length} tenant(s)`,
        source_ip: req.ip,
      });
      return res.status(202).json({ ok: true, approval_requested: true, approval });
    }

    if (!["activate", "deactivate"].includes(action)) {
      return res.status(400).json({ error: "Unsupported bulk action" });
    }

    const updates = {
      status: action === "activate" ? "active" : "inactive",
      is_active: action === "activate",
      updated_at: new Date().toISOString(),
    };
    let { error: updateErr } = await supabase.from("bot_tenants").update(updates).in("id", tenantIds);
    if (updateErr && isMissingColumnError(updateErr)) {
      const fallbackUpdates = {
        status: updates.status,
        updated_at: updates.updated_at,
      };
      ({ error: updateErr } = await supabase.from("bot_tenants").update(fallbackUpdates).in("id", tenantIds));
    }
    if (updateErr) throw updateErr;
    await appendAdminAction({
      when: new Date().toISOString(),
      action: `tenant.bulk_${action}`,
      status: "success",
      actor,
      source_ip: req.ip,
      note: `${tenantIds.length} tenant(s) updated`,
      metadata: { tenant_ids: tenantIds },
    });
    return res.json({ ok: true, count: tenantIds.length, preview });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.get("/admin/api/executive-snapshot", adminAuth, async (req, res) => {
  try {
    const payload = await buildExecutiveSnapshot();
    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(500).json({ error: err.message, ok: false });
  }
});

app.post("/admin/api/campaign/send-template", adminAuth, async (req, res) => {
  try {
    const actor = String(req.headers["x-admin-actor"] || req.query.actor || "admin").trim();
    const role = getAdminRole(req);
    const audience = normalizeCampaignAudience(req.body?.audience);
    const defaultExistingTemplate = process.env.CAMPAIGN_TEMPLATE_EXISTING || "alphadome";
    const defaultNewClientTemplate = process.env.CAMPAIGN_TEMPLATE_NEW_CLIENT || "alphadome_new_client";
    const templateDefault = audience === "new_clients" ? defaultNewClientTemplate : defaultExistingTemplate;
    const template = String(req.body?.template || templateDefault).trim() || templateDefault;
    const language = String(req.body?.language || "en").trim() || "en";
    const windowHours = parseInt(req.body?.window_hours || "8760", 10);
    const limit = parseInt(req.body?.limit || "25", 10);
    const delayMs = Math.max(0, parseInt(req.body?.delay_ms || "1200", 10));
    const dryRun = Boolean(req.body?.dry_run);
    const confirmLive = Boolean(req.body?.confirm_live);
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ranAt = new Date().toISOString();
    const excludeKeywords = Array.isArray(req.body?.exclude_keywords)
      ? req.body.exclude_keywords
      : ["gideon", "kassangas"];
    const excludePhones = Array.isArray(req.body?.exclude_phones)
      ? req.body.exclude_phones
      : ["254702245555", "254117604817", "254743780542"];

    if (!dryRun && ADMIN_POLICY_REQUIRE_LIVE_CONFIRM && !confirmLive) {
      await appendAdminAction({
        when: ranAt,
        action: "campaign.send_template",
        status: "blocked",
        actor,
        source_ip: req.ip,
        run_id: runId,
        note: "Blocked by policy: confirm_live required for live sends",
      });
      return res.status(400).json({
        error: "Live send requires confirm_live=true (policy enforcement).",
        policy: "require_live_confirm",
      });
    }

    if (!dryRun && !["super_admin", "campaign_manager"].includes(role)) {
      const approval = await createApprovalRequest({
        action: "campaign.live_send",
        requested_by: actor,
        requested_role: role,
        payload: {
          audience,
          template,
          language,
          limit,
          window_hours: windowHours,
          delay_ms: delayMs,
        },
        note: `Role ${role} requested a live campaign send`,
        source_ip: req.ip,
      });
      await appendAdminAction({
        when: ranAt,
        action: "campaign.send_template",
        status: "blocked",
        actor,
        source_ip: req.ip,
        run_id: runId,
        note: `Approval required for role ${role}`,
        metadata: { approval_id: approval.id, role, audience, template },
      });
      return res.status(202).json({
        ok: true,
        approval_requested: true,
        approval,
        message: "Live campaign requires approval for this role.",
      });
    }

    if (!dryRun && ADMIN_POLICY_REQUIRE_DRY_RUN_FIRST) {
      const historyCheck = await readCampaignHistory({ limit: 200, template, audience, status: "dry_run" });
      if (!historyCheck.filtered_count) {
        await appendAdminAction({
          when: ranAt,
          action: "campaign.send_template",
          status: "blocked",
          actor,
          source_ip: req.ip,
          run_id: runId,
          note: "Blocked by policy: dry run required before live send",
          metadata: { template, audience },
        });
        return res.status(400).json({
          error: "Run a dry run first for this audience/template before live send.",
          policy: "require_dry_run_first",
        });
      }
    }

    let leads = [];
    if (audience === "new_clients") {
      leads = collectManualCampaignPhones(req.body?.phones, excludePhones, limit);
      if (!leads.length) {
        return res.status(400).json({
          error: "For new_clients audience, provide phones as an array or comma-separated string.",
          audience,
        });
      }
    } else {
      leads = await fetchAdminCampaignLeads({
        windowHours,
        limit,
        excludeKeywords,
        excludePhones,
      });
    }

    if (dryRun) {
      const dryRunResult = {
        run_id: runId,
        ran_at: ranAt,
        status: "dry_run",
        dry_run: true,
        audience,
        template,
        language,
        total: leads.length,
        success: 0,
        failed: 0,
        errors: [],
        sample: leads.slice(0, 10),
      };
      await appendCampaignHistory(dryRunResult);
      await appendAdminAction({
        when: ranAt,
        action: "campaign.send_template",
        status: "dry_run",
        actor,
        source_ip: req.ip,
        run_id: runId,
        note: `Dry run generated: template=${template} audience=${audience}`,
        metadata: {
          total: leads.length,
          template,
          audience,
          language,
        },
      });
      return res.json({
        ok: true,
        run_id: runId,
        dry_run: true,
        audience,
        template,
        language,
        count: leads.length,
        sample: leads.slice(0, 10),
      });
    }

    let success = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < leads.length; i += 1) {
      const lead = leads[i];
      try {
        await sendTemplateDirect(lead.phone, template, language);
        success += 1;
      } catch (err) {
        failed += 1;
        errors.push({
          phone: lead.phone,
          error: err?.response?.data || err.message,
        });
      }
      if (i < leads.length - 1 && delayMs > 0) {
        await sleepMs(delayMs);
      }
    }

    log(`Admin template campaign: audience=${audience} template=${template} sent=${success} failed=${failed} total=${leads.length}`, "SYSTEM");
    const status = failed === 0 ? "completed" : success > 0 ? "partial" : "failed";
    await appendCampaignHistory({
      run_id: runId,
      ran_at: ranAt,
      status,
      dry_run: false,
      audience,
      template,
      language,
      total: leads.length,
      success,
      failed,
      errors: errors.slice(0, 20),
      sample: leads.slice(0, 10),
    });
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "campaign.send_template",
      status,
      actor,
      source_ip: req.ip,
      run_id: runId,
      note: `Campaign ${status}: success=${success} failed=${failed}`,
      metadata: {
        audience,
        template,
        language,
        total: leads.length,
        success,
        failed,
      },
    });
    return res.json({
      ok: true,
      run_id: runId,
      status,
      audience,
      template,
      language,
      total: leads.length,
      success,
      failed,
      errors: errors.slice(0, 20),
      sample: leads.slice(0, 10),
    });
  } catch (err) {
    await appendAdminAction({
      when: new Date().toISOString(),
      action: "campaign.send_template",
      status: "failed",
      actor: String(req.headers["x-admin-actor"] || req.query.actor || "admin").trim(),
      source_ip: req.ip,
      note: err.message,
      metadata: {
        audience: normalizeCampaignAudience(req.body?.audience),
        template: String(req.body?.template || process.env.CAMPAIGN_TEMPLATE_EXISTING || "alphadome"),
      },
    });
    await appendCampaignHistory({
      run_id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ran_at: new Date().toISOString(),
      status: "failed",
      dry_run: Boolean(req.body?.dry_run),
      audience: normalizeCampaignAudience(req.body?.audience),
      template: String(req.body?.template || process.env.CAMPAIGN_TEMPLATE_EXISTING || "alphadome"),
      language: String(req.body?.language || "en"),
      total: 0,
      success: 0,
      failed: 0,
      errors: [{ error: err.message }],
      sample: [],
    });
    log(`Admin campaign send-template error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/campaign/template-preview", adminAuth, async (req, res) => {
  try {
    const name = String(req.query.name || "alphadome").trim() || "alphadome";
    const result = await fetchTemplateDefinition(name);
    return res.json({ ok: true, template: name, ...result });
  } catch (err) {
    log(`Admin campaign template-preview error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/performance-report", adminAuth, async (req, res) => {
  try {
    const period = String(req.query.period || "daily").toLowerCase() === "weekly" ? "weekly" : "daily";
    const ops = await buildAdminOpsOverview();
    const report = buildPerformanceReportFromOps(ops, period);
    return res.json(report);
  } catch (err) {
    log(`Admin performance report alias error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

app.get("/admin/health", adminAuth, async (req, res) => {
  try {
    const payload = await buildAdminOpsOverview();
    return res.json({ status: payload.kpis.health_status });
  } catch (err) {
    return res.status(500).json({ error: err.message, status: "unknown" });
  }
});

app.get("/admin/catalog/data", adminAuth, async (req, res) => {
  try {
    const tenantPhone = req.query.tenant_phone || "";
    const tenantName = req.query.tenant_name || "";
    const q = req.query.q || "";

    if (!tenantPhone && !tenantName) {
      return res.status(400).json({ error: "Provide tenant_phone or tenant_name" });
    }

    let resolvedPhone = tenantPhone;
    if (!resolvedPhone && tenantName) {
      const { data: tenant } = await supabase
        .from("bot_tenants")
        .select("client_phone")
        .ilike("client_name", `%${tenantName}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      resolvedPhone = tenant?.client_phone || "";
    }

    if (!resolvedPhone) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const { data, error } = await supabase.rpc("get_catalog", {
      tenant_phone: resolvedPhone,
      q: q || null
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data);
  } catch (err) {
    log(`Catalog view error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN: Upload catalog & images =====
app.post("/admin/catalog/upload", adminAuth, upload.array("images"), async (req, res) => {
  try {
    const tenantPhone = req.body.tenant_phone || "";
    const tenantName = req.body.tenant_name || "";
    const productsJson = req.body.products_json || "[]";

    const products = JSON.parse(productsJson).map((p) => ({
      ...p,
      sku: p.sku || generateSku(p.name || "ITEM", "ADM")
    }));
    const images = [];

    // Upload files to storage if provided
    const bucket = ADMIN_UPLOAD_BUCKET;
    await ensureBucket(bucket);

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const base = path.parse(file.originalname).name;
        const ext = path.extname(file.originalname);
        const objectPath = `${Date.now()}_${base}${ext}`;
        const fileBuffer = fs.readFileSync(file.path);

        const { error: uploadErr } = await supabase
          .storage
          .from(bucket)
          .upload(objectPath, fileBuffer, { upsert: true, contentType: file.mimetype });

        fs.unlinkSync(file.path);

        if (uploadErr) {
          log(`Upload failed for ${file.originalname}: ${uploadErr.message}`, "ERROR");
          continue;
        }

        const publicUrl = getPublicUrl(bucket, objectPath);
        if (publicUrl) {
          const fallbackSku = products.length === 1 ? products[0].sku : base;
          images.push({ product_sku: base || fallbackSku, image_url: publicUrl, is_primary: true });
        }
      }
    }

    const payload = { products, images };
    const targetPhone = tenantPhone || "";

    if (!targetPhone && !tenantName) {
      return res.status(400).json({ error: "Provide tenant_phone or tenant_name" });
    }

    // If only tenant_name is provided, resolve phone
    let resolvedPhone = targetPhone;
    if (!resolvedPhone && tenantName) {
      const { data: tenant } = await supabase
        .from("bot_tenants")
        .select("client_phone")
        .ilike("client_name", `%${tenantName}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      resolvedPhone = tenant?.client_phone || "";
    }

    if (!resolvedPhone) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const { data, error } = await supabase.rpc("seed_portfolio", {
      tenant_phone: resolvedPhone,
      payload,
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, result: data, uploaded_images: images.length });
  } catch (err) {
    log(`Admin upload error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN: Simple Non-Technical Upload =====
app.post("/admin/catalog/simple", adminAuth, upload.array("images"), async (req, res) => {
  try {
    const tenantPhone = req.body.tenant_phone || "";
    const tenantName = req.body.tenant_name || "";

    if (!tenantPhone && !tenantName) {
      return res.status(400).json({ error: "Provide tenant_phone or tenant_name" });
    }

    let resolvedPhone = tenantPhone;
    if (!resolvedPhone && tenantName) {
      const { data: tenant } = await supabase
        .from("bot_tenants")
        .select("client_phone")
        .ilike("client_name", `%${tenantName}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      resolvedPhone = tenant?.client_phone || "";
    }

    if (!resolvedPhone) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const name = req.body.name || "";
    const sku = req.body.sku || generateSku(name, "CAT");
    const description = req.body.description || null;
    const price = req.body.price ? Number(req.body.price) : null;
    const currency = req.body.currency || "KES";
    const stock_count = req.body.stock_count ? Number(req.body.stock_count) : 0;
    const category = req.body.category || null;
    const tags = req.body.tags ? req.body.tags.split(",").map(t => t.trim()).filter(Boolean) : [];
    const brand = req.body.brand || null;
    const collection = req.body.collection || null;
    const collection_description = req.body.collection_description || null;

    const products = [{
      sku,
      name,
      description,
      price,
      currency,
      stock_count,
      image_url: null,
      metadata: { category, tags, brand }
    }];

    const images = [];
    const bucket = ADMIN_UPLOAD_BUCKET;
    await ensureBucket(bucket);
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const ext = path.extname(file.originalname);
        const objectPath = `${Date.now()}_${sku}${ext}`;
        const fileBuffer = fs.readFileSync(file.path);
        const { error: uploadErr } = await supabase
          .storage
          .from(bucket)
          .upload(objectPath, fileBuffer, { upsert: true, contentType: file.mimetype });
        fs.unlinkSync(file.path);
        if (uploadErr) {
          log(`Upload failed: ${uploadErr.message}`, "ERROR");
          continue;
        }
        const publicUrl = getPublicUrl(bucket, objectPath);
        if (publicUrl) {
          images.push({ product_sku: sku, image_url: publicUrl, is_primary: images.length === 0 });
        }
      }
    }

    const collections = collection ? [{ name: collection, description: collection_description, sort_order: 0 }] : [];
    const collectionItems = collection ? [{ collection_name: collection, product_sku: sku, sort_order: 0 }] : [];

    const payload = {
      products,
      images,
      collections,
      collection_items: collectionItems
    };

    const { data, error } = await supabase.rpc("seed_portfolio", {
      tenant_phone: resolvedPhone,
      payload
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, result: data, generated_sku: sku, uploaded_images: images.length });
  } catch (err) {
    log(`Admin simple upload error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN: CSV Catalog Import =====
app.post("/admin/catalog/import-csv", adminAuth, upload.single("catalog_csv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required" });
    }

    const tenantPhone = req.body.tenant_phone || "";
    const tenantName = req.body.tenant_name || "";
    const csvText = fs.readFileSync(req.file.path, "utf8");
    fs.unlinkSync(req.file.path);

    const records = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const products = [];
    const images = [];
    const collections = [];
    const collectionItems = [];

    for (const r of records) {
      const sku = r.sku?.trim();
      if (!sku) continue;

      const tags = r.tags ? r.tags.split("|").map(t => t.trim()).filter(Boolean) : [];
      const metadata = {
        category: r.category || null,
        tags,
        brand: r.brand || null
      };

      products.push({
        sku,
        name: r.name,
        description: r.description || null,
        price: r.price ? Number(r.price) : null,
        currency: r.currency || "KES",
        stock_count: r.stock_count ? Number(r.stock_count) : 0,
        image_url: r.image_url || null,
        metadata
      });

      if (r.image_url) {
        images.push({ product_sku: sku, image_url: r.image_url, is_primary: true });
      }

      if (r.collection) {
        if (!collections.find(c => c.name === r.collection)) {
          collections.push({ name: r.collection, description: r.collection_description || null, sort_order: 0 });
        }
        collectionItems.push({ collection_name: r.collection, product_sku: sku, sort_order: 0 });
      }
    }

    if (!tenantPhone && !tenantName) {
      return res.status(400).json({ error: "Provide tenant_phone or tenant_name" });
    }

    let resolvedPhone = tenantPhone;
    if (!resolvedPhone && tenantName) {
      const { data: tenant } = await supabase
        .from("bot_tenants")
        .select("client_phone")
        .ilike("client_name", `%${tenantName}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      resolvedPhone = tenant?.client_phone || "";
    }

    if (!resolvedPhone) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const payload = {
      products,
      images,
      collections,
      collection_items: collectionItems
    };

    const { data, error } = await supabase.rpc("seed_portfolio", {
      tenant_phone: resolvedPhone,
      payload
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ ok: true, result: data, products: products.length });
  } catch (err) {
    log(`Admin CSV import error: ${err.message}`, "ERROR");
    return res.status(500).json({ error: err.message });
  }
});

// ===== WEBHOOK SIGNATURE VERIFICATION =====
// Validates X-Hub-Signature header per WhatsApp Cloud API security requirements
function verifyWebhookSignature(req) {
  const signature = req.get("X-Hub-Signature-256");
  if (!signature) return false;

  const body = req.rawBody || (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  const appSecret = process.env.WHATSAPP_APP_SECRET || "";

  if (!appSecret) {
    log("WHATSAPP_APP_SECRET not configured - signature verification skipped", "WARN");
    return true; // Skip if not configured
  }

  const expectedSignature = "sha256=" + crypto
    .createHmac("sha256", appSecret)
    .update(body)

    .digest("hex");

  let isValid = false;
  try {
    const received = Buffer.from(signature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    isValid = received.length === expected.length && crypto.timingSafeEqual(received, expected);
  } catch {
    isValid = false;
  }

  if (!isValid) {
    log(`Invalid webhook signature detected from ${req.ip}`, "WARN");
  }
  return isValid;
}

// ===== WEBHOOK SIGNATURE MIDDLEWARE =====
app.post("/webhook", (req, res, next) => {
  // Verify signature before processing
  if (!verifyWebhookSignature(req)) {
    log("Webhook signature validation failed", "ERROR");
    // Still return 200 to prevent WhatsApp retries on invalid webhooks
    return res.sendStatus(200);
  }
  next();
});

// ===== HANDLE INCOMING WHATSAPP MESSAGES =====
app.post("/webhook", loadTenantContext, async (req, res) => {

  const body = req.body;

  if (!body.object) {
    log("Webhook received non-message event", "DEBUG");
    return res.sendStatus(404);
  }

  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return res.sendStatus(200);

  const from = message.from;
  const text = message.text?.body?.trim();
  const waMessageId = message.id;
  const rawPayload = body.entry?.[0]?.changes?.[0]?.value;

  // Extra logging for debugging tenant resolution and incoming number
  log(`[WEBHOOK] Incoming WhatsApp message from: ${from} | text: ${text || '[non-text]'}`, "DEBUG");
  log(`[WEBHOOK] Tenant resolution: isTenantAware=${req.isTenantAware} | tenantName=${req.tenant?.client_name || 'null'} | tenantPhone=${req.tenant?.client_phone || 'null'} | tenantId=${req.tenant?.id || 'null'}`, "DEBUG");

  // NOTE for System Update; Find a way of handling different formats (text, graphics - videos, audio, and images.)
  if (!text) return res.sendStatus(200);

  // === CONTEXT-AWARE INTENT DETECTION FOR WRITER'S FLOW ===
  // Simple keyword/intent detection (can be replaced with LLM/NLP for advanced use)
  const writersFlowTriggers = [
    '/writersflow',
    'writer\'s flow',
    'pitch to',
    'supply my products',
    'find opportunity',
    'reach out to',
    'send pitch',
  ];
  const lowerText = text.toLowerCase();
  const matchedTrigger = writersFlowTriggers.find(trigger => lowerText.includes(trigger));

  if (matchedTrigger) {
    // STEP 1: Find or create user (moved up so userData is defined)
    let { data: userData, error: userErr } = await supabase
      .from("users")
      .select("id, phone")
      .eq("phone", from)
      .maybeSingle();

    if (userErr) throw userErr;

    if (!userData) {
      const { data: newUser, error: newUserErr } = await supabase
        .from("users")
        .insert([{ phone: from, full_name: "Unknown User" }])
        .select("id")
        .single();

      if (newUserErr) throw newUserErr;
      userData = newUser;
      log(`New user created: ${from}`, "SYSTEM");
      
      // Capture first-touch attribution for Writer's Flow
      await mergeUserSessionContext(from, {
        first_touch_source: "writers_flow",
        first_touch_date: new Date().toISOString(),
      });
    }

    // Extract context/keywords (simple example: everything after the trigger)
    let keywords = [];
    let context = text;
    // Example: "/writersflow AI jobs" or "I want to pitch to a restaurant to supply my products"
    if (lowerText.startsWith('/writersflow')) {
      keywords = text.split(' ').slice(1);
      context = keywords.join(' ');
    } else {
      // For natural language, use the whole message as context
      keywords = text.split(' ').filter(w => w.length > 2);
    }

    // Call Writer's Flow orchestrator (ESM compatible)
    try {
      await sendMessage(from, '⏳ Processing your request with Writer\'s Flow...');
      const writersFlowModule = await import('./writers_flow/orchestrator.js');
      const writersFlow = writersFlowModule.default || writersFlowModule;
      const result = await writersFlow({
        keywords,
        userId: userData.id,
        fromEmail: process.env.SMTP_USER, // or map WhatsApp user to email if available
        context,
      });
      await sendMessage(from, `✅ Writer's Flow completed. Opportunities contacted: ${result.sent}`);
    } catch (err) {
      await sendMessage(from, `⚠️ Writer's Flow failed: ${err.message}`);
    }
    return res.sendStatus(200);
  }

  log(`Received from ${from}: ${text}`, "INCOMING");

  // Allow customers to attach a referral code via WhatsApp: REF CODE123
  const referralMatch = text.match(/^ref\s+([a-z0-9_-]{3,30})$/i);
  if (referralMatch) {
    const referralCode = String(referralMatch[1] || "").toUpperCase();
    await mergeUserSessionContext(from, {
      referral_code: referralCode,
      referral_captured_at: new Date().toISOString(),
    });
    await sendMessage(from, `✅ Referral code *${referralCode}* saved. Continue with *JOIN ALPHADOME* or *BUY <SKU>*.`);
    return res.sendStatus(200);
  }

  try {
    // STEP 1: Find or create user
    let { data: userData, error: userErr } = await supabase
      .from("users")
      .select("id, phone")
      .eq("phone", from)
      .maybeSingle();

    if (userErr) throw userErr;

    if (!userData) {
      const { data: newUser, error: newUserErr } = await supabase
        .from("users")
        .insert([{ phone: from, full_name: "Unknown User" }])
        .select("id")
        .single();

      if (newUserErr) throw newUserErr;
      userData = newUser;
      log(`New user created: ${from}`, "SYSTEM");
      
      // Capture first-touch attribution for main webhook
      const { data: sessCtx } = await supabase.from("user_sessions").select("context").eq("phone", from).maybeSingle();
      const ctx = sessCtx?.context && typeof sessCtx.context === "object" ? sessCtx.context : {};
      await mergeUserSessionContext(from, {
        first_touch_source: determineAttributionSource(text, ctx),
        first_touch_date: new Date().toISOString(),
      });
    }

    // Collect post-purchase ratings when awaiting review feedback.
    const reviewMatch = text.trim().match(/^([1-5])(?:\s*(?:stars?)?)?(?:[\s,:-]+(.+))?$/i);
    if (reviewMatch) {
      const rating = Number(reviewMatch[1]);
      const reviewText = String(reviewMatch[2] || "").trim().slice(0, 800) || null;
      const { data: reviewSession } = await supabase
        .from("user_sessions")
        .select("context")
        .eq("phone", from)
        .maybeSingle();
      const reviewCtx = reviewSession?.context && typeof reviewSession.context === "object" ? reviewSession.context : {};
      const targetSubId = reviewCtx.awaiting_review_subscription_id || null;
      if (targetSubId) {
        const { data: targetSub } = await supabase
          .from("subscriptions")
          .select("id, metadata")
          .eq("id", targetSubId)
          .maybeSingle();

        if (targetSub) {
          const md = targetSub.metadata && typeof targetSub.metadata === "object" ? targetSub.metadata : {};
          await supabase
            .from("subscriptions")
            .update({
              metadata: {
                ...md,
                rating,
                review_text: reviewText,
                review_at: new Date().toISOString(),
                reviewed_via: "whatsapp",
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", targetSubId);

          await mergeUserSessionContext(from, {
            awaiting_review_subscription_id: null,
            awaiting_review_since: null,
          });

          await sendMessage(
            from,
            reviewText
              ? `🙏 Thank you for rating us *${rating}/5* and sharing your feedback!`
              : `🙏 Thank you for rating us *${rating}/5*!`
          );
          return res.sendStatus(200);
        }
      }
    }

    // STEP 2: Identify brand (TENANT-AWARE)
    let brandId = DEFAULT_BRAND_ID;
    
    if (req.isTenantAware && req.tenant?.brand_id) {
      brandId = req.tenant.brand_id;
      log(`Using tenant brand: ${req.tenant.client_name}`, "SYSTEM");
    } else {
      try {
        const { data: brandData, error: brandErr } = await supabase
          .from("brands")
          .select("id")
          .eq("is_platform_owner", true)
          .limit(1)
          .single();

        if (!brandErr && brandData) {
          brandId = brandData.id;
        }
      } catch {
        brandId = DEFAULT_BRAND_ID;
      }
    }

    // STEP 3: Load tenant-specific configuration (NEW)
    let templates = [];
    let trainingData = [];
    
    if (req.isTenantAware && req.tenant?.id) {
      templates = await loadTenantTemplates(req.tenant.id);
      trainingData = await loadTenantTrainingData(req.tenant.id);
      log(
        `Loaded ${templates.length} templates and ${trainingData.length} training entries`,
        "SYSTEM"
      );
    }

    // STEP 3b: Prefetch DB context for LLM
    const tenantPhone = req.tenant?.client_phone || req.tenant?._business_phone || null;
    const [userProfile, brandProfile, catalogMatches] = await Promise.all([
      fetchUserProfile(userData.id),
      fetchBrandProfile(brandId),
      tenantPhone ? fetchCatalogForTenant(tenantPhone, text) : Promise.resolve([]),
    ]);

    if (catalogMatches?.length > 0) {
      log(
        `CATALOG_SEARCH query="${text}" results=${catalogMatches.length} customer=${from} tenant=${tenantPhone || "unknown"}`,
        "PRODUCT_EVENT"
      );
    }

    const dbContext = buildDbContext({
      userProfile,
      brandProfile,
      tenant: req.tenant || null,
      catalogMatches,
    });

 // ---------- INSERT START: Join Alphadome / STK flow ----------
    // detect join command (case-insensitive)
   // ---------- UPDATED START: Join Alphadome / STK + level logic ----------
// ================= Alphadome Subscription & Payment Flow ================= //



// 🧩 STEP 1: Handle "JOIN ALPHADOME" message
// ✅ JOIN ALPHADOME FLOW
if (text.trim().toUpperCase().startsWith("JOIN ALPHADOME") || text.trim().toUpperCase() === "JOIN") {
  try {
    // normalize phone
    let normalizedPhone = from.replace(/^\+/, "");
    if (normalizedPhone.startsWith("0")) normalizedPhone = "254" + normalizedPhone.slice(1);

    // detect plan & level
    const input = text.trim().toLowerCase();
    let plan = "monthly";
    let level = 1;

    if (input.includes("one time") || input.includes("onetime")) plan = "one";
    else if (input.includes("monthly")) plan = "monthly";

    const levelMatch = input.match(/level\s*(\d+)/i);
    if (levelMatch) level = parseInt(levelMatch[1]);

    // compute amount
    const amount = getPaymentAmount(plan, level);

    // store session waiting for phone
    await mergeUserSessionContext(from, {
      step: "awaiting_payment_number",
      plan,
      level,
      amount,
    });

    // prompt user for number
    await sendMessage(
      from,
      `📦 You selected *${plan.toUpperCase()} Plan - Level ${level}*.\n💰 Amount: KES ${amount}.\n\nPlease reply with the *M-Pesa number (2547XXXXXXXX)* you'd like to use for payment.\nIf you want to use your WhatsApp number, type *same*.`
    );

    return res.sendStatus(200);
  } catch (err) {
    log(`Failed to start Join Alphadome flow for ${from}: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Something went wrong. Please try again later.");
    return res.sendStatus(200);
  }
}

// 🔄 FALLBACK PAYMENT OPTION HANDLERS - when M-Pesa fails
// Handle retry M-Pesa button
if (text.toUpperCase().includes("RETRY") || text.match(/retry.*mpesa|retry_mpesa/i)) {
  try {
    const { data: fallbackSession } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("phone", from)
      .maybeSingle();

    const fbCtx = fallbackSession?.context && typeof fallbackSession.context === "object" ? fallbackSession.context : {};
    
    if (fbCtx.failed_checkout_id && fbCtx.failed_plan_type && fbCtx.failed_amount) {
      await sendMessage(from, `💳 Retrying M-Pesa payment for KES ${fbCtx.failed_amount}. Please enter your M-Pesa PIN on your phone...`);
      
      // Trigger STK push again for the same checkout
      try {
        const resendStkResp = await initiateStkPush({
          phone: from.startsWith("254") ? from : "254" + from.slice(1),
          amount: fbCtx.failed_amount,
          accountRef: fbCtx.failed_plan_type || "retry",
          transactionDesc: `Retry ${fbCtx.failed_plan_type || "payment"}`,
        });

        if (resendStkResp?.CheckoutRequestID) {
          await mergeUserSessionContext(from, {
            failed_checkout_id: null,
            retry_checkout_id: resendStkResp.CheckoutRequestID,
            retry_attempted_at: new Date().toISOString(),
          });
        }
      } catch (stkErr) {
        await sendMessage(from, `⚠️ STK retry failed: ${stkErr.message}. Please try again or select another payment method.`);
      }
    } else {
      await sendMessage(from, "⚠️ No failed payment found. Please start fresh with *JOIN ALPHADOME* or *BUY <SKU>*.");
    }
    return res.sendStatus(200);
  } catch (err) {
    log(`Error handling retry M-Pesa: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Retry failed. Please contact support at +254117604817.");
    return res.sendStatus(200);
  }
}

// Handle bank transfer button
if (text.toUpperCase().includes("BANK") || text.match(/bank_transfer|bank.*transfer/i)) {
  try {
    const { data: fallbackSession } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("phone", from)
      .maybeSingle();

    const fbCtx = fallbackSession?.context && typeof fallbackSession.context === "object" ? fallbackSession.context : {};
    
    if (fbCtx.failed_amount && fbCtx.failed_plan_type) {
      await sendBankTransferDetails(from, fbCtx.failed_amount, fbCtx.failed_plan_type, fbCtx.failed_checkout_id || "");
      
      await mergeUserSessionContext(from, {
        selected_fallback_method: "bank_transfer",
        fallback_method_selected_at: new Date().toISOString(),
      });

      await sendMessage(from, `📝 Once you've made the bank transfer, reply with:\n*BANK RECEIPT <receipt_number>*\n\nExample: *BANK RECEIPT K2P4A5B6C7*`);
    } else {
      await sendMessage(from, "⚠️ No failed payment found. Please start fresh with *JOIN ALPHADOME* or *BUY <SKU>*.");
    }
    return res.sendStatus(200);
  } catch (err) {
    log(`Error handling bank transfer: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Error retrieving bank details. Please contact support at +254117604817.");
    return res.sendStatus(200);
  }
}

// Handle Cash on Delivery button
if (text.toUpperCase().includes("COD") || text.match(/cash.*delivery|cod|cash_on_delivery/i)) {
  try {
    const { data: fallbackSession } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("phone", from)
      .maybeSingle();

    const fbCtx = fallbackSession?.context && typeof fallbackSession.context === "object" ? fallbackSession.context : {};
    
    if (fbCtx.failed_plan_type) {
      await sendMessage(
        from,
        `🚚 *Cash on Delivery Selected*\n\n` +
        `Plan: *${fbCtx.failed_plan_type.toUpperCase()}*\n` +
        `Amount: *KES ${fbCtx.failed_amount}*\n\n` +
        `📍 Estimated Delivery: 2-3 business days\n` +
        `💰 Payment due on delivery\n\n` +
        `Please confirm your delivery address:\n*<Your address here>*`
      );

      await mergeUserSessionContext(from, {
        selected_fallback_method: "cod",
        fallback_method_selected_at: new Date().toISOString(),
      });

      await sendMessage(from, `Reply with your delivery address (e.g., *Nairobi CBD, Tom Mboya Street, Building X, Floor 3*)`);
    } else {
      await sendMessage(from, "⚠️ No failed payment found. Please start fresh with *JOIN ALPHADOME* or *BUY <SKU>*.");
    }
    return res.sendStatus(200);
  } catch (err) {
    log(`Error handling COD selection: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Error processing COD request. Please contact support.");
    return res.sendStatus(200);
  }
}

// Handle Contact Support button
if (text.toUpperCase().includes("SUPPORT") || text.match(/contact.*support|support_team/i)) {
  try {
    await sendMessage(
      from,
      `📞 *Alphadome Support Team*\n\n` +
      `We're here to help!\n\n` +
      `☎️ Call: *+254117604817* or *+254743780542*\n` +
      `📧 Email: support@alphadome.com\n` +
      `⏰ Hours: Mon-Fri, 8AM-6PM EAT\n\n` +
      `💬 Or continue here - what's your issue?`
    );
    return res.sendStatus(200);
  } catch (err) {
    log(`Error handling support request: ${err.message}`, "ERROR");
    return res.sendStatus(200);
  }
}

// Handle bank receipt confirmation
if (text.toUpperCase().match(/^BANK\s+RECEIPT\s+/)) {
  try {
    const receiptMatch = text.match(/^BANK\s+RECEIPT\s+([A-Z0-9]+)$/i);
    if (!receiptMatch) {
      await sendMessage(from, `Format error. Please reply: *BANK RECEIPT <receipt_number>*\nExample: *BANK RECEIPT K2P4A5B6C7*`);
      return res.sendStatus(200);
    }

    const receiptNum = receiptMatch[1];
    const { data: fallbackSession } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("phone", from)
      .maybeSingle();

    const fbCtx = fallbackSession?.context && typeof fallbackSession.context === "object" ? fallbackSession.context : {};

    if (fbCtx.failed_amount && fbCtx.failed_plan_type) {
      await confirmAlternativePayment(from, receiptNum, "bank transfer", fbCtx.failed_amount, fbCtx.failed_plan_type);
      
      // Mark subscription as "manual_pending_verification"
      if (fbCtx.failed_subscription_id) {
        await supabase.from("subscriptions").update({
          status: "manual_pending_verification",
          metadata: {
            alternative_payment_method: "bank_transfer",
            bank_receipt: receiptNum,
            verified_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString()
        }).eq("id", fbCtx.failed_subscription_id);
      }

      await mergeUserSessionContext(from, {
        bank_receipt_verified: receiptNum,
        bank_receipt_verified_at: new Date().toISOString(),
      });

      log(`Bank receipt confirmed: ${receiptNum} for ${from}`, "PAYMENT");
    }
    return res.sendStatus(200);
  } catch (err) {
    log(`Error confirming bank receipt: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Error processing receipt. Please try again or contact support.");
    return res.sendStatus(200);
  }
}

// Handle delivery address confirmation for COD
if (text.length > 10 && !text.match(/^(BUY|JOIN|BANK|RETRY|COD|SUPPORT)/i)) {
  const { data: fallbackSession } = await supabase
    .from("user_sessions")
    .select("context")
    .eq("phone", from)
    .maybeSingle();

  const fbCtx = fallbackSession?.context && typeof fallbackSession.context === "object" ? fallbackSession.context : {};

  if (fbCtx.selected_fallback_method === "cod" && !fbCtx.cod_address_confirmed) {
    try {
      await sendMessage(
        from,
        `✅ *COD Order Confirmed*\n\n` +
        `📍 Delivery Address:\n*${text}*\n\n` +
        `Plan: *${fbCtx.failed_plan_type?.toUpperCase()}*\n` +
        `Amount: *KES ${fbCtx.failed_amount}*\n` +
        `Payment Due: On Delivery\n\n` +
        `Your order has been registered. Our team will contact you within 24 hours to arrange delivery.\n\n` +
        `Order Reference: *COD-${Date.now().toString().slice(-8)}*`
      );

      // Mark subscription as "cod_pending_delivery"
      if (fbCtx.failed_subscription_id) {
        await supabase.from("subscriptions").update({
          status: "cod_pending_delivery",
          metadata: {
            alternative_payment_method: "cod",
            delivery_address: text,
            confirmed_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString()
        }).eq("id", fbCtx.failed_subscription_id);
      }

      await mergeUserSessionContext(from, {
        cod_address: text,
        cod_address_confirmed: true,
        cod_confirmed_at: new Date().toISOString(),
      });

      log(`COD order confirmed with address: ${text} for ${from}`, "PAYMENT");
    } catch (err) {
      log(`Error confirming COD address: ${err.message}`, "ERROR");
    }
  }
}

// ✅ PRODUCT BUY FLOW: explicit SKU and natural-language intents
const naturalBuyIntent = detectNaturalLanguageBuyIntent(text);
const extractedSku = extractSkuFromMessage(text);
if (naturalBuyIntent || extractedSku) {
  try {
    if (!tenantPhone) {
      await sendMessage(from, "⚠️ Product checkout is only available for tenant-linked chats.");
      return res.sendStatus(200);
    }

    const { data: buySession } = await supabase
      .from("user_sessions")
      .select("context")
      .eq("phone", from)
      .maybeSingle();

    const sessionContext = buySession?.context && typeof buySession.context === "object"
      ? buySession.context
      : {};

    let requestedSku = String(extractedSku || "").trim();

    if (!requestedSku) {
      const recentItems = Array.isArray(sessionContext.last_catalog_items)
        ? sessionContext.last_catalog_items
        : [];

      if (recentItems.length === 1 && recentItems[0]?.sku) {
        requestedSku = String(recentItems[0].sku);
      } else if (sessionContext.last_selected_sku) {
        requestedSku = String(sessionContext.last_selected_sku);
      } else if (catalogMatches.length === 1 && catalogMatches[0]?.sku) {
        requestedSku = String(catalogMatches[0].sku);
      }

      if (!requestedSku) {
        const suggestions = recentItems
          .filter((item) => item?.sku)
          .slice(0, 3)
          .map((item) => `• ${item.sku} - ${item.name || "Product"}`)
          .join("\n");

        const suggestionText = suggestions
          ? `\nHere are recent options:\n${suggestions}\n\nReply with *BUY <SKU>* or just say *buy SKU123*.`
          : "\nPlease share the SKU to buy, for example: *BUY SKU123*.";

        await sendMessage(from, `🛒 I can help you check out right away.${suggestionText}`);
        return res.sendStatus(200);
      }
    }

    const productCandidates = await fetchCatalogForTenant(tenantPhone, requestedSku);
    const product = productCandidates.find((p) =>
      String(p.sku || "").toLowerCase() === requestedSku.toLowerCase()
    ) || productCandidates[0];

    if (!product) {
      await sendMessage(from, `⚠️ I couldn't find SKU *${requestedSku}*. Please check the SKU from the catalog list and try again.`);
      return res.sendStatus(200);
    }

    const amount = Number(product.price);
    if (!Number.isFinite(amount) || amount <= 0) {
      const storeLine = product.store_url ? `\nStore link: ${product.store_url}` : "";
      await sendMessage(
        from,
        `⚠️ *${product.name || product.sku}* has no valid price set for automated checkout.${storeLine}\nPlease ask a human agent for assisted checkout.`
      );
      return res.sendStatus(200);
    }

    const safeSku = String(product.sku || requestedSku).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "ITEM";
    const accountRef = `PRD${safeSku}`;

    await mergeUserSessionContext(from, {
      step: "awaiting_product_payment_number",
      sku: product.sku || requestedSku,
      product_name: product.name || "Product",
      amount,
      account_ref: accountRef,
      store_url: product.store_url || null,
      last_selected_sku: product.sku || requestedSku,
    });

    log(
      `PRODUCT_CHECKOUT_STARTED sku=${product.sku || requestedSku} source=${extractedSku ? "explicit" : "nlp"} customer=${from}`,
      "PRODUCT_EVENT"
    );

    const storeLine = product.store_url ? `\nStore link: ${product.store_url}` : "";
    await sendMessage(
      from,
      `🛒 You selected *${product.name || product.sku}* (${product.sku || requestedSku}).\n💰 Price: ${product.currency || "KES"} ${amount}.\n\nReply with the M-Pesa number (2547XXXXXXXX) or type *same* to use your WhatsApp number.${storeLine}`
    );

    return res.sendStatus(200);
  } catch (err) {
    log(`Product checkout start error for ${from}: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ We couldn't start product checkout right now. Please try again shortly.");
    return res.sendStatus(200);
  }
}

// ✅ PAYMENT NUMBER RESPONSE HANDLER
const phoneMatch = text.trim().match(/^(\+?254|0)\d{9}$/) || text.trim().toLowerCase() === "same";

if (phoneMatch) {
  const { data: session } = await supabase
    .from("user_sessions")
    .select("context")
    .eq("phone", from)
    .maybeSingle();

  if (session?.context?.step === "awaiting_product_payment_number") {
    let paymentPhone = text.trim().toLowerCase() === "same" ? from : text.trim();
    const paymentSku = session?.context?.sku || "UNKNOWN";
    log(`PAYMENT_PHONE_PROVIDED sku=${paymentSku} paymentPhone=${paymentPhone} customer=${from}`, "PRODUCT_EVENT");

    if (paymentPhone.startsWith("0")) paymentPhone = "254" + paymentPhone.slice(1);
    if (paymentPhone.startsWith("+")) paymentPhone = paymentPhone.replace(/^\+/, "");

    const { amount, sku, product_name, account_ref, store_url } = session.context;

    try {
      log(`🛍️ PRODUCT_PURCHASE_INITIATED: SKU=${sku}, Amount=KES${amount}, Customer=${from}, Phone=${paymentPhone}`, "PRODUCT_EVENT");
      
      await sendMessage(
        from,
        `💳 Processing payment for *${product_name || sku}* (KES ${amount}). Please wait...`
      );

      const stkResp = await initiateStkPush({
        phone: paymentPhone,
        amount,
        accountRef: account_ref || `PRD${String(sku || "ITEM").replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`,
        transactionDesc: `Product ${sku || "checkout"}`,
      });

      const checkoutId = stkResp?.CheckoutRequestID || stkResp?.checkoutRequestID || null;
      if (checkoutId) {
        const referralCode = session?.context?.referral_code || null;
        const referrerPhone = session?.context?.referrer_phone || null;
        await supabase.from("subscriptions").insert([
          {
            user_id: userData.id,
            phone: paymentPhone,
            amount,
            plan_type: "product_checkout",
            level: 1,
            account_ref: account_ref || null,
            status: "pending",
            mpesa_checkout_request_id: checkoutId,
            metadata: {
              ...(stkResp || {}),
              checkout_type: "product",
              sku: sku || null,
              product_name: product_name || null,
              store_url: store_url || null,
              customer_wa: from,
              referral_code: referralCode,
              referrer_phone: referrerPhone,
            },
          },
        ]);
        
        // Capture last-touch attribution on purchase
        await mergeUserSessionContext(from, {
          last_touch_source: "product_purchase",
          last_touch_date: new Date().toISOString(),
        });

        schedulePendingPaymentReminder({
          waPhone: from,
          checkoutId,
          amount,
          planType: "product_checkout",
          level: 1,
        });
        
        log(`✅ STK_PUSH_RECORDED: CheckoutID=${checkoutId}, Customer=${from}`, "PRODUCT_EVENT");
      }

      const storeLine = store_url ? `\nStore link: ${store_url}` : "";
      await sendMessage(
        from,
        `✅ Payment prompt sent to ${paymentPhone}. Please complete payment on your phone to confirm your order for *${product_name || sku}*.${storeLine}`
      );

      await supabase.from("user_sessions").delete().eq("phone", from);
      return res.sendStatus(200);
    } catch (err) {
      log(`❌ PRODUCT_PURCHASE_FAILED: SKU=${sku}, Error=${err.message}, Customer=${from}`, "PRODUCT_EVENT");
      
      // Use parsed M-Pesa error message if available, otherwise generic message
      const userMessage = err.mpesaCode 
        ? err.message 
        : "⚠️ We couldn't start the product payment flow. Please try again shortly.";
      
      await sendMessage(from, userMessage);
      return res.sendStatus(200);
    }
  }

  if (session?.context?.step === "awaiting_payment_number") {
    let paymentPhone = text.trim().toLowerCase() === "same" ? from : text.trim();

    // normalize
    if (paymentPhone.startsWith("0")) paymentPhone = "254" + paymentPhone.slice(1);
    if (paymentPhone.startsWith("+")) paymentPhone = paymentPhone.replace(/^\+/, "");

    const { plan, level, amount } = session.context;
    const accountRef = `Alphadome_${plan}_L${level}`;

    try {
      await sendMessage(
        from,
        `💳 Processing your payment for *${plan.toUpperCase()} Level ${level}* (KES ${amount}). Please wait...`
      );

      // initiate STK push
      const stkResp = await initiateStkPush({
        phone: paymentPhone,
        amount,
        accountRef,
        transactionDesc: `${plan.toUpperCase()} Plan Level ${level}`,
      });

      if (stkResp?.CheckoutRequestID) {
        const referralCode = session?.context?.referral_code || null;
        const referrerPhone = session?.context?.referrer_phone || null;
        await supabase.from("subscriptions").insert([
          {
            user_id: userData.id,
            phone: paymentPhone,
            amount,
            plan_type: plan,
            level,
            account_ref: accountRef,
            status: "pending",
            mpesa_checkout_request_id: stkResp.CheckoutRequestID,
            metadata: {
              ...(stkResp || {}),
              customer_wa: from,
              referral_code: referralCode,
              referrer_phone: referrerPhone,
            },
          },
        ]);

        await mergeUserSessionContext(from, {
          last_touch_source: "subscription_purchase",
          last_touch_date: new Date().toISOString(),
        });

        schedulePendingPaymentReminder({
          waPhone: from,
          checkoutId: stkResp.CheckoutRequestID,
          amount,
          planType: plan,
          level,
        });

        await sendMessage(
          from,
          `✅ Payment prompt sent to ${paymentPhone}.\nPlease confirm on your phone to activate your *${plan.toUpperCase()} Level ${level}* subscription.`
        );
      } else {
        await sendMessage(from, "⚠️ We couldn’t start the payment flow. Please try again later.");
      }

      // clear session
      await supabase.from("user_sessions").delete().eq("phone", from);
    } catch (err) {
      log(`Payment flow error for ${from}: ${err.message}`, "ERROR");
      await sendMessage(
        from,
        "⚠️ Something went wrong while processing your payment. Please try again later."
      );
    }

    return res.sendStatus(200);
  } else {
    await sendMessage(from, "⚠️ No pending subscription found. Please type *Join Alphadome* again.");
    return res.sendStatus(200);
  }
}


// 🧩 STEP 2: Handle user sending payment number ("same" or 2547XXXXXXXX)
// 🧩 STEP 2: Handle user sending payment number ("same" or 2547XXXXXXXX)
if (text.match(/^2547\d{7}$/) || text.toLowerCase() === "same") {
  try {
    // Normalize WhatsApp number
    let whatsappPhone = from.replace(/^\+/, "");
    if (whatsappPhone.startsWith("0"))
      whatsappPhone = "254" + whatsappPhone.slice(1);

    const paymentPhone =
      text.toLowerCase() === "same" ? whatsappPhone : text.trim().replace(/^\+/, "");

    // 🧭 Find most recent subscription awaiting number
    const { data: awaitingSub, error: awaitingErr } = await supabase
      .from("subscriptions")
      .select("*")
      .or(`user_id.eq.${userData.id},phone.eq.${whatsappPhone}`)
      .eq("status", "awaiting_number")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (awaitingErr || !awaitingSub) {
      await sendMessage(
        from,
        "⚠️ No pending subscription found. Please type *Join Alphadome* again to restart."
      );
      return res.sendStatus(200);
    }

    const { amount, plan_type, level, account_ref, id: subId } = awaitingSub;

    // ✅ Update subscription
    await supabase
      .from("subscriptions")
      .update({
        payment_phone: paymentPhone,
        status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", subId);

    await sendMessage(
      from,
      `💳 Initiating payment of KES ${amount} for your *${plan_type.toUpperCase()} Level ${level}* plan.\n\nPlease check your phone (${paymentPhone}) and enter your M-Pesa PIN to complete the transaction.`
    );

    // 🔁 Trigger M-Pesa STK Push
    const stkResp = await initiateStkPush({
      phone: paymentPhone,
      amount,
      accountRef: account_ref,
      transactionDesc: `${plan_type.toUpperCase()} Plan Level ${level}`,
    });

    const checkoutId =
      stkResp?.CheckoutRequestID || stkResp?.checkoutRequestID || null;

    if (checkoutId) {
      await supabase
        .from("subscriptions")
        .update({
          mpesa_checkout_request_id: checkoutId,
          metadata: {
            ...(stkResp || {}),
            customer_wa: from,
          },
        })
        .eq("id", subId);

      schedulePendingPaymentReminder({
        waPhone: from,
        checkoutId,
        amount,
        planType: plan_type,
        level,
      });
    }

    await sendMessage(
      from,
      `✅ Payment prompt sent!\nPlease complete the payment on your phone to activate your *${plan_type.toUpperCase()} Level ${level}* subscription.\n\nIf you encounter issues, call +254117604817 or +254743780542.`
    );

    log(
      `STK push initiated for ${from} (${paymentPhone}, ${plan_type} L${level})`,
      "SYSTEM"
    );
  } catch (err) {
    log(`Failed to handle payment number for ${from}: ${err.message}`, "ERROR");
    await sendMessage(
      from,
      "⚠️ We couldn't start the payment flow. Please try again or contact +254117604817 / +254743780542 for help."
    );
  }

  return res.sendStatus(200);
}


// ---------- UPDATED END ----------
  
    // STEP 3: Load conversation context (for continuity)
    const contextMessages = await fetchConversationContext(userData.id, brandId, 8);

    // STEP 4: Log inbound message
    const { error: convErr } = await supabase.from("conversations").insert([
      {
        brand_id: brandId,
        user_id: userData.id,
        whatsapp_message_id: waMessageId,
        direction: "incoming",
        raw_payload: rawPayload,
        message_text: text,
        created_at: new Date().toISOString(),
      },
    ]);
    if (convErr) throw convErr;

   

    // STEP 5: Try tenant auto-response templates before AI
    const autoResponses = Array.isArray(req.tenant?.metadata?.auto_responses)
      ? req.tenant.metadata.auto_responses
      : [];
    const matchedAutoResponse = findAutoResponse(autoResponses, text);
    if (matchedAutoResponse) {
      const creds = getDecryptedCredentials(req.tenant);
      await sendMessage(from, matchedAutoResponse, creds);
      const { error: outErr } = await supabase.from("conversations").insert([
        {
          brand_id: brandId,
          user_id: userData.id,
          direction: "outgoing",
          message_text: matchedAutoResponse,
          llm_used: false,
          llm_reason: "auto_response",
          raw_payload: { reply_type: "text", llm_used: false, reason: "auto_response" },
          created_at: new Date().toISOString(),
        },
      ]);
      if (outErr) {
        log(`Auto-response conversation insert error: ${JSON.stringify(outErr)}`, "ERROR");
      }
      return res.sendStatus(200);
    }

    // STEP 6: Generate AI reply (TENANT-AWARE)
    const reply = await generateReply(
      text,
      req.tenant || null,
      templates.length > 0 ? templates : null,
      trainingData,
      contextMessages,
      catalogMatches,
      dbContext
    );
    const creds = getDecryptedCredentials(req.tenant);
    const replyMeta = typeof reply === "object" ? reply.meta : null;
    if (reply?.type === "catalog") {
      const items = reply.items || [];
      const firstItem = items.find(Boolean) || null;
      const firstImage =
        items.find((i) => i.primary_image || i.image_url)?.primary_image ||
        items.find((i) => i.primary_image || i.image_url)?.image_url ||
        null;

      await mergeUserSessionContext(from, {
        last_catalog_items: items
          .filter(Boolean)
          .slice(0, 10)
          .map((item) => ({
            sku: item.sku || null,
            name: item.name || null,
            price: Number(item.price) || null,
            currency: item.currency || "KES",
            store_url: item.store_url || null,
          })),
        last_selected_sku: firstItem?.sku || null,
        last_catalog_at: new Date().toISOString(),
      });

      if (firstImage) {
        await sendImage(from, firstImage, "Top match", creds);
      }
      const sections = buildCatalogList(items);
      await sendInteractiveList(from, "Here are matching items:", "View items", sections, creds);
      const firstStore = firstItem?.store_url || null;
      const buyHint = firstItem?.sku ? `\nTo buy now, reply: *BUY ${firstItem.sku}*` : "\nTo buy now, reply: *BUY <SKU>*";
      const smartBuyHint = "\nYou can also say things like: *I want to buy it*";
      const storeHint = firstStore ? `\nStore link: ${firstStore}` : "";
      await sendMessage(from, `Use the list to browse products.${buyHint}${smartBuyHint}${storeHint}`, creds);
    } else {
      const replyText = typeof reply === "string" ? reply : reply?.text || "";
      await sendMessage(from, replyText, creds);
    }

    // STEP 7: Log outbound message
    const { error: outErr } = await supabase.from("conversations").insert([
      {
        brand_id: brandId,
        user_id: userData.id,
        direction: "outgoing",
        message_text:
          reply?.type === "catalog"
            ? "CATALOG_LIST"
            : typeof reply === "string"
              ? reply
              : reply?.text || "",
        llm_used: replyMeta?.llm_used ?? false,
        llm_provider: replyMeta?.llm_provider || null,
        llm_latency_ms: replyMeta?.llm_latency_ms || null,
        llm_error: replyMeta?.llm_error || null,
        llm_reason: replyMeta?.reason || null,
        raw_payload: {
          reply_type: reply?.type || "text",
          llm_used: replyMeta?.llm_used ?? false,
          llm_provider: replyMeta?.llm_provider || null,
          llm_latency_ms: replyMeta?.llm_latency_ms || null,
          llm_error: replyMeta?.llm_error || null,
          reason: replyMeta?.reason || null,
        },
        created_at: new Date().toISOString(),
      },
    ]);
      if (outErr) {
        log(`Conversation insert error: ${JSON.stringify(outErr)}`, "ERROR");
        throw outErr;
      }
  } catch (err) {
    log(`Error processing message from ${from}: ${err.message}`, "ERROR");
  }

  res.sendStatus(200);
});

  // ---------- INSERT START: M-Pesa callback endpoint ----------

// POST /mpesa/stk-push — tenant dashboard manual STK push
app.post("/mpesa/stk-push", tenantSessionAuth, async (req, res) => {
  try {
    const { phone, amount, accountRef, callbackUrl } = req.body;
    if (!phone || !amount) return res.status(400).json({ error: "phone and amount are required" });
    const result = await initiateStkPush({
      phone: String(phone).trim(),
      amount: parseFloat(amount),
      accountRef: accountRef || "TenantPayment",
      transactionDesc: accountRef || "Tenant Dashboard Payment",
    });
    res.json({ success: true, CheckoutRequestID: result.CheckoutRequestID, CustomerMessage: result.CustomerMessage });
  } catch (err) {
    res.status(502).json({ error: err.message || "STK push failed" });
  }
});

// Helper: Send fallback payment options when M-Pesa fails
async function sendFallbackPaymentOptions(phone, plan_type, level, amount, checkoutId, isProduct = false) {
  const productInfo = isProduct ? "your order" : `your *${plan_type.toUpperCase()}* Plan`;
  
  try {
    // First message: Acknowledge the failure and offer alternatives
    await sendMessage(
      phone,
      `⚠️ *${plan_type.toUpperCase()} Payment - Alternative Options*\n\n` +
      `Your M-Pesa payment for ${productInfo} (KES ${amount}) wasn't completed. This happens when M-Pesa's payment gateway is temporarily unavailable.\n\n` +
      `✅ *No worries!* We have alternative payment methods to complete your order.\n\n` +
      `Choose one of the options below:`
    );

    // Second message: Payment options with buttons
    const options = [
      {
        id: `retry_mpesa_${checkoutId}`,
        title: "🔄 Retry M-Pesa",
        description: "Try the payment again"
      },
      {
        id: `bank_transfer_${checkoutId}`,
        title: "🏦 Bank Transfer",
        description: "Manual bank deposit"
      },
      {
        id: `cod_${checkoutId}`,
        title: "🚚 Cash on Delivery",
        description: "Pay when order arrives"
      },
      {
        id: `contact_support_${checkoutId}`,
        title: "📞 Contact Support",
        description: "Speak with our team"
      }
    ];

    await sendInteractiveList(
      phone,
      `${plan_type.toUpperCase()} Payment Options`,
      `Select preferred payment method for KES ${amount}:`,
      options
    );

    log(`✅ FALLBACK_OPTIONS_SENT: Phone=${phone}, Amount=${amount}, CheckoutID=${checkoutId}`, "PAYMENT");
  } catch (err) {
    log(`Error sending fallback payment options: ${err.message}`, "ERROR");
    // Fallback: send simple text message
    await sendMessage(
      phone,
      `⚠️ *M-Pesa Payment Failed*\n\nAlternative options:\n` +
      `1️⃣ *Retry M-Pesa* - Reply: *retry*\n` +
      `2️⃣ *Bank Transfer* - Reply: *bankfees kes ${amount}*\n` +
      `3️⃣ *Cash on Delivery* - Reply: *cod*\n` +
      `4️⃣ *Contact Support* - +254117604817 or +254743780542`
    );
  }
}

// Helper: Send bank transfer details
async function sendBankTransferDetails(phone, amount, plan_type, checkoutId) {
  try {
    await sendMessage(
      phone,
      `🏦 *Bank Transfer Instructions*\n\n` +
      `Amount to send: *KES ${amount}*\n\n` +
      `Bank: *KCB Bank Kenya*\n` +
      `Account Name: *Alphadome Limited*\n` +
      `Account Number: *1234567890*\n` +
      `Branch Code: *63000*\n` +
      `Swift Code: *KCBLKENX*\n\n` +
      `📌 *Important:*\n` +
      `• Use Reference: *${plan_type}-${checkoutId.slice(-8)}*\n` +
      `• Reply with the bank deposit receipt number\n` +
      `• Allow 2-5 minutes for confirmation\n\n` +
      `❓ Need help? Call +254117604817`
    );
    log(`BANK_TRANSFER_DETAILS_SENT: Phone=${phone}, Amount=${amount}`, "PAYMENT");
  } catch (err) {
    log(`Error sending bank transfer details: ${err.message}`, "ERROR");
  }
}

// Helper: Confirm alternative payment receipt
async function confirmAlternativePayment(phone, receiptRef, paymentMethod, amount, planType) {
  try {
    await sendMessage(
      phone,
      `✅ *${paymentMethod.toUpperCase()} Payment Received*\n\n` +
      `Receipt Reference: *${receiptRef}*\n` +
      `Amount: *KES ${amount}*\n` +
      `Plan: *${planType.toUpperCase()}*\n\n` +
      `📌 We'll process this within 2-5 minutes.\n` +
      `You'll receive a confirmation message when your account is activated.\n\n` +
      `Thank you for choosing Alphadome! 🙌`
    );
    log(`ALTERNATIVE_PAYMENT_CONFIRMED: Phone=${phone}, Method=${paymentMethod}, Receipt=${receiptRef}`, "PAYMENT");
  } catch (err) {
    log(`Error confirming alternative payment: ${err.message}`, "ERROR");
  }
}

app.post("/mpesa/callback", async (req, res) => {
  try {
    const body = req.body;

    // respond immediately to M-Pesa to avoid timeout
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

    const checkoutId = body.Body?.stkCallback?.CheckoutRequestID;
    const resultCode = body.Body?.stkCallback?.ResultCode;
    const callbackMetadata = body.Body?.stkCallback?.CallbackMetadata?.Item || [];

    const { data: subs, error: subErr } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("mpesa_checkout_request_id", checkoutId)
      .limit(1)
      .single();

    if (subErr || !subs) {
      log(`MPESA callback: subscription not found for CheckoutRequestID ${checkoutId}`, "WARN");
      return;
    }

    // Payment successful
    if (resultCode === 0) {
      const receipt = callbackMetadata.find(i => i.Name === "MpesaReceiptNumber")?.Value || null;
      const amount = callbackMetadata.find(i => i.Name === "Amount")?.Value || null;
      const phone = callbackMetadata.find(i => i.Name === "PhoneNumber")?.Value || subs.phone;

      // ✅ 1. Mark subscription as paid
      await supabase.from("subscriptions").update({
        status: "subscribed",
        mpesa_receipt_no: receipt,
        metadata: { ...(subs.metadata && typeof subs.metadata === "object" ? subs.metadata : {}), callback: body },
        updated_at: new Date().toISOString()
      }).eq("id", subs.id);

      // ✅ 2. Mark user as subscribed
      await supabase.from("users").update({
        subscribed: true,
        subscription_type: subs.plan_type,
        subscription_level: subs.level,
        updated_at: new Date().toISOString()
      }).eq("id", subs.user_id);

      // ✅ 3. Confirmation message to the user
      await sendMessage(
        phone,
        `🎉 *Payment Successful!*\n\nThank you for joining Alphadome.\nYour *${subs.plan_type.toUpperCase()} Plan - Level ${subs.level}* has been activated.\n\n🧾 Receipt: ${receipt}\n💰 Amount: KES ${amount}`
      );

      await mergeUserSessionContext(phone, {
        awaiting_review_subscription_id: subs.id,
        awaiting_review_since: new Date().toISOString(),
      });
      await sendMessage(phone, "⭐ Quick one: how would you rate your experience today? Reply with 1-5 (you can add a short comment).\nExample: `5 Great support`.");

      log(`✅ Subscription ${subs.id} marked paid (receipt ${receipt})`, "SYSTEM");
    } else {
      // 🔄 Payment failed, cancelled, or refunded - Offer fallback options
      const isProduct = subs.plan_type === "product_checkout";
      const waTarget = subs?.metadata?.customer_wa || subs.phone;
      
      await supabase.from("subscriptions").update({
        status: "failed",
        metadata: { callback: body, fallback_offered: true, failed_at: new Date().toISOString() },
        updated_at: new Date().toISOString()
      }).eq("id", subs.id);

      // Save failed payment context to user session for fallback recovery
      await mergeUserSessionContext(waTarget, {
        failed_subscription_id: subs.id,
        failed_checkout_id: checkoutId,
        failed_plan_type: subs.plan_type,
        failed_level: subs.level,
        failed_amount: subs.amount,
        failed_at: new Date().toISOString(),
        failure_result_code: resultCode,
      });

      // Send fallback payment options
      await sendFallbackPaymentOptions(
        waTarget,
        subs.plan_type,
        subs.level,
        subs.amount,
        checkoutId,
        isProduct
      );

      scheduleFallbackReminder({
        waPhone: waTarget,
        subscriptionId: subs.id,
        amount: subs.amount,
        planType: subs.plan_type,
        level: subs.level,
      });

      log(`Subscription ${subs.id} payment failed (ResultCode ${resultCode}) - Fallback options sent`, "WARN");
    }
  } catch (err) {
    log(`MPESA callback processing error: ${err.message}`, "ERROR");
  }
});

// ---------- INSERT END ----------


// ===== ADMIN COMMANDS (unchanged) =====
async function handleDiagnose(from, text) {
  const pass = text.split(" ")[1];
  if (!ADMIN_NUMBERS.includes(from) || pass !== ADMIN_PASS) {
    await sendMessage(from, "❌ Unauthorized or wrong password.");
    log(`Unauthorized /diagnose attempt from ${from}`, "WARN");
    return;
  }

  const mem = process.memoryUsage();
  const uptime = process.uptime().toFixed(0);
  const report = `🩺 Bot Diagnostics:
• Uptime: ${uptime}s
• RSS: ${(mem.rss / 1024 / 1024).toFixed(2)} MB
• Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`;

  await sendMessage(from, report);
  log(`Sent diagnostics to ${from}`, "SYSTEM");
}

// ... keep handleLogs, handleClearLogs, confirmClearLogs, handleHealthCheck, sendHelpMenu, and generateReply functions exactly as in the last version ...

async function handleLogs(from, text) {
  const pass = text.split(" ")[1];
  if (!ADMIN_NUMBERS.includes(from) || pass !== ADMIN_PASS) {
    await sendMessage(from, "❌ Unauthorized or wrong password.");
    log(`Unauthorized /logs attempt from ${from}`, "WARN");
    return;
  }

  const logPath = path.join(process.cwd(), "logs", "bot.log");
  if (!fs.existsSync(logPath)) {
    await sendMessage(from, "No logs found yet.");
    return;
  }

  try {
    const formData = new FormData();
    formData.append("file", fs.createReadStream(logPath));
    const uploadResponse = await axios.post("https://file.io", formData, {
      headers: formData.getHeaders(),
    });
    const fileUrl = uploadResponse.data.link;

    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "document",
        document: { link: fileUrl, filename: "bot.log" },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    log(`Sent log file link to ${from}`, "OUTGOING");
  } catch (err) {
    log(`Failed to send logs: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Error sending log file.");
  }
}

async function handleClearLogs(from, text) {
  const pass = text.split(" ")[1];
  if (!ADMIN_NUMBERS.includes(from) || pass !== ADMIN_PASS) {
    await sendMessage(from, "❌ Unauthorized or wrong password.");
    log(`Unauthorized /clearlogs attempt from ${from}`, "WARN");
    return;
  }

  pendingClearConfirmations[from] = true;
  await sendMessage(from, "⚠️ Are you sure you want to clear logs? Reply with 'YES' within 30 seconds to confirm.");
  log(`Pending /clearlogs confirmation for ${from}`, "SYSTEM");

  setTimeout(() => delete pendingClearConfirmations[from], 30000);
}

async function confirmClearLogs(from) {
  const logPath = path.join(process.cwd(), "logs", "bot.log");
  if (!fs.existsSync(logPath)) {
    await sendMessage(from, "No log file found to clear.");
    return;
  }

  try {
    fs.truncateSync(logPath, 0);
    log("Log file manually cleared by admin after confirmation.", "SYSTEM");
    await sendMessage(from, "🧹 Log file cleared successfully.");
  } catch (err) {
    log(`Error clearing logs: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Failed to clear logs.");
  }
}

async function handleHealthCheck(from, text) {
  const pass = text.split(" ")[1];
  if (!ADMIN_NUMBERS.includes(from) || pass !== ADMIN_PASS) {
    await sendMessage(from, "❌ Unauthorized or wrong password.");
    log(`Unauthorized /healthcheck attempt from ${from}`, "WARN");
    return;
  }

  try {
    const mem = process.memoryUsage();
    const uptimeHours = (process.uptime() / 3600).toFixed(2);
    const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(2);
    const rss = (mem.rss / 1024 / 1024).toFixed(2);

    await runHealthCheck([from]);

    const message = `🩺 *Bot Health Report*
• Uptime: ${uptimeHours} hours
• RSS: ${rss} MB
• Heap Used: ${heapUsed} MB
• Errors (last hour): 0

✅ Health snapshot logged to *logs/health.json*`;

    await sendMessage(from, message);
    log(`Manual health check triggered by ${from}`, "SYSTEM");
  } catch (err) {
    log(`Health check error: ${err.message}`, "ERROR");
    await sendMessage(from, "⚠️ Failed to complete health check.");
  }
}

async function sendHelpMenu(from) {
  const commands = [
    { cmd: "/help", desc: "List all available admin commands." },
    { cmd: "/diagnose <password>", desc: "Show uptime and memory diagnostics." },
    { cmd: "/logs <password>", desc: "Get the latest bot log file." },
    { cmd: "/clearlogs <password>", desc: "Clear the bot log file (requires YES confirmation)." },
    { cmd: "/healthcheck <password>", desc: "Run an instant health check and update logs/health.json." },
  ];

  let message = "🛠 *Admin Commands*\n\n";
  for (const c of commands) message += `• *${c.cmd}*\n  ${c.desc}\n\n`;
  await sendMessage(from, message.trim());
  log(`Sent help menu to ${from}`, "SYSTEM");
}


// ===== GPT REPLY GENERATION ===== 
// ===== GPT REPLY GENERATION WITH OPENROUTER FALLBACK =====

// ===== GPT REPLY WITH MULTI-FALLBACK (Axios + Hugging Face Router) =====

async function fetchCatalogForTenant(tenantPhone, query) {
  if (!tenantPhone || !query) return [];
  const { data, error } = await supabase.rpc("get_catalog", {
    tenant_phone: tenantPhone,
    q: query
  });
  if (error) {
    log(`Catalog RPC error: ${error.message}`, "WARN");
    return [];
  }
  return normalizeCatalogItems(data?.items || []);
}

async function fetchConversationContext(userId, brandId, limit = 8) {
  if (!userId || !brandId) return [];
  const { data, error } = await supabase.rpc("get_conversation_context", {
    p_user_id: userId,
    p_brand_id: brandId,
    p_limit: limit,
  });

  if (error) {
    log(`Conversation context error: ${error.message}`, "WARN");
    return [];
  }

  const items = data?.items || [];
  return items.map((m) => ({
    role: m.direction === "incoming" ? "user" : "assistant",
    content: m.message_text,
  }));
}

async function fetchUserProfile(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from("users")
    .select("id, phone, full_name, subscribed, subscription_type, subscription_level")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    log(`User profile error: ${error.message}`, "WARN");
    return null;
  }
  return data || null;
}

async function fetchBrandProfile(brandId) {
  if (!brandId) return null;
  const { data, error } = await supabase
    .from("brands")
    .select("*")
    .eq("id", brandId)
    .maybeSingle();
  if (error) {
    log(`Brand profile error: ${error.message}`, "WARN");
    return null;
  }
  return data || null;
}

function buildDbContext({ userProfile, brandProfile, tenant, catalogMatches = [] }) {
  const blocks = [];

  if (tenant) {
    const tenantBlock = {
      client_name: tenant.client_name,
      client_phone: tenant.client_phone,
      client_email: tenant.client_email,
      brand_id: tenant.brand_id,
      point_of_contact_name: tenant.point_of_contact_name,
      point_of_contact_phone: tenant.point_of_contact_phone,
    };
    blocks.push(`Tenant profile:\n${JSON.stringify(tenantBlock, null, 2)}`);
  }

  if (brandProfile) {
    const brandBlock = {
      id: brandProfile.id,
      name: brandProfile.name || brandProfile.brand_name || null,
      description: brandProfile.description || brandProfile.bio || null,
      website: brandProfile.website || null,
      email: brandProfile.email || null,
      phone: brandProfile.phone || null,
      location: brandProfile.location || null,
      industry: brandProfile.industry || null,
      category: brandProfile.category || null,
      tagline: brandProfile.tagline || null,
    };
    blocks.push(`Brand profile:\n${JSON.stringify(brandBlock, null, 2)}`);
  }

  if (userProfile) {
    const userBlock = {
      id: userProfile.id,
      phone: userProfile.phone,
      full_name: userProfile.full_name,
      subscribed: userProfile.subscribed,
      subscription_type: userProfile.subscription_type,
      subscription_level: userProfile.subscription_level,
    };
    blocks.push(`User profile:\n${JSON.stringify(userBlock, null, 2)}`);
  }

  if (catalogMatches.length) {
    const catalogBlock = catalogMatches.slice(0, 5).map((item) => ({
      sku: item.sku || item.id,
      name: item.name,
      price: item.price,
      currency: item.currency || "KES",
      stock_count: item.stock_count,
      store_url: item.store_url || null,
      category: item.category || item.metadata?.category || null,
      tags: item.tags || item.metadata?.tags || null,
    }));
    blocks.push(`Catalog matches:\n${JSON.stringify(catalogBlock, null, 2)}`);
  }

  return blocks.join("\n\n").trim();
}

function formatCatalogReply(items = []) {
  if (!items.length) return null;
  return { type: "catalog", items };
}

function buildCatalogList(items = []) {
  const rows = items.slice(0, 10).map((p) => ({
    id: p.sku || p.id,
    title: p.name || p.sku,
    description: p.price ? `${p.price} ${p.currency || "KES"}` : "Price on request",
  }));

  return [{
    title: "Catalog Results",
    rows,
  }];
}

function isGreetingMessage(message = "") {
  const text = (message || "").toLowerCase().trim();
  if (!text) return false;
  return [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "mambo",
    "niaje",
    "sasa",
    "habari",
  ].some((greet) => text === greet || text.startsWith(`${greet} `));
}

async function generateReply(
  userMessage,
  tenant = null,
  templates = null,
  trainingData = [],
  contextMessages = [],
  catalogMatches = [],
  dbContext = ""
) {
  const creds = getDecryptedCredentials(tenant);
  const openaiClient = new OpenAI({ apiKey: creds.aiApiKey });
  const systemMessage = {
    role: "system",
    content: getSystemPrompt(tenant, templates || [], trainingData || []),
  };

  log(
    `LLM providers: openai=${Boolean(creds.aiApiKey)} openrouter=${Boolean(process.env.OPENROUTER_KEY)} hf=${Boolean(process.env.HF_API_KEY)}`,
    "SYSTEM"
  );

  const isGreeting = isGreetingMessage(userMessage);
  if (isGreeting) {
    log("Greeting detected → routing to LLM", "SYSTEM");
  } else {
    // 0️⃣ Try catalog search first (tenant-aware)
    const tenantPhone = tenant?.client_phone || tenant?._business_phone;
    const items = catalogMatches?.length
      ? catalogMatches
      : tenantPhone
        ? await fetchCatalogForTenant(tenantPhone, userMessage)
        : [];
    if (items.length) {
      const catalogReply = formatCatalogReply(items);
      if (catalogReply) {
        log(`✓ Catalog match: ${items.length} items`, "AI");
        return {
          ...catalogReply,
          meta: { llm_used: false, reason: "catalog" },
        };
      }
    }
  }

  // 0️⃣b Try tenant training data before AI
  const trainingReply = findTrainingAnswer(trainingData || [], userMessage);
  if (trainingReply) {
    log("✓ Training data match", "AI");
    return {
      type: "text",
      text: trainingReply,
      meta: { llm_used: false, reason: "training" },
    };
  }

  // If tenant-aware but no AI providers configured, give a safe fallback
  if (tenant && !creds.aiApiKey && !process.env.OPENROUTER_KEY && !process.env.HF_API_KEY) {
    log("No LLM credentials available; returning guardrail reply", "SYSTEM");
    return {
      type: "text",
      text: "I can only answer from the brand catalog and approved brand data. Please share a product name, SKU, or ask for a human agent.",
      meta: { llm_used: false, reason: "no_llm_credentials" },
    };
  }

  log(`LLM context: ${contextMessages?.length || 0} messages`, "SYSTEM");

  const contextBlock = dbContext
    ? { role: "system", content: `Context data:\n${dbContext}` }
    : null;
  const messageStack = [
    systemMessage,
    ...(contextBlock ? [contextBlock] : []),
    ...(contextMessages || []),
    { role: "user", content: userMessage },
  ];

  // 1️⃣ Try OpenAI first (only if key is present)
  if (creds.aiApiKey) {
    log("LLM path: OpenAI", "SYSTEM");
    try {
      const start = Date.now();
      const completion = await openaiClient.chat.completions.create({
        model: creds.aiModel,
        messages: messageStack,
      });

      const reply = completion.choices[0].message.content;
      const latency = Date.now() - start;
      log(`✓ ${creds.aiProvider} reply: ${reply.substring(0, 50)}...`, "AI");
      return {
        type: "text",
        text: reply,
        meta: { llm_used: true, llm_provider: "openai", llm_latency_ms: latency },
      };
    } catch (openAIErr) {
      incrementErrorCount();
      log(`${creds.aiProvider} error: ${openAIErr.message}`, "ERROR");
      if (!process.env.OPENROUTER_KEY && !process.env.HF_API_KEY) {
        return {
          type: "text",
          text: fallbackMessage(),
          meta: { llm_used: false, reason: "openai_error", llm_error: openAIErr.message },
        };
      }
    }
  } else {
    log("OpenAI key missing; skipping OpenAI call", "SYSTEM");
  }

  // 2️⃣ Fallback to OpenRouter Meta Llama 3.3 free
  try {
    log("LLM path: OpenRouter", "SYSTEM");
    const start = Date.now();
    const routerResponse = await axios.post(
      "https://api.openrouter.ai/v1/chat/completions",
      {
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages: messageStack,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (routerResponse.data?.choices?.length > 0) {
      const routerReply = routerResponse.data.choices[0].message.content;
      const latency = Date.now() - start;
      log(`✓ OpenRouter reply: ${routerReply.substring(0, 50)}...`, "AI");
      return {
        type: "text",
        text: routerReply,
        meta: { llm_used: true, llm_provider: "openrouter", llm_latency_ms: latency },
      };
    } else {
      log("OpenRouter error: No choices returned", "ERROR");
    }
  } catch (routerErr) {
    log(`OpenRouter error: ${routerErr.message}`, "ERROR");
  }

  // 3️⃣ Fallback to Hugging Face (new router-based API)
  try {
    log("LLM path: HuggingFace", "SYSTEM");
    const start = Date.now();
    const hfResponse = await axios.post(
      "https://router.huggingface.co/v1/chat/completions",
      {
        model: "meta-llama/Llama-3.1-8B-Instruct:novita", // ✅ new inference model
        messages: messageStack,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HF_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (hfResponse.data?.choices?.length > 0) {
      const hfReply = hfResponse.data.choices[0].message.content;
      const latency = Date.now() - start;
      log(`✓ HuggingFace reply: ${hfReply.substring(0, 50)}...`, "AI");
      return {
        type: "text",
        text: hfReply,
        meta: { llm_used: true, llm_provider: "huggingface", llm_latency_ms: latency },
      };
    } else {
      log("HuggingFace error: No choices returned", "ERROR");
    }
  } catch (hfErr) {
    log(`HuggingFace error: ${hfErr.message}`, "ERROR");
  }

  // 4️⃣ Static fallback message (guaranteed response)
  try {
    return {
      type: "text",
      text: fallbackMessage(),
      meta: { llm_used: false, reason: "fallback" },
    };
  } catch (finalErr) {
    log(`Final fallback error: ${finalErr.message}`, "ERROR");
    // Absolute last resort: plain string
    return {
      type: "text",
      text: "Sorry, I couldn't process your request right now. Please try again later.",
      meta: { llm_used: false, reason: "hard_fallback", error: finalErr.message },
    };
  }
}

// ===== Fallback message remains unchanged =====
function fallbackMessage() {
  return `👋 Hey there! Welcome to *Alphadome* — your all-in-one creative AI ecosystem helping brands, creators, and innovators thrive in the digital world.

Here’s a glimpse of what we build and do:

• 🤖 Explore my AI Agent Portfolio → https://beacons.ai/saddymalingu  
• 🎥 Creative Campaigns & Video Reels → https://www.instagram.com/afrika_bc/  
• 🎬 Meet our AI Influencers & Bots →  
   https://www.tiktok.com/@soma.katiba  
   https://www.tiktok.com/@saddymalingu  
• 📰 Read insights & stories — more coming soon!

Alphadome helps brands scale through automation, AI storytelling, and digital creativity.

💡 Want to be part of this system? Reply *Join Alphadome* to get started.

📞 Need help? Contact the creator directly:  
• Call: +254743780542  
• WhatsApp: +254117604817`;
}


// helper: get oauth token from Safaricom Daraja
async function getMpesaAuthToken() {
  try {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString("base64");

    const base = process.env.MPESA_ENV === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    const resp = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return resp.data.access_token;
  } catch (err) {
    log(`M-Pesa auth error: ${err.response?.data || err.message}`, "ERROR");
    throw err;
  }
}

// helper: initiate STK push
// phone must be in format 2547XXXXXXXX (no leading 0)
// ===== PARSE M-PESA ERROR CODES =====
// Maps M-Pesa error codes to user-friendly messages
function getMpesaErrorMessage(errorCode) {
  const errorMap = {
    '400': '❌ Invalid phone number format. Use format: 254712345678',
    '401': '⚠️ Invalid phone number. Check the number and try again.',
    '402': '💳 Phone number is not registered for M-Pesa.',
    '403': '🔒 Access denied - contact support.',
    '404': '❌ Phone number not found.',
    '500': '⚠️ M-Pesa system error. Please try again in a few moments.',
    '501': '⚠️ Service temporarily unavailable. Retry shortly.',
    '502': '💬 M-Pesa is temporarily unavailable. Try again soon.',
    '17': '❌ Phone number format invalid. Ensure it starts with 254.',
    'INVALID_PHONENUMBER': '❌ Invalid phone number. Use format: 254712345678',
    'INVALID_PARTYB': '❌ Business shortcode error. Contact support.',
    'EXPIRED_TRANSACTION': '⏱️ Transaction expired. Please try again.',
  };
  return errorMap[errorCode] || '⚠️ Payment processing error. Please try again or contact support.';
}

async function initiateStkPush({ phone, amount, accountRef, transactionDesc }) {
  try {
    // ✅ Step 1: Validate environment variables
    if (
      !process.env.MPESA_CONSUMER_KEY ||
      !process.env.MPESA_CONSUMER_SECRET ||
      !process.env.MPESA_PASSKEY ||
      !process.env.MPESA_SHORTCODE ||
      !process.env.MPESA_CALLBACK_URL
    ) {
      log("⚠️ Missing one or more M-Pesa credentials in environment variables", "ERROR");
      throw new Error("Missing required M-Pesa credentials");
    }

    // ✅ Step 2: Authenticate with Daraja
    let token;
    try {
      token = await getMpesaAuthToken();
    } catch (authErr) {
      log(`❌ Failed to get M-Pesa token: ${authErr.message}`, "ERROR");
      throw new Error("Failed to authenticate with M-Pesa API");
    }

    // ✅ Step 3: Prepare STK push request
    const base = process.env.MPESA_ENV === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";

    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14); // YYYYMMDDhhmmss
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

    const body = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone,               // MSISDN sending the money
      PartyB: shortcode,           // Paybill/shortcode receiving payment
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: accountRef,
      TransactionDesc: transactionDesc || "Alphadome subscription",
    };

    // ✅ Step 4: Send STK push
    const resp = await axios.post(`${base}/mpesa/stkpush/v1/processrequest`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    // ✅ Step 5: Return Safaricom response
    log(`✅ STK push initiated for ${accountRef || 'transaction'} - CheckoutRequestID: ${resp.data?.CheckoutRequestID}`, "PAYMENT");
    return resp.data;

  } catch (err) {
    const errorCode = err.response?.data?.errorCode || err.response?.status || 'UNKNOWN';
    const errorMsg = err.response?.data?.errorMessage || err.message;
    log(`❌ STK Push error [${errorCode}]: ${errorMsg}`, "PAYMENT");
    
    // Attach parsed error for caller to handle
    const parsedError = new Error(getMpesaErrorMessage(errorCode));
    parsedError.mpesaCode = errorCode;
    parsedError.mpesaMessage = errorMsg;
    throw parsedError;
  }
}


// ===== LIVE LOG STREAM =====
app.get("/logs/live", async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.ADMIN_PASS) {
    return res.status(403).send("Unauthorized");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const { data: recentLogs, error } = await supabase
    .from("logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(20);

  if (!error && recentLogs) {
    recentLogs.reverse().forEach((logEntry) => {
      res.write(`data: [${logEntry.created_at}] [${logEntry.level}] [${logEntry.source}] ${logEntry.message}\n\n`);
    });
  }

  let lastCheck = new Date().toISOString();
  const interval = setInterval(async () => {
    const { data: newLogs } = await supabase
      .from("logs")
      .select("*")
      .gt("created_at", lastCheck)
      .order("created_at", { ascending: true });

    if (newLogs && newLogs.length > 0) {
      lastCheck = newLogs[newLogs.length - 1].created_at;
      newLogs.forEach((logEntry) => {
        res.write(`data: [${logEntry.created_at}] [${logEntry.level}] [${logEntry.source}] ${logEntry.message}\n\n`);
      });
    }
  }, 3000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});


// ========== GET HISTORICAL LOGS ==========
// Example usage: /logs/history?days=3&key=YOUR_ADMIN_PASS
app.get("/logs/history", async (req, res) => {
  try {
    const { key, days = 3 } = req.query;

    // 🔐 Security check
    if (key !== process.env.ADMIN_PASS) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // ⏱ Get logs from X days ago
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("logs")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[HISTORY LOG ERROR]", error.message);
      return res.status(500).json({ error: error.message });
    }

    // 🗂 Return logs in JSON
    res.status(200).json({
      message: `Fetched ${data.length} logs from the last ${days} day(s)`,
      logs: data,
    });
  } catch (err) {
    console.error("[HISTORY ROUTE ERROR]", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// === AUTO-RETRY FAILED WHATSAPP MESSAGES ===
setInterval(async () => {
  try {
    const { data: failedMsgs, error } = await supabase
      .from("whatsapp_logs")
      .select("id, phone, error_message, retry_count")
      .eq("status", "failed")
      .lt("retry_count", 3) // only retry up to 3 times
      .gte(
        "created_at",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      );

    if (error) throw error;
    if (!failedMsgs?.length) return;

    log(`🔁 Retrying ${failedMsgs.length} failed WhatsApp messages`, "SYSTEM");

    for (const msg of failedMsgs) {
      try {
        const fallback = `🙏 *Hello, apologies for the inconvenience!* We are experiencing a temporary issue, but we'll be back online in a few.  

👋 Hey there! Welcome to *Alphadome* — your all-in-one creative AI ecosystem helping brands, creators, and innovators thrive in the digital world. 

Here’s a glimpse of what we build and do:

• 🤖 Explore my AI Agent Portfolio → https://beacons.ai/saddymalingu  
• 🎥 Creative Campaigns & Video Reels → https://www.instagram.com/afrika_bc/  
• 🎬 Meet our AI Influencers & Bots →  
   https://www.tiktok.com/@soma.katiba  
   https://www.tiktok.com/@saddymalingu  
• 📰 Read insights & stories — more coming soon!

Alphadome helps brands scale through automation, AI storytelling, and digital creativity.

💡 Want to be part of this system? Reply *Join Alphadome* to get started.

📞 Need help? Contact the creator directly:  
• Call : +254743780542  
• WhatsApp: +254117604817`;

        const sent = await sendMessage(msg.phone, fallback);
        if (sent) {
          await supabase
            .from("whatsapp_logs")
            .update({ status: "resent", retry_count: (msg.retry_count || 0) + 1 })
            .eq("id", msg.id);

          log(`✅ Successfully resent message to ${msg.phone}`, "SYSTEM");
        } else {
          throw new Error("Message send failed (no confirmation).");
        }
      } catch (retryErr) {
        // increment retry count and mark as permanently failed after 3 attempts
        const nextRetry = (msg.retry_count || 0) + 1;
        const newStatus = nextRetry >= 3 ? "permanent_failure" : "failed";

        await supabase
          .from("whatsapp_logs")
          .update({ retry_count: nextRetry, status: newStatus })
          .eq("id", msg.id);

        log(
          `❌ Retry ${nextRetry} failed for ${msg.phone}: ${retryErr.message}`,
          "ERROR"
        );
      }
    }
  } catch (err) {
    log(`Retry job failed: ${err.message}`, "ERROR");
  }
}, 5 * 60 * 1000); // runs every 5 minutes


// ===== START SERVER =====
// ===== WRITER'S FLOW ADMIN API =====

const WF_INDUSTRY_CATALOG = [
  { name: "finance", seeds: ["lending", "credit", "payments", "risk", "collections"], commerce_fit: 0.65, b2b_fit: 0.95 },
  { name: "fintech", seeds: ["mobile money", "wallet", "merchant payments", "onboarding"], commerce_fit: 0.72, b2b_fit: 0.92 },
  { name: "insurance", seeds: ["policy sales", "claims", "broker", "customer retention"], commerce_fit: 0.58, b2b_fit: 0.82 },
  { name: "healthcare", seeds: ["appointments", "patient follow-up", "clinic operations", "billing"], commerce_fit: 0.74, b2b_fit: 0.66 },
  { name: "education", seeds: ["admissions", "enrollment", "student follow-up", "fee reminders"], commerce_fit: 0.76, b2b_fit: 0.62 },
  { name: "real_estate", seeds: ["property leads", "site visits", "brokers", "mortgage referrals"], commerce_fit: 0.68, b2b_fit: 0.86 },
  { name: "logistics", seeds: ["fleet operations", "delivery updates", "shipment tracking", "B2B fulfillment"], commerce_fit: 0.79, b2b_fit: 0.84 },
  { name: "retail", seeds: ["catalog sales", "promotions", "reorders", "cart recovery"], commerce_fit: 0.96, b2b_fit: 0.52 },
  { name: "hospitality", seeds: ["reservations", "room bookings", "guest upsell", "event inquiries"], commerce_fit: 0.88, b2b_fit: 0.56 },
  { name: "manufacturing", seeds: ["distributor outreach", "procurement", "after-sales", "B2B orders"], commerce_fit: 0.54, b2b_fit: 0.91 },
  { name: "agriculture", seeds: ["input suppliers", "produce buyers", "cooperative outreach", "field logistics"], commerce_fit: 0.69, b2b_fit: 0.78 },
  { name: "professional_services", seeds: ["consulting leads", "proposal follow-up", "retainer upsell", "client success"], commerce_fit: 0.63, b2b_fit: 0.88 },
];

function wfNormalizeList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  if (value == null) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function wfCanonicalIndustryName(raw) {
  const value = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!value) return "";
  if (value === "banking") return "finance";
  if (value === "financial_services") return "finance";
  return value;
}

function wfFindIndustryProfile(raw) {
  const canonical = wfCanonicalIndustryName(raw);
  return WF_INDUSTRY_CATALOG.find((x) => x.name === canonical) || {
    name: canonical || String(raw || "").toLowerCase(),
    seeds: [],
    commerce_fit: 0.6,
    b2b_fit: 0.7,
  };
}

async function buildWfIndustryResearchPlan({ keywords = [], industryPool = [], maxIndustries = 6 } = {}) {
  const ops = await buildAdminOpsOverview();
  const k = ops?.kpis || {};

  const pool = wfNormalizeList(industryPool);
  const workingPool = pool.length
    ? pool.map(wfCanonicalIndustryName).filter(Boolean)
    : WF_INDUSTRY_CATALOG.map((x) => x.name);

  const keywordTokens = wfNormalizeList(keywords).map((k) => k.toLowerCase());

  // Pull historical Writer's Flow outcomes and relevance by industry.
  const histResp = await supabase
    .from("wf_leads")
    .select("industry, status, relevance_score")
    .order("discovered_at", { ascending: false })
    .limit(2500);

  const histRows = histResp?.data || [];
  const byIndustry = new Map();
  for (const row of histRows) {
    const key = wfCanonicalIndustryName(row.industry || "other");
    const item = byIndustry.get(key) || { total: 0, contacted: 0, qualified: 0, relevance_sum: 0 };
    item.total += 1;
    if (String(row.status || "").toLowerCase() === "contacted") item.contacted += 1;
    if (String(row.status || "").toLowerCase() === "qualified") item.qualified += 1;
    item.relevance_sum += Number(row.relevance_score || 0);
    byIndustry.set(key, item);
  }

  const attempts = Number(k.payment_attempts_30d || 0);
  const failed = Number(k.failed_payments_30d || 0);
  const success = Number(k.successful_payments_30d || 0);
  const incoming24h = Number(k.incoming_messages_24h || 0);
  const conversion = Number(k.conversion_rate_pct_30d || 0);

  const priorities = workingPool.map((industryName) => {
    const profile = wfFindIndustryProfile(industryName);
    const hist = byIndustry.get(profile.name) || { total: 0, contacted: 0, qualified: 0, relevance_sum: 0 };

    const reasons = [];
    let score = 50;

    // Historical signal.
    const contactedRate = hist.total ? hist.contacted / hist.total : 0;
    const qualifiedRate = hist.total ? hist.qualified / hist.total : 0;
    const avgRelevance = hist.total ? hist.relevance_sum / hist.total : 0;
    score += Math.round(contactedRate * 22);
    score += Math.round(qualifiedRate * 12);
    score += Math.round(avgRelevance * 0.12);
    if (hist.total > 0) {
      reasons.push(`historical wf signal: ${hist.total} leads, ${Math.round(contactedRate * 100)}% contacted`);
    }

    // Ops-driven signal.
    if (incoming24h < 8) {
      score += Math.round(profile.commerce_fit * 18);
      reasons.push("low traffic: prioritizing high WhatsApp-commerce fit");
    }
    if (failed > success) {
      score += Math.round(profile.b2b_fit * 16);
      reasons.push("payment reliability pressure: prioritizing stronger B2B value cases");
    }
    if (attempts === 0 || conversion < 2) {
      score += Math.round(profile.commerce_fit * 10);
      reasons.push("low conversion: prioritizing sectors with short-cycle buying behavior");
    }

    // Keyword affinity.
    const keywordHit = keywordTokens.some((kw) => profile.name.includes(kw) || kw.includes(profile.name));
    if (keywordHit) {
      score += 12;
      reasons.push("keyword-industry direct match");
    }

    return {
      industry: profile.name,
      score,
      seeds: profile.seeds,
      reasons: reasons.slice(0, 3),
      historical: {
        total: hist.total,
        contacted_rate_pct: Math.round(contactedRate * 100),
        avg_relevance: Math.round(avgRelevance),
      },
    };
  })
    .sort((a, b) => b.score - a.score);

  const top = priorities.slice(0, Math.max(1, Math.min(parseInt(maxIndustries, 10) || 6, 12)));
  const recommendedIndustries = top.map((x) => x.industry);
  const keywordSuggestions = [...new Set([
    ...keywordTokens,
    ...top.flatMap((x) => x.seeds || []),
  ])].slice(0, 18);

  return {
    generated_at: new Date().toISOString(),
    ops_snapshot: {
      incoming_messages_24h: incoming24h,
      payment_attempts_30d: attempts,
      successful_payments_30d: success,
      failed_payments_30d: failed,
      conversion_rate_pct_30d: conversion,
    },
    priorities,
    recommended_industries: recommendedIndustries,
    keyword_suggestions: keywordSuggestions,
  };
}

app.post("/admin/api/wf/research-plan", adminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const plan = await buildWfIndustryResearchPlan({
      keywords: wfNormalizeList(body.keywords),
      industryPool: wfNormalizeList(body.industry_pool),
      maxIndustries: parseInt(body.max_industries, 10) || 6,
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List campaigns
app.get("/admin/api/wf/campaigns", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("wf_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ ok: true, campaigns: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create campaign
app.post("/admin/api/wf/campaigns", adminAuth, async (req, res) => {
  try {
    const {
      name, keywords = [], industries = [], outreach_types = ["pitch"],
      channels = ["email"], target_count = 20, quality_threshold = 70, notes,
    } = req.body || {};
    if (!name || !keywords.length) {
      return res.status(400).json({ ok: false, error: "name and keywords required" });
    }
    const { data, error } = await supabase.from("wf_campaigns").insert([{
      name: String(name).trim(),
      keywords: Array.isArray(keywords) ? keywords : [keywords],
      industries: Array.isArray(industries) ? industries : [],
      outreach_types: Array.isArray(outreach_types) ? outreach_types : ["pitch"],
      channels: Array.isArray(channels) ? channels : ["email"],
      target_count: parseInt(target_count, 10) || 20,
      quality_threshold: parseInt(quality_threshold, 10) || 70,
      notes: notes || null,
      status: "draft",
    }]).select().single();
    if (error) throw error;
    res.json({ ok: true, campaign: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update campaign
app.patch("/admin/api/wf/campaigns/:id", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ["name","keywords","industries","outreach_types","channels","target_count","quality_threshold","notes","status"];
    const updates = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    const { data, error } = await supabase.from("wf_campaigns").update(updates).eq("id", id).select().single();
    if (error) throw error;
    res.json({ ok: true, campaign: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete campaign
app.delete("/admin/api/wf/campaigns/:id", adminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("wf_campaigns").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Run a campaign (async — returns immediately, runs in background)
app.post("/admin/api/wf/campaigns/:id/run", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: campaign, error } = await supabase.from("wf_campaigns").select("*").eq("id", id).single();
    if (error || !campaign) return res.status(404).json({ ok: false, error: "Campaign not found" });
    if (campaign.status === "running") return res.status(409).json({ ok: false, error: "Campaign is already running" });

    const runtime = req.body || {};
    const targetingMode = String(runtime.targeting_mode || "manual").toLowerCase();
    const resolvedKeywords = wfNormalizeList(runtime.keywords).length
      ? wfNormalizeList(runtime.keywords)
      : wfNormalizeList(campaign.keywords || []);

    let resolvedIndustries = wfNormalizeList(runtime.industries).length
      ? wfNormalizeList(runtime.industries)
      : wfNormalizeList(campaign.industries || []);

    let industryPlan = null;
    if (targetingMode === "auto_research") {
      const plan = await buildWfIndustryResearchPlan({
        keywords: resolvedKeywords,
        industryPool: wfNormalizeList(runtime.industry_pool).length
          ? wfNormalizeList(runtime.industry_pool)
          : resolvedIndustries,
        maxIndustries: parseInt(runtime.max_industries, 10) || 6,
      });
      resolvedIndustries = plan.recommended_industries || resolvedIndustries;
      industryPlan = plan.priorities || [];
    }

    const resolvedOutreachTypes = wfNormalizeList(runtime.outreach_types).length
      ? wfNormalizeList(runtime.outreach_types)
      : (Array.isArray(campaign.outreach_types) ? campaign.outreach_types : ["pitch"]);

    const resolvedChannels = wfNormalizeList(runtime.channels).length
      ? wfNormalizeList(runtime.channels)
      : (Array.isArray(campaign.channels) ? campaign.channels : ["email"]);

    const resolvedTargetCount = parseInt(runtime.target_count, 10) || parseInt(campaign.target_count, 10) || 20;
    const resolvedQualityThreshold = parseInt(runtime.quality_threshold, 10) || parseInt(campaign.quality_threshold, 10) || 70;

    // Get SMTP config from env (or inject smtpConfig from request for tenant-specific)
    const smtpConfig = {
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT,
      smtp_user: process.env.SMTP_USER,
      smtp_pass: process.env.SMTP_PASS,
      smtp_from_name: process.env.SMTP_FROM_NAME || "Alphadome",
    };

    // Respond immediately, run pipeline in background
    res.json({
      ok: true,
      message: "Campaign started",
      campaign_id: id,
      targeting_mode: targetingMode,
      resolved_industries: resolvedIndustries,
      resolved_keywords: resolvedKeywords,
    });

    import("./writers_flow/orchestrator.js").then(mod => {
      const runWritersFlow = mod.default;
      runWritersFlow({
        campaignId: id,
        keywords: resolvedKeywords,
        industries: resolvedIndustries,
        industryPlan,
        outreachTypes: resolvedOutreachTypes,
        channels: resolvedChannels,
        targetCount: resolvedTargetCount,
        qualityThreshold: resolvedQualityThreshold,
        smtpConfig,
        supabase,
        testMode: req.query.test === "1",
      }).catch(err => {
        log(`[WF] Campaign ${id} failed: ${err.message}`, "ERROR");
      });
    }).catch(err => {
      log(`[WF] Failed to import orchestrator: ${err.message}`, "ERROR");
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get leads for a campaign
app.get("/admin/api/wf/campaigns/:id/leads", adminAuth, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = supabase.from("wf_leads").select("*").eq("campaign_id", req.params.id)
      .order("discovered_at", { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, leads: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get outreach for a campaign
app.get("/admin/api/wf/campaigns/:id/outreach", adminAuth, async (req, res) => {
  try {
    const { status, channel, limit = 50, offset = 0 } = req.query;
    let query = supabase.from("wf_outreach").select("*, wf_leads(organization, email, url)")
      .eq("campaign_id", req.params.id)
      .order("created_at", { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (status) query = query.eq("status", status);
    if (channel) query = query.eq("channel", channel);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, outreach: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manually send a queued/draft outreach item
app.post("/admin/api/wf/outreach/:id/send", adminAuth, async (req, res) => {
  try {
    const { data: item, error } = await supabase.from("wf_outreach")
      .select("*, wf_leads(email, phone)").eq("id", req.params.id).single();
    if (error || !item) return res.status(404).json({ ok: false, error: "Outreach item not found" });
    if (item.status === "sent") return res.status(409).json({ ok: false, error: "Already sent" });

    if (item.channel === "email") {
      const toEmail = item.wf_leads?.email;
      if (!toEmail) return res.status(400).json({ ok: false, error: "No email on lead" });
      const smtpConfig = { smtp_host: process.env.SMTP_HOST, smtp_port: process.env.SMTP_PORT,
        smtp_user: process.env.SMTP_USER, smtp_pass: process.env.SMTP_PASS };
      const { default: sendEmailFn } = await import("./writers_flow/emailSender.js");
      await sendEmailFn({ to: toEmail, subject: item.subject || "Hello from Alphadome", text: item.body, smtpConfig });
    }
    // WhatsApp channel: update status to 'queued' for Meta-compliant dispatch
    const newStatus = item.channel === "whatsapp" ? "queued" : "sent";
    await supabase.from("wf_outreach").update({ status: newStatus, sent_at: new Date().toISOString() }).eq("id", req.params.id);
    if (item.lead_id) {
      await supabase.from("wf_leads").update({ status: "contacted", contacted_at: new Date().toISOString() }).eq("id", item.lead_id);
    }
    res.json({ ok: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Writer's Flow stats overview
app.get("/admin/api/wf/stats", adminAuth, async (req, res) => {
  try {
    const [campaigns, leads, outreach] = await Promise.all([
      supabase.from("wf_campaigns").select("status"),
      supabase.from("wf_leads").select("status"),
      supabase.from("wf_outreach").select("status, channel"),
    ]);
    const countBy = (arr, key, val) => (arr || []).filter(r => r[key] === val).length;
    res.json({
      ok: true,
      stats: {
        campaigns: {
          total: (campaigns.data || []).length,
          running: countBy(campaigns.data, "status", "running"),
          completed: countBy(campaigns.data, "status", "completed"),
          draft: countBy(campaigns.data, "status", "draft"),
        },
        leads: {
          total: (leads.data || []).length,
          qualified: countBy(leads.data, "status", "qualified"),
          contacted: countBy(leads.data, "status", "contacted"),
          skipped: countBy(leads.data, "status", "skipped"),
        },
        outreach: {
          sent: countBy(outreach.data, "status", "sent"),
          draft: countBy(outreach.data, "status", "draft"),
          failed: countBy(outreach.data, "status", "failed"),
          queued: countBy(outreach.data, "status", "queued"),
          email: (outreach.data || []).filter(r => r.channel === "email").length,
          whatsapp: (outreach.data || []).filter(r => r.channel === "whatsapp").length,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(process.env.PORT, () => {
  log(`Server running on port ${process.env.PORT}`, "SYSTEM");
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});




