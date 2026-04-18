// --- Imports and app initialization ---

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  for (const phone of candidates) {
    const urlSafe = encodeURIComponent(phone);
    const url = `${process.env.SB_URL}/rest/v1/bot_tenants?client_phone=eq.${urlSafe}`;
    try {
      const response = await axios.patch(url, updates, {
        headers: {
          apikey: process.env.SB_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SB_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Content-Profile": "alphadome",
          Prefer: "return=representation",
        },
      });
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length) return rows;
    } catch (err) {
      if (err.response?.status !== 404 && err.response?.status !== 406) throw err;
    }
  }
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

  const trainingContext = buildTrainingContext(trainingData);
  const trainingBlock = trainingContext 
    ? `\n\n${guardrails}\n\n---\n\nKNOWLEDGE BASE:\n\n${trainingContext}` 
    : `\n\n${guardrails}`;

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
              referral_code: referralCode,
              referrer_phone: referrerPhone,
            },
          },
        ]);

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
          metadata: stkResp,
        })
        .eq("id", subId);
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
      // Payment failed or cancelled
      await supabase.from("subscriptions").update({
        status: "failed",
        metadata: { callback: body },
        updated_at: new Date().toISOString()
      }).eq("id", subs.id);

      await sendMessage(
        subs.phone,
        `⚠️ Payment not completed for your *${subs.plan_type.toUpperCase()} Plan - Level ${subs.level}*.\nPlease try again or contact +254117604817 or +254743780542 for help.`
      );

      log(`Subscription ${subs.id} payment failed (ResultCode ${resultCode})`, "WARN");
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

  // 4️⃣ Static fallback message
  return {
    type: "text",
    text: fallbackMessage(),
    meta: { llm_used: false, reason: "fallback" },
  };
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
app.listen(process.env.PORT, () => {
  log(`Server running on port ${process.env.PORT}`, "SYSTEM");
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});




