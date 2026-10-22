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
 *   8b) blog coverage        — WARN when fewer than every angle produced a post
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
    const hasNew = spa.data.includes("Blog generated (");
    const hasOld = spa.data.includes("'Blog generated'");
    if (hasNew) pass("build identity", "serving build with real blog-post count toast");
    else if (hasOld) fail("build identity", "serving a build older than the blog-failure fix (host has not deployed latest commit)");
    else warn("build identity", "no blog toast marker found — dashboard markup changed");
  } else {
    warn("build identity", `dashboard returned ${spa.status}; cannot identify build`);
  }

  // 2) Route registration — 401 proves the route exists and is auth-gated;
  // 404 means the route is absent. The bogus control must stay 404.
  for (const [method, path] of [["get", "/tenant/blogger"], ["post", "/tenant/blogger/offers"]]) {
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
  const blog = await http.post(`/tenant/blogger/offers/${offerA.id}/blog`, {}, { headers: authHeaders(), timeout: 180000 });
  const posts = blog.data?.result?.posts;
  if (Array.isArray(posts)) {
    for (const p of posts) if (p?.slug) createdSlugs.push(p.slug);
  }
  if (blog.status === 200 && Array.isArray(posts) && posts.length > 0) {
    pass("blog generation", `${posts.length} post(s) written, e.g. ${posts[0]?.slug}`);
    // A partial journey still answers 200, so it used to report "all green"
    // (2026-10-22: 1 of 9 posts passed every check). Say so out loud.
    if (posts.length < EXPECTED_ANGLES) {
      const skipped = Array.isArray(blog.data?.result?.skipped) ? blog.data.result.skipped : [];
      const why = skipped[0]?.error ? ` — first skip: ${String(skipped[0].error).slice(0, 160)}` : "";
      warn("blog coverage", `${posts.length}/${EXPECTED_ANGLES} angles produced a post${why}`);
    }
  } else if (blog.status === 200 && Array.isArray(posts) && posts.length === 0) {
    fail("blog generation", "200 with 0 posts — false success (pre-fix behaviour)");
  } else if (blog.status === 502) {
    warn("blog generation", `failing loudly as designed: ${blog.data?.error || "no detail"}`);
    warn("blog root cause", "AI writer returned nothing for every angle — check GEMINI_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / HF_API_KEY and the model on the host");
  } else {
    fail("blog generation", `${blog.status} ${JSON.stringify(blog.data)?.slice(0, 200)}`);
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
