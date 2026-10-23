import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// Log LLM env presence at startup (no secrets). The names here must match the
// ones the writers actually read (scripts/blogManager.js), otherwise the boot
// log advertises a key that generation cannot see — how the 2026-10-22 outage
// stayed hidden behind `hf=true`.
try {
  const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || process.env.OPEN_ROUTER_API_KEY;
  const hfKey = process.env.HF_API_KEY || process.env.HF_API_KEY_WRITERS_FLOW;
  const groqKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
  const mistralKey = process.env.MISTRAL_API_KEY || process.env.MISTRALAI_API_KEY;
  const envLog = `[${new Date().toISOString()}] [SYSTEM] ENV LLM keys: openai=${Boolean(process.env.OPENAI_API_KEY)} openrouter=${Boolean(openrouterKey)} gemini=${Boolean(process.env.GEMINI_API_KEY)} groq=${Boolean(groqKey)} cerebras=${Boolean(process.env.CEREBRAS_API_KEY)} mistral=${Boolean(mistralKey)} hf=${Boolean(hfKey)}`;
  console.log(envLog);
} catch (err) {
  console.log(`[${new Date().toISOString()}] [WARN] ENV LLM keys log failed: ${err?.message || err}`);
}

function createFallbackSupabase() {
  const fallbackResult = { data: [], error: null };
  const builder = {
    from() { return builder; },
    select() { return builder; },
    insert() { return builder; },
    update() { return builder; },
    upsert() { return builder; },
    delete() { return builder; },
    rpc() { return Promise.resolve(fallbackResult); },
    eq() { return builder; },
    neq() { return builder; },
    gt() { return builder; },
    gte() { return builder; },
    lt() { return builder; },
    lte() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    maybeSingle() { return Promise.resolve(fallbackResult); },
    single() { return Promise.resolve(fallbackResult); },
    in() { return builder; },
    contains() { return builder; },
    filter() { return builder; },
    or() { return builder; },
    not() { return builder; },
    ilike() { return builder; },
    like() { return builder; },
    is() { return builder; },
    isNot() { return builder; },
    then(onFulfilled, onRejected) {
      return Promise.resolve(fallbackResult).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(fallbackResult).catch(onRejected);
    },
    finally(onFinally) {
      return Promise.resolve(fallbackResult).finally(onFinally);
    },
  };

  return builder;
}

// === Initialize Supabase client ===
const hasSupabaseConfig = Boolean(process.env.SB_URL && process.env.SB_SERVICE_ROLE_KEY);
const supabase = hasSupabaseConfig
  ? createClient(process.env.SB_URL, process.env.SB_SERVICE_ROLE_KEY)
  : createFallbackSupabase();

if (!hasSupabaseConfig) {
  console.warn("[LOGGER] SB_URL/SB_SERVICE_ROLE_KEY not configured; running in local-safe fallback mode.");
}

// === Local log directory setup ===
const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "bot.log");

// === Auto-rotate if file > 1MB ===
function rotateIfNeeded() {
  try {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 1024 * 1024) {
        const backupName = `bot_${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
        fs.renameSync(logFile, path.join(logDir, backupName));
        fs.writeFileSync(logFile, ""); // start fresh
      }
    }
  } catch (err) {
    console.error("[LOGGER ROTATION ERROR]", err?.message || err);
  }
}

// === Unified logger (console + file + Supabase) ===
export function log(message, type = "INFO") {
  rotateIfNeeded();

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type}] ${message}\n`;

  // Print to console
  console.log(logEntry.trim());

  // Save to local file
  try {
    fs.appendFileSync(logFile, logEntry);
  } catch (err) {
    console.error("[LOGGER FILE ERROR]", err?.message || err);
  }

  // Save to Supabase (non-blocking)
  supabase
    .from("logs")
    .insert([
      {
        message,
        level: type,
        source: "BOT",
        created_at: new Date().toISOString(),
      },
    ])
    .then(({ error }) => {
      if (error) console.error("[LOGGER DB ERROR]", error.message);
    });
}
