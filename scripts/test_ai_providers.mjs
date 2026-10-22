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
// Every request the stub received, in order — lets a test prove which slugs were
// *not* tried (retired ones, or a provider whose time box was already spent).
const calls = [];
// Model slugs the stub pretends OpenRouter has retired (404 "unavailable for free").
const retired = new Set();
// Model slugs whose upstream is throttled (429 "temporarily rate-limited upstream").
const throttled = new Set();

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const provider = req.url.split("/")[1] || "";
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen[provider] = { auth: req.headers.authorization, body };
    calls.push({ provider, model: body.model || null });
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
    // Shape of OpenRouter's upstream throttle (live 2026-10-22): the key and the
    // slug are both valid, the provider behind that one model is saturated.
    if (throttled.has(body.model)) {
      return send(429, {
        error: {
          code: 429,
          message: `${body.model} is temporarily rate-limited upstream. Please retry shortly, or add your own key.`,
        },
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
    if (mode === "slow") {
      // A trickling upstream, not a silent one: headers arrive at once and one byte
      // every 250ms, so a socket-inactivity timeout never fires — only the client's
      // own deadline can cut this. Live 2026-10-22 13:55 that exact shape let
      // openrouter/free hold a 90s run open for 109s.
      res.writeHead(200, { "Content-Type": "application/json" });
      let sent = 0;
      const tick = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(tick); return; }
        try { res.write(" "); } catch { clearInterval(tick); return; }
        if (++sent >= 20) { clearInterval(tick); try { res.end(""); } catch { /* client gone */ } }
      }, 250);
      return;
    }
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
  throttled.clear();
  calls.length = 0;
  // Retired slugs live on the module (per process), so a case that proves a 404
  // is remembered must start from a clean set.
  resetRetiredModels();
  for (const k of Object.keys(seen)) delete seen[k];
}

const { ai, getLastAiError, isAiFailureFatal, OPENROUTER_FREE_MODELS, resetRetiredModels } = await import("./blogManager.js");

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

await check("OPENROUTER_MODEL leads the model list without hiding the free fallbacks", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  process.env.OPENROUTER_MODEL = "custom/model-id";
  await ai(PROMPT);
  delete process.env.OPENROUTER_MODEL;
  assert(seen.or.body.model === "custom/model-id", `got ${seen.or.body.model}`);
  return "custom/model-id tried first";
});

// Regression (2026-10-22, live): the host pinned OPENROUTER_MODEL to a retired
// free slug, so a healthy OpenRouter account answered 404 on every angle while
// three working free models were configured. The pin must not starve the list.
await check("a retired pinned model still falls through to the free list", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  process.env.OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct:free";
  retired.add(process.env.OPENROUTER_MODEL);
  const out = await ai(PROMPT);
  delete process.env.OPENROUTER_MODEL;
  assert(out === "OR OK", `expected OR OK, got ${JSON.stringify(out)}`);
  assert(
    seen.or && seen.or.body.model === OPENROUTER_FREE_MODELS[0],
    `expected fallback to ${OPENROUTER_FREE_MODELS[0]}, got ${seen.or && seen.or.body.model}`
  );
  return `pinned slug 404 -> ${OPENROUTER_FREE_MODELS[0]}`;
});

await check("empty content from one model advances to the next model", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  behavior.or = "empty";
  const out = await ai(PROMPT);
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  const err = getLastAiError() || "";
  assert(
    err.includes(OPENROUTER_FREE_MODELS[OPENROUTER_FREE_MODELS.length - 1]),
    `every model should have been tried, last error: ${err}`
  );
  return "empty 200 tries the whole list";
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

// Regression (2026-10-22, live, second wave): once the retired pin was fixed the
// host still wrote 0 of 9 posts because gemma-4-31b:free answered 429
// "temporarily rate-limited upstream" and a 429 aborted the whole OpenRouter
// provider — the three healthy free models were never tried.
await check("a throttled free model falls through instead of losing the provider", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  throttled.add(OPENROUTER_FREE_MODELS[0]);
  const out = await ai(PROMPT);
  assert(out === "OR OK", `expected OR OK, got ${JSON.stringify(out)}`);
  assert(
    seen.or && seen.or.body.model === OPENROUTER_FREE_MODELS[1],
    `expected fallback to ${OPENROUTER_FREE_MODELS[1]}, got ${seen.or && seen.or.body.model}`
  );
  assert(getLastAiError() === null, `a recovered call must clear lastAiError, got ${getLastAiError()}`);
  return `${OPENROUTER_FREE_MODELS[0]} 429 -> ${OPENROUTER_FREE_MODELS[1]}`;
});

// The 429 fallthrough must not mask a real auth failure: a 402 means the account
// is out of credits, so paying for the other six slugs is pointless.
await check("402 still stops the model list immediately", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  behavior.or = "402";
  const out = await ai(PROMPT);
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(/openrouter 402/.test(err), `error should name the 402, got: ${err}`);
  assert(isAiFailureFatal() === true, "a lone 402 provider is a billing failure");
  return "402 -> provider abandoned, no slug burn";
});

