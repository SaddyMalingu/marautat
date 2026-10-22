#!/usr/bin/env node

/**
 * Offline test for the AI provider fallback chain in scripts/blogManager.js.
 *
 * Production failure this protects against (2026-10-22): HuggingFace answered
 * 402 "You have no remaining credits" for every angle, so Writer's Flow
 * generated nothing while the key looked healthy (`hf=true` in the boot log).
 * The chain must therefore (a) try other providers when one is exhausted,
 * (b) report the provider status + body instead of a vague message.
 *
 * Runs entirely against a local stub HTTP server — no keys, no network.
 *
 * Usage: npm run test:ai-providers
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import http from "http";
import chalk from "chalk";

const logInfo = (msg) => console.log(chalk.blue(`i ${msg}`));
const logPass = (msg) => console.log(chalk.green(`+ ${msg}`));
const logFail = (msg) => console.log(chalk.red(`x ${msg}`));

const results = [];
function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const line = `${name}${detail ? " — " + detail : ""}`;
  if (status === "PASS") logPass(line);
  else logFail(line);
}

// ---------------------------------------------------------------------------
// Stub provider: behaviour per provider is flipped by each test.
// ---------------------------------------------------------------------------
const behavior = { or: "ok", gem: "ok", oa: "ok", hf: "ok" };
const seen = {};
// Model slugs the stub pretends OpenRouter has retired (404 "unavailable for free").
const retired = new Set();

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const provider = req.url.split("/")[1] || "";
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen[provider] = { auth: req.headers.authorization, body };
    const mode = behavior[provider] || "ok";
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (mode === "402") {
      return send(402, {
        error: "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.",
      });
    }
    if (retired.has(body.model)) {
      return send(404, {
        error: { message: "This model is unavailable for free. The paid version is available now.", code: 404 },
      });
    }
    if (mode === "429") {
      // Shape of Gemini's free-tier quota response: a 429 whose body mentions
      // "quota" and "billing" — it must NOT be mistaken for a billing failure.
      return send(429, {
        error: {
          code: 429,
          message: "You exceeded your current quota, please check your plan and billing details.",
          status: "RESOURCE_EXHAUSTED",
        },
      });
    }
    if (mode === "500") return send(500, { error: "upstream boom" });
    if (mode === "empty") return send(200, { choices: [] });
    return send(200, { choices: [{ message: { content: provider.toUpperCase() + " OK" } }] });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Environment: dummy Supabase creds so the module import succeeds, all AI
// endpoints pointed at the stub.
// ---------------------------------------------------------------------------
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.OPENROUTER_BASE_URL = base + "/or";
process.env.GEMINI_BASE_URL = base + "/gem";
process.env.OPENAI_BASE_URL = base + "/oa";
process.env.HF_BASE_URL = base + "/hf";
delete process.env.OPENROUTER_MODEL;
delete process.env.GEMINI_MODEL;
delete process.env.OPENAI_MODEL;
delete process.env.HF_MODEL;

function setKeys({ or, gem, oa, hf } = {}) {
  if (or) process.env.OPENROUTER_API_KEY = or; else delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_KEY;
  if (gem) process.env.GEMINI_API_KEY = gem; else delete process.env.GEMINI_API_KEY;
  if (oa) process.env.OPENAI_API_KEY = oa; else delete process.env.OPENAI_API_KEY;
  if (hf) process.env.HF_API_KEY = hf; else delete process.env.HF_API_KEY;
  delete process.env.HF_API_KEY_WRITERS_FLOW;
}

function resetStub() {
  behavior.or = "ok";
  behavior.gem = "ok";
  behavior.oa = "ok";
  behavior.hf = "ok";
  retired.clear();
  for (const k of Object.keys(seen)) delete seen[k];
}

const { ai, getLastAiError, isAiFailureFatal, OPENROUTER_FREE_MODELS } = await import("./blogManager.js");

const PROMPT = "Write a short post about a salary guide.";

async function check(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail || "");
  } catch (e) {
    record("FAIL", name, e.message);
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

logInfo(`Stub AI provider on ${base}`);

await check("hf 402 is reported with status and body", async () => {
  resetStub();
  setKeys({ hf: "hf-key" });
  behavior.hf = "402";
  const out = await ai(PROMPT);
  const err = getLastAiError() || "";
  assert(out === null, `expected null content, got ${JSON.stringify(out)}`);
  assert(/hf 402/.test(err), `error should name provider+status, got: ${err}`);
  assert(/credits/i.test(err), `error should include provider body, got: ${err}`);
  return err.slice(0, 90) + "…";
});

await check("openrouter serves content when healthy", async () => {
  resetStub();
  setKeys({ or: "or-key", hf: "hf-key" });
  const out = await ai(PROMPT);
  assert(out === "OR OK", `expected OR OK, got ${JSON.stringify(out)}`);
  assert(getLastAiError() === null, `lastAiError should be cleared, got ${getLastAiError()}`);
  assert(!seen.hf, "hf must not be called when openrouter succeeds");
  return "openrouter preferred, hf untouched";
});

await check("falls back when openrouter fails 500", async () => {
  resetStub();
  setKeys({ or: "or-key", hf: "hf-key" });
  behavior.or = "500";
  const out = await ai(PROMPT);
  assert(out === "HF OK", `expected HF OK, got ${JSON.stringify(out)}`);
  assert(seen.hf, "expected a call to hf after openrouter failed");
  return "500 -> next provider";
});

await check("falls back when a provider returns empty content", async () => {
  resetStub();
  setKeys({ or: "or-key", hf: "hf-key" });
  behavior.or = "empty";
  const out = await ai(PROMPT);
  assert(out === "HF OK", `expected HF OK, got ${JSON.stringify(out)}`);
  return "empty 200 is not treated as success";
});

await check("gemini recovers the run when paid providers are out of credits", async () => {
  resetStub();
  setKeys({ or: "or-key", gem: "gem-key", hf: "hf-key" });
  behavior.or = "402";
  behavior.hf = "402";
  const out = await ai(PROMPT);
  assert(out === "GEM OK", `expected GEM OK, got ${JSON.stringify(out)}`);
  assert(getLastAiError() === null, `lastAiError should be cleared, got ${getLastAiError()}`);
  assert(seen.gem && seen.gem.auth === "Bearer gem-key", "gemini call missing or bad bearer token");
  assert(seen.gem.body.model === "gemini-flash-latest", `unexpected default model: ${seen.gem.body.model}`);
  return "402 x2 -> gemini (free tier) served content";
});

await check("no keys configured is self-describing", async () => {
  resetStub();
  setKeys({});
  const out = await ai(PROMPT);
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(/OPENROUTER_API_KEY/.test(err) && /GEMINI_API_KEY/.test(err) && /HF_API_KEY/.test(err), `unhelpful error: ${err}`);
  return err.slice(0, 90) + "…";
});

await check("request carries model, messages and bearer token", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  await ai(PROMPT);
  const req = seen.or || {};
  assert(req.auth === "Bearer or-key", `bad auth header: ${req.auth}`);
  assert(Array.isArray(req.body.messages) && req.body.messages[0].content === PROMPT, "messages not forwarded");
  assert(typeof req.body.model === "string" && req.body.model.length > 0, "model missing from body");
  assert(req.body.max_tokens === 3000, `max_tokens should be 3000, got ${req.body.max_tokens}`);
  return `model=${req.body.model}`;
});

await check("OPENROUTER_MODEL overrides the default model", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  process.env.OPENROUTER_MODEL = "custom/model-id";
  await ai(PROMPT);
  delete process.env.OPENROUTER_MODEL;
  assert(seen.or.body.model === "custom/model-id", `got ${seen.or.body.model}`);
  return "custom/model-id";
});

await check("OPENROUTER_KEY alias is accepted for the same credential", async () => {
  resetStub();
  setKeys({});
  process.env.OPENROUTER_KEY = "alias-key";
  const out = await ai(PROMPT);
  delete process.env.OPENROUTER_KEY;
  assert(out === "OR OK", `expected OR OK, got ${JSON.stringify(out)}`);
  assert(seen.or && seen.or.auth === "Bearer alias-key", "alias key not forwarded");
  return "OPENROUTER_KEY -> openrouter";
});

// Regression (2026-10-22, live): HF kept answering 402 while OpenRouter/Gemini
// worked. The journey fail-fast tested the joined error string, saw "402", and
// aborted after the first post — 1 post written instead of 9.
await check("one exhausted provider does not abort the journey", async () => {
  resetStub();
  setKeys({ or: "or-key", hf: "hf-key" });
  behavior.or = "500";
  behavior.hf = "402";
  const out = await ai(PROMPT);
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(/hf 402/.test(err), `error should still name the 402 provider, got: ${err}`);
  assert(isAiFailureFatal() === false, "a lone 402 next to other providers must not abort the journey");
  return "hf 402 + or 500 -> keep going";
});

await check("every provider out of credits is fatal", async () => {
  resetStub();
  setKeys({ or: "or-key", gem: "gem-key", hf: "hf-key" });
  behavior.or = "402";
  behavior.gem = "402";
  behavior.hf = "402";
  const out = await ai(PROMPT);
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(isAiFailureFatal() === true, "all-providers-402 must abort the journey");
  return "402 x3 -> fatal";
});

await check("free-tier 429 quota is transient, not fatal", async () => {
  resetStub();
  setKeys({ or: "or-key", gem: "gem-key" });
  behavior.or = "429";
  behavior.gem = "429";
  const out = await ai(PROMPT);
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(/429/.test(err), `error should surface the 429, got: ${err}`);
  assert(isAiFailureFatal() === false, `429/quota must not be treated as billing failure: ${err}`);
  return "429 RESOURCE_EXHAUSTED -> retry later";
});

await check("a retired free model falls through to the next candidate", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  retired.add(OPENROUTER_FREE_MODELS[0]);
  const out = await ai(PROMPT);
  assert(out === "OR OK", `expected OR OK, got ${JSON.stringify(out)}`);
  assert(
    seen.or && seen.or.body.model === OPENROUTER_FREE_MODELS[1],
    `expected fallback to ${OPENROUTER_FREE_MODELS[1]}, got ${seen.or && seen.or.body.model}`
  );
  return `${OPENROUTER_FREE_MODELS[0]} gone -> ${OPENROUTER_FREE_MODELS[1]}`;
});

server.close();

const failed = results.filter((r) => r.status === "FAIL").length;
console.log("");
if (failed) {
  console.log(chalk.red(`Summary: ${failed} failed, ${results.length - failed} passed`));
  process.exit(1);
}
console.log(chalk.green(`Summary: ${results.length} passed, 0 failed`));
process.exit(0);
