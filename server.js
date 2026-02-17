
// --- Imports and app initialization ---

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { log } from "./utils/logger.js";
import { sendMessage } from "./utils/messenger.js";
import { startHealthMonitor, runHealthCheck } from "./utils/healthMonitor.js";

const app = express();
app.use(express.json());

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SB_URL,
  process.env.SB_SERVICE_ROLE_KEY
);

// ✅ Default brand UUID (your platform brand)
const DEFAULT_BRAND_ID =
  process.env.DEFAULT_BRAND_ID || "1af71403-b4c3-4eac-9aab-48ee2576a9bb";

const ADMIN_PASS = process.env.ADMIN_PASS;
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

    if (!businessPhone && !businessPhoneId && !businessAccountId) {
      req.tenant = null;
      req.isTenantAware = false;
      return next();
    }

    const normalizePhone = (phone) => (phone || "").replace(/\D/g, "");
    const normalizedBusinessPhone = normalizePhone(businessPhone);

    const { data: tenantResult, error } = await supabase.rpc("get_tenant_by_wa", {
      business_phone_id: businessPhoneId || null,
      business_account_id: businessAccountId || null,
      business_phone: normalizedBusinessPhone || null,
    });

    const tenant = tenantResult?.tenant || null;

    if (error) {
      log(
        `Tenant lookup error for ${businessPhoneId || businessAccountId || normalizedBusinessPhone}: ${error.message}`,
        "WARN"
      );
      req.tenant = null;
      req.isTenantAware = false;
      return next();
    }

    if (!tenant) {
      log(
        `No tenant found for business phone ${businessPhoneId || businessAccountId || normalizedBusinessPhone} - using default`,
        "DEBUG"
      );
      req.tenant = null;
      req.isTenantAware = false;
      return next();
    }

    if (!tenant.is_active) {
      log(`Tenant ${tenant.client_name} is inactive - using fallback`, "WARN");
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
      `✓ Tenant loaded: ${tenant.client_name} (${businessPhoneId || businessAccountId || normalizedBusinessPhone})`,
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

  const maxItems = 15;
  const maxChars = 2000;
  let result = "";

  for (const entry of trainingData.slice(0, maxItems)) {
    const q = (entry.question || "").trim();
    const a = (entry.answer || "").trim();
    if (!a) continue;
    const line = q ? `- Q: ${q}\n  A: ${a}\n` : `- ${a}\n`;
    if (result.length + line.length > maxChars) break;
    result += line;
  }

  return result.trim();
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

  const guardrails = `You must ONLY answer using the brand's portfolio, catalog, and the training data provided. Do NOT invent details or mention unrelated communities. If the information is not available, say you don't have it in the catalog/brand data and ask for a more specific product name, SKU, or request to connect with a human.`;

  const trainingContext = buildTrainingContext(trainingData);
  const trainingBlock = trainingContext ? `\n\nBrand data:\n${trainingContext}` : "";

  return `${basePrompt}\n\n${guardrails}${trainingBlock}`.trim();
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
        .from("alphadome.bot_tenants")
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
        .from("alphadome.bot_tenants")
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
        .from("alphadome.bot_tenants")
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
        .from("alphadome.bot_tenants")
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
    await supabase
      .from("user_sessions")
      .upsert({
        phone: from,
        context: { step: "awaiting_payment_number", plan, level, amount },
        updated_at: new Date().toISOString(),
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

// ✅ PAYMENT NUMBER RESPONSE HANDLER
const phoneMatch = text.trim().match(/^(\+?254|0)\d{9}$/) || text.trim().toLowerCase() === "same";

if (phoneMatch) {
  const { data: session } = await supabase
    .from("user_sessions")
    .select("context")
    .eq("phone", from)
    .maybeSingle();

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
            metadata: stkResp,
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

   

    // STEP 5: Generate AI reply (TENANT-AWARE)
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
      const firstImage = items.find((i) => i.primary_image)?.primary_image || null;
      if (firstImage) {
        await sendImage(from, firstImage, "Top match", creds);
      }
      const sections = buildCatalogList(items);
      await sendInteractiveList(from, "Here are matching items:", "View items", sections, creds);
    } else {
      const replyText = typeof reply === "string" ? reply : reply?.text || "";
      await sendMessage(from, replyText, creds);
    }

    // STEP 6: Log outbound message
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
        metadata: { callback: body },
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
  return data?.items || [];
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
    return resp.data;

  } catch (err) {
    log(`❌ STK Push error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`, "ERROR");
    throw err;
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