// The run budget only works if an expired deadline is honoured *without* a
// network round trip: that is what makes the tail of a journey free once
// BLOG_RUN_BUDGET_MS is spent. Live 2026-10-22 a run held the tenant's request
// for 166s and composed 8 of 9 pages locally anyway, so the waiting bought
// nothing. Nine skipped angles must also stay non-fatal, or the journey would
// abort on the budget instead of composing the remaining pages.
await check("an expired deadline skips every provider without a request", async () => {
  resetStub();
  setKeys({ or: "or-key", gem: "gem-key", hf: "hf-key" });
  const started = Date.now();
  const out = await ai(PROMPT, Date.now() - 1);
  const elapsed = Date.now() - started;
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(elapsed < 500, `expected no network wait, took ${elapsed}ms`);
  assert(!seen.or && !seen.gem && !seen.hf, "no provider should have been called");
  assert(/run budget spent/.test(err), `error should say the budget is spent, got: ${err}`);
  assert(isAiFailureFatal() === false, `a spent budget must not abort the journey: ${err}`);
  return `${elapsed}ms, zero requests, not fatal`;
});

// Live 2026-10-22 13:55: a 90s run returned in 108s because the openrouter/free
// attempt started with 12.8s of budget left and answered 30.7s later. Clamping
// the axios `timeout` was not enough — in Node that is a socket-inactivity
// timeout, so a provider that trickles its body keeps the value unreached. The
// AbortController must cut the call at the deadline, mid-response.
await check("a slow provider is cut at the deadline, not at its own pace", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  behavior.or = "slow";
  const started = Date.now();
  const out = await ai(PROMPT, Date.now() + 1500);
  const elapsed = Date.now() - started;
  const err = getLastAiError() || "";
  assert(out === null, `expected null, got ${JSON.stringify(out)}`);
  assert(elapsed < 3000, `expected an abort at ~1.5s, waited ${elapsed}ms`);
  assert(/aborted after [\d.]+s/.test(err), `error should say it was aborted, got: ${err}`);
  assert(isAiFailureFatal() === false, `an aborted call must stay transient: ${err}`);
  return `${elapsed}ms against a 1500ms budget (provider needed 5000ms)`;
});

// Live 2026-10-22 18:03 (90s run, 45s angle budget): OpenRouter answered 429/404
// in a few seconds, stalled 30s on the `openrouter/free` router, and left Gemini
// 6.3s (cut mid-call) and HF nothing at all. The tier then reported "dry" and all
// nine pages were composed from the offer data. The deadline has to be shared:
// a provider that has never answered must not be able to spend another
// provider's share of it.
await check("a stalled provider cannot spend the next provider's share", async () => {
  resetStub();
  setKeys({ or: "or-key", gem: "gem-key" });
  behavior.or = "slow";
  const started = Date.now();
  const out = await ai(PROMPT, Date.now() + 3000);
  const elapsed = Date.now() - started;
  assert(out === "GEM OK", `expected the next provider to serve, got ${JSON.stringify(out)} (${elapsed}ms)`);
  assert(seen.gem, "gemini was never called — its share was eaten by openrouter");
  assert(elapsed < 2800, `expected ~half the 3s deadline to be enough, waited ${elapsed}ms`);
  return `openrouter cut at ~1.5s, gemini served, ${elapsed}ms of a 3000ms deadline`;
});

// A retired slug costs a round-trip per angle, and a run is nine angles: the
// same 404 was paid nine times before this. Live 2026-10-22 18:03
// `minimax/minimax-m3.1-flash:free` 404'd on the first walk of the run.
await check("a 404 slug is probed once per process, not once per angle", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  const gone = OPENROUTER_FREE_MODELS[1];
  // Force the walk past the first slug so it actually reaches the retired one:
  // throttled [0] -> retired [1] (404) -> [2] serves.
  throttled.add(OPENROUTER_FREE_MODELS[0]);
  retired.add(gone);
  const first = await ai(PROMPT);
  const second = await ai(PROMPT);
  assert(first === "OR OK" && second === "OR OK", `expected both angles to be served, got ${first}/${second}`);
  assert(
    seen.or && seen.or.body.model === OPENROUTER_FREE_MODELS[2],
    `expected the walk to land on ${OPENROUTER_FREE_MODELS[2]}, got ${seen.or && seen.or.body.model}`
  );
  const probes = calls.filter((c) => c.model === gone).length;
  assert(probes === 1, `expected 1 probe of the retired slug across two angles, got ${probes}`);
  return `${gone} probed ${probes}x across two angles`;
});

// The router slug is the one candidate with no upstream latency promise, and it
// is the one that twice held an attempt open for the full timeout. It now gets a
// short box of its own even when the surrounding deadline is generous.
await check("the last-resort router slug is time-boxed", async () => {
  resetStub();
  setKeys({ or: "or-key" });
  process.env.BLOG_ROUTER_MODEL_CAP_MS = "600";
  try {
    const router = OPENROUTER_FREE_MODELS[OPENROUTER_FREE_MODELS.length - 1];
    for (const slug of OPENROUTER_FREE_MODELS) if (slug !== router) retired.add(slug);
    behavior.or = "slow";
    const started = Date.now();
    const out = await ai(PROMPT, Date.now() + 3000);
    const elapsed = Date.now() - started;
    const err = getLastAiError() || "";
    assert(out === null, `expected null, got ${JSON.stringify(out)}`);
    assert(err.includes(router), `error should name the router slug, got: ${err}`);
    assert(elapsed < 1500, `expected the 600ms cap to cut it, waited ${elapsed}ms`);
    return `${router} cut at ${elapsed}ms against a 3000ms deadline`;
  } finally {
    delete process.env.BLOG_ROUTER_MODEL_CAP_MS;
  }
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
