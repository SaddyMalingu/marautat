#!/usr/bin/env node

/**
 * Writer's Flow end-to-end verifier (tenant-scoped Blogger).
 *
 * Exercises the live deployment through the real HTTP surface and reports
 * PASS / FAIL / WARN per check. It covers the regressions that already bit us:
 *
 *   1) build identity        — is the deployed bundle actually the latest code?
 *   2) route registration    — /tenant/blogger must be 401 (auth), not 404
 *   3) login                 — tenant session token
 *   4) context               — site, publicPath, categories, offers
 *   5) offer create          — draft row scoped to the tenant
 *   6) slug collision        — same title twice must yield two distinct slugs
 *   7) publish               — status flips to published
 *   8) blog generation       — must never return 200 with zero posts
 *   8a) double click         — a second concurrent run on the same offer is 409 busy
 *   8b) blog coverage        — WARN when fewer than every angle produced a post
 *   8c) bounded run          — the journey returns inside its wall-clock ceiling
 *   8d) offer pages          — the generated pages are listed for the offer and serve
 *   9) public page           — /ai-jobs/t/<slug> (needs AI_JOBS_MULTITENANT)
 *  10) cleanup               — test rows removed, offer count restored to baseline
 *  10b) blog cleanup         — generated verify-writers-flow-* posts removed
 *
 * Usage:
 *   BASE_URL=https://alphadome.onrender.com \
 *   TENANT_TEST_PHONE=2547... TENANT_DASHBOARD_PASS=... \
 *   node scripts/verify_writers_flow.js
 *
 * Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = missing config.
 * Test rows are always deleted, including when a check throws.
 */

import axios from "axios";
import chalk from "chalk";
import dotenv from "dotenv";
import { getAllTemplates } from "../utils/contentJourney.js";

dotenv.config();

// The writer walks one content angle per post, so a healthy run writes this many.
const EXPECTED_ANGLES = getAllTemplates().length;

// Hard wall-clock ceiling for one generation call, as observed by the client.
// The server bounds itself with BLOG_RUN_BUDGET_MS (90s default) and then writes
// the remaining angles from the offer data, so 90s plus DB writes and the
// response body should land well under this. It is deliberately looser than the
// budget: it catches a regression to an unbounded walk (live 2026-10-22 a run
// took 166s because the deadline was only applied after a miss), not jitter.
const RUN_CEILING_MS = 120000;

const BASE_URL = (process.env.BASE_URL || "https://alphadome.onrender.com").replace(/\/+$/, "");
const TENANT_PHONE = process.env.TENANT_TEST_PHONE || process.env.TENANT_PHONE || "";
const DASHBOARD_PASS = process.env.TENANT_DASHBOARD_PASS || process.env.ADMIN_PASS || "";

const logInfo = (msg) => console.log(chalk.blue(`i ${msg}`));
const logPass = (msg) => console.log(chalk.green(`+ ${msg}`));
const logFail = (msg) => console.log(chalk.red(`x ${msg}`));
const logWarn = (msg) => console.log(chalk.yellow(`! ${msg}`));

const results = [];
function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const line = `${name}${detail ? " — " + detail : ""}`;
  if (status === "PASS") logPass(line);
  else if (status === "WARN") logWarn(line);
  else logFail(line);
}
const pass = (n, d) => record("PASS", n, d);
const fail = (n, d) => record("FAIL", n, d);
const warn = (n, d) => record("WARN", n, d);

const http = axios.create({ baseURL: BASE_URL, timeout: 30000, validateStatus: () => true });

const createdIds = [];
const createdSlugs = [];
let token = "";
const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {});

async function createOffer(title, extra = {}) {
  const r = await http.post("/tenant/blogger/offers",
    { title, offer_type: "service", price: "1500", currency: "KES", ...extra },
    { headers: authHeaders() });
  const id = r.data?.offer?.id;
  if (id) createdIds.push(id);
  return r;
}

async function cleanup() {
  if (!token) return;
  if (createdIds.length) {
    let deleted = 0;
    for (const id of createdIds) {
      const r = await axios.delete(`${BASE_URL}/tenant/blogger/offers/${id}`,
        { headers: authHeaders(), validateStatus: () => true, timeout: 30000 }).catch(() => ({ status: 0 }));
      if (r.status === 200) deleted++;
    }
    if (deleted === createdIds.length) pass("cleanup", `${deleted} test offer(s) deleted`);
    else fail("cleanup", `${deleted}/${createdIds.length} test offers deleted — check manually`);
  }
  // Generated posts are published to the real blog, so a verifier run must not
  // leave "verify-writers-flow-…" pages behind for a prospect to find.
  if (createdSlugs.length) {
    let removed = 0;
    for (const slug of createdSlugs) {
      const r = await axios.delete(`${BASE_URL}/tenant/blogger/posts/${encodeURIComponent(slug)}`,
        { headers: authHeaders(), validateStatus: () => true, timeout: 30000 }).catch(() => ({ status: 0 }));
      if (r.status === 200) removed++;
    }
    if (removed === createdSlugs.length) pass("blog cleanup", `${removed} test post(s) removed from the public blog`);
    else warn("blog cleanup", `${removed}/${createdSlugs.length} posts removed — 403 means the row has no tenant_id; run node scripts/prune_verify_posts.js on the host`);
  }
}


async function main() {
  if (!TENANT_PHONE || !DASHBOARD_PASS) {
    console.error("Missing TENANT_TEST_PHONE / TENANT_DASHBOARD_PASS. Set them and re-run.");
    process.exit(2);
  }

  logInfo(`Target: ${BASE_URL}`);

  // 1) Build identity — the SPA shell ships with the server bundle, so its
  // markers reveal which commit is actually serving traffic.
  const spa = await http.get("/tenant-dashboard" + (DASHBOARD_PASS ? `?key=${encodeURIComponent(DASHBOARD_PASS)}` : ""));
  if (spa.status === 200 && typeof spa.data === "string") {
    // The per-offer page list is the marker for this build: before it, the only
    // trace of a run in the portal was a toast, so a tenant could not open any
    // page it had generated.
    const hasNew = spa.data.includes('data-act="posts"');
    const hasOld = spa.data.includes("Blog generated (");
    if (hasNew) pass("build identity", "serving build with per-offer page list (Optimize)");
    else if (hasOld) fail("build identity", "serving a build without the offer page list (host has not deployed latest commit)");
    else warn("build identity", "no page-list marker found — dashboard markup changed");
  } else {
    warn("build identity", `dashboard returned ${spa.status}; cannot identify build`);
  }

  // 2) Route registration — 401 proves the route exists and is auth-gated;
  // 404 means the route is absent. The bogus control must stay 404.
  for (const [method, path] of [["get", "/tenant/blogger"], ["post", "/tenant/blogger/offers"], ["get", "/tenant/blogger/offers/deploy-probe/posts"], ["delete", "/tenant/blogger/posts/deploy-probe"]]) {
    const r = await http[method](path, {});
    if (r.status === 401) pass(`route ${method.toUpperCase()} ${path}`, "401 auth-gated");
    else if (r.status === 404) fail(`route ${method.toUpperCase()} ${path}`, "404 — route not registered on this build");
    else fail(`route ${method.toUpperCase()} ${path}`, `unexpected ${r.status}`);
  }
  const control = await http.get("/tenant/bloggerzzz");
  if (control.status === 404) pass("route control", "/tenant/bloggerzzz → 404 (proves the 401s above are real)");
  else warn("route control", `/tenant/bloggerzzz → ${control.status} (expected 404)`);

  // 3) Login
  const login = await http.post("/tenant/session/login", { tenant_phone: TENANT_PHONE, key: DASHBOARD_PASS });
  token = login.data?.token || "";
  if (token) pass("login", `token issued for ${TENANT_PHONE}`);
  else {
    fail("login", `${login.status} ${JSON.stringify(login.data)?.slice(0, 160)}`);
    return;
  }

  // 4) Context
  const ctx = await http.get("/tenant/blogger", { headers: authHeaders() });
  const site = ctx.data?.site;
  const publicPath = ctx.data?.publicPath;
  const baselineOffers = Array.isArray(ctx.data?.offers) ? ctx.data.offers.length : -1;
  if (ctx.status === 200 && site?.slug && publicPath) {
    pass("context", `${site.name} (slug=${site.slug}), ${ctx.data.categories?.length ?? 0} categories, ${baselineOffers} offers`);
  } else {
    fail("context", `${ctx.status} ${JSON.stringify(ctx.data)?.slice(0, 200)}`);
    return;
  }

  // 5) Create
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const title = `verify-writers-flow-${stamp}`;
  const c1 = await createOffer(title);
  const offerA = c1.data?.offer;
  if (c1.status === 200 && offerA?.id) pass("offer create", `${offerA.id} slug=${offerA.slug}`);
  else {
    fail("offer create", `${c1.status} ${JSON.stringify(c1.data)?.slice(0, 200)}`);
    return;
  }

  // 6) Slug collision — opportunities.slug is globally UNIQUE, so a duplicate
  // title used to crash the second create.
  const options = await createOffer(title);
  const slugB = options.data?.offer?.slug;
  if (options.status === 200 && slugB && slugB !== offerA.slug) pass("slug collision", `${offerA.slug} → ${slugB}`);
  else fail("slug collision", `${options.status} slug=${slugB} (first=${offerA.slug})`);

  // 7) Publish
  const pub = await http.post(`/tenant/blogger/offers/${offerA.id}/publish`, {}, { headers: authHeaders() });
  const afterPub = await http.get("/tenant/blogger", { headers: authHeaders() });
  const rowA = (afterPub.data?.offers || []).find((o) => o.id === offerA.id);
  if (pub.status === 200 && rowA?.status === "published") pass("publish", "status=published");
  else fail("publish", `POST ${pub.status}, status=${rowA?.status}`);

  // 8) Blog generation — the core contract: never 200 with zero posts.
  // Free-tier models answer in 20-40s each and a journey is 9 angles plus a
  // review pass per post, so allow ten minutes: a 180s cap reports a timeout for
  // a run that is still making progress. The server bounds itself well before
  // that (8c asserts it), so the timeout only matters if the bound regresses.
  const startedAt = Date.now();
  const blogPromise = http.post(`/tenant/blogger/offers/${offerA.id}/blog`, {}, { headers: authHeaders(), timeout: 600000 });
  // 8a) Double click. Fire a second run at the same offer while the first is
  // still walking and require an immediate 409 instead of a competing walk: live
  // 2026-10-22 two walks on one offer shared the free tier, rate-limited each
  // other and both stalled for minutes. Probing mid-run costs no extra time.
  await new Promise((r) => setTimeout(r, 1500));
  const dupeStart = Date.now();
  const dupe = await http.post(`/tenant/blogger/offers/${offerA.id}/blog`, {}, { headers: authHeaders(), timeout: 30000 });
  const dupeMs = Date.now() - dupeStart;
  if (dupe.status === 409 && dupe.data?.busy === true) {
    pass("double click", `409 busy in ${dupeMs}ms while the first run was live`);
  } else {
    fail("double click", `${dupe.status} ${JSON.stringify(dupe.data)?.slice(0, 160)} — a second concurrent run must be 409 busy:true`);
  }
  const blog = await blogPromise;
  const wallMs = Date.now() - startedAt;
  const posts = blog.data?.result?.posts;
  if (Array.isArray(posts)) {
    for (const p of posts) if (p?.slug) createdSlugs.push(p.slug);
  }
  if (blog.status === 200 && Array.isArray(posts) && posts.length > 0) {
    const mode = blog.data?.result?.mode;
    pass("blog generation", `${posts.length} post(s) written, e.g. ${posts[0]?.slug}${mode ? ` (mode=${mode})` : ""} in ${(wallMs / 1000).toFixed(1)}s`);
    // Coverage is about pages a visitor can open, not array entries: two
    // templates per angle shared one slug until 2026-10-22, so "9 of 9" could be
    // five real pages with later posts overwriting earlier ones.
    const uniqueSlugs = new Set(posts.map((p) => p?.slug).filter(Boolean));
    const composed = posts.filter((p) => p?.fallback).length;
    if (posts.length < EXPECTED_ANGLES) {
      const skipped = Array.isArray(blog.data?.result?.skipped) ? blog.data.result.skipped : [];
      const why = skipped[0]?.error ? ` — first skip: ${String(skipped[0].error).slice(0, 160)}` : "";
      warn("blog coverage", `${posts.length}/${EXPECTED_ANGLES} angles produced a post${why}`);
    } else if (uniqueSlugs.size < posts.length) {
      warn("blog coverage", `${posts.length} posts share only ${uniqueSlugs.size} slug(s) — later angles overwrote earlier pages`);
    } else {
      pass("blog coverage", `${uniqueSlugs.size}/${EXPECTED_ANGLES} unique pages${composed ? ` (${composed} composed from offer data — AI tier unavailable)` : " (all AI-written)"}`);
    }
  } else if (blog.status === 200 && Array.isArray(posts) && posts.length === 0) {
    fail("blog generation", "200 with 0 posts — false success (pre-fix behaviour)");
  } else if (blog.status === 502) {
    warn("blog generation", `failing loudly as designed: ${blog.data?.error || "no detail"}`);
    warn("blog root cause", "AI writer returned nothing for every angle and BLOG_FALLBACK_MODE=off — unset it to compose posts from the offer data, or check GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / HF_API_KEY");
  } else {
    fail("blog generation", `${blog.status} ${JSON.stringify(blog.data)?.slice(0, 200)}`);
  }

  // 8c) The ceiling is a contract, not a hope: a tenant clicking Generate must
  // get an answer inside the budget, with the remaining angles composed from the
  // offer data rather than holding the request open for another minute.
  if (wallMs <= RUN_CEILING_MS) {
    pass("bounded run", `${(wallMs / 1000).toFixed(1)}s, inside the ${RUN_CEILING_MS / 1000}s ceiling`);
  } else {
    fail("bounded run", `${(wallMs / 1000).toFixed(1)}s — past ${RUN_CEILING_MS / 1000}s; check that BLOG_RUN_BUDGET_MS is applied to every AI call, not only after a miss`);
  }

  // 8d) Access — the pages must be reachable from the portal, not only on disk.
  // Live 2026-10-22 14:22 a run wrote 9/9 and the dashboard reported a toast with
  // no link, so the tenant had no way to open, share or remove what it had just
  // generated. The offer's page list is that access path.
  const pageList = await http.get(`/tenant/blogger/offers/${offerA.id}/posts`, { headers: authHeaders() });
  const listed = Array.isArray(pageList.data?.posts) ? pageList.data.posts : [];
  const listedSlugs = listed.map((p) => p.slug);
  const missingPages = createdSlugs.filter((s) => !listedSlugs.includes(s));
  if (pageList.status !== 200) {
    fail("offer pages", `${pageList.status} ${JSON.stringify(pageList.data)?.slice(0, 160)} — the portal cannot list what it generated`);
  } else if (!listed.length) {
    warn("offer pages", "0 pages listed for the offer that just generated");
  } else if (missingPages.length) {
    fail("offer pages", `${listed.length} listed but ${missingPages.length} generated page(s) missing (e.g. ${missingPages[0]})`);
  } else {
    const first = listed[0];
    const firstUrl = first.url || `/blog/${first.slug}.html`;
    const served = await http.get(firstUrl);
    if (served.status === 200 && /<html/i.test(String(served.data || ""))) {
      pass("offer pages", `${listed.length} page(s) listed, ${firstUrl} → 200`);
    } else {
      fail("offer pages", `${firstUrl} → ${served.status} — listed for the tenant but not served`);
    }
  }

  // 9) Public tenant page (flag-gated)
  const pages = await http.get(publicPath);
  if (pages.status === 200) pass("public page", `${publicPath} → 200`);
  else if (pages.status === 404) warn("public page", `${publicPath} → 404 (AI_JOBS_MULTITENANT is off on this host)`);
  else warn("public page", `${publicPath} → ${pages.status}`);

  // 10) Cleanup + confirm the baseline is restored
  await cleanup();
  const after = await http.get("/tenant/blogger", { headers: authHeaders() });
  const nowOffers = Array.isArray(after.data?.offers) ? after.data.offers.length : -1;
  if (nowOffers === baselineOffers) pass("state restored", `offers back to ${nowOffers}`);
  else warn("state restored", `offers ${baselineOffers} → ${nowOffers} (new tenant rows or partial cleanup)`);
}

main()
  .catch(async (err) => {
    fail("verifier crashed", err.message);
    await cleanup().catch(() => {});
  })
  .finally(() => {
    const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
    console.log("");
    logInfo(`Summary: ${counts.PASS || 0} passed, ${counts.FAIL || 0} failed, ${counts.WARN || 0} warnings`);
    process.exit(counts.FAIL ? 1 : 0);
  });
