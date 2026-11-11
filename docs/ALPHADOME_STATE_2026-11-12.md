# Alphadome — what the system actually does (state of the system, 2026-11-12)

_Repository archaeology, not a pitch. Every number below was read from the files, from the
live database (`twxmfdwemchrswxzjstp`), or from a live HTTP probe on 2026-11-12. Where a
figure could not be obtained, this document says so instead of estimating._

## 0. The one-paragraph version

Alphadome is a single Node/Express monolith (`server.js`, **16,713 lines**) with eleven
route modules, 41 utility modules plus 21 browser-actor modules, 106 scripts, **67 live
database tables** and **161 environment variables**. It runs five distinct revenue
systems on one domain — a multi-tenant WhatsApp commerce bot, a Scan-to-Pay merchant
wallet, an AI-jobs referral marketplace, a digital-product storefront, and an
autonomous blog engine — plus one capability that underpins two of them: a **Browser
Actor Runtime** that drives real MoreLogin browsers on operator machines to do work that
websites only allow a human to do. The WhatsApp path carries real traffic (11,785
conversations, newest yesterday); the jobs marketplace has real SEO traffic (6,029
events, newest yesterday); everything else is built but currently dormant or empty.

## 1. Inventory (files, not hopes)

| Measure | Value |
|---|---|
| Files (excluding `node_modules`, `.git`) | **726**, 202 MB |
| Text files counted line-by-line | **611 files / 305,851 lines** |
| JavaScript / ESM / CJS | 164 `.js`, 85 `.mjs`, 29 `.cjs` |
| TypeScript (kernel microservice) | 18 |
| Documentation | 112 `.md` + 16 `.txt` (many at repo root) |
| SQL migrations | **80 `.sql`** in `migrations/` (67 distinct tables created) |
| HTML surfaces | 37 (27 in `public/`, 2 admin dashboards, kernel demo/admin) |
| Largest single file | `server.js` — 16,713 lines |
| Next largest code | `admin/tenant_dashboard.html` 5,922 · `admin/dashboard.html` 4,740 · `routes/drops.js` 1,398 · `scripts/blogManager.js` 1,496 |
| Binaries committed | `ngrok.exe` **25 MB**, `Writer's_Flow_3_0.ipynb` 10,257 lines, 12 `.mp4`, 8 `.png` |

**Dead weight that is still in the tree** — five superseded servers and two old landing
pages: `server_marautat_base.js` (2,009 lines), `server_with_context.js` (1,770),
`server.js.bak_local` (1,710), `server_old.js` (303), `server.js.bak` (107),
`index-old.html`, `tmp_old_index.html`. None is imported by `server.js`. `package.json`
still declares `"main": "index.js"`, a file that does not exist — the real entry point is
`npm start → node server.js`.

## 2. How it runs

| Fact | Evidence |
|---|---|
| Express 5, ESM, Node 22 on Render (Frankfurt), port 10000 | Render log `Deployed commit: 687eb9ec`, `Server running on port 10000` |
| Boot restores the entire blog corpus from Postgres to disk | `restoreBlogs()` in `server.js`, logs `[Blog] Restored N posts` |
| Static assets served from `public/` with `index:false`, then explicit routes | `app.use(express.static(publicDir, { index: false }))` |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` |
| `robots.txt` disallows `/admin/` and `/api/`, advertises `/sitemap.xml` | served inline by `server.js` |
| Tenant identity | signed cookie session (`TENANT_SESSION_COOKIE`, `utils/tenantSession.js`), survives deploys |
| Admin identity | `ADMIN_PASS` / `ADMIN_KEY` shared secret; `/admin` answers **401 JSON** without it |

**Route surface: 222 routes declared in `server.js` + ~89 in the route modules ≈ 311 HTTP
endpoints.** Mounted routers:

| Mount | Module | What it serves |
|---|---|---|
| `/ai-jobs` | `routes/aiJobs.js` | opportunity marketplace pages |
| `/` | `routes/sitemap.js`, `aiJobsAdmin.js`, `aiJobsGuides.js` | sitemap, job admin, guide pages |
| `/` | `routes/writerFlow.js`, `browserAccess.js`, `agentRuns.js` | tenant blogger + worker protocol |
| `/` | `routes/drops.js` | storefront, M-Pesa lane, entitlements, funnel |
| `/` | `routes/socialPublish.js` | X post prefill + publish |
| `/api/agents/browser` | `routes/browserActors.js` | agent-facing browser leasing |
| `/webhook` (inline) | `server.js` | Meta WhatsApp inbound + status callbacks |

## 3. The five revenue systems

### 3.1 WhatsApp commerce bot — the busiest system

**Live traffic, proven:** 11,785 rows in `conversations`, 12,803 in `whatsapp_logs`, newest
message **2026-11-11 09:06 UTC**. 13 `bot_tenants` today (plus 10 legacy rows in the
`alphadome` schema), 24 `bot_products`, 12 product images, 4 variants, 3 collections with
7 items.

**Inbound path.** `POST /webhook` runs a signature middleware first
(`verifyWebhookSignature`), then `loadTenantContext`, then handles two payload kinds:
message events and **status callbacks** (delivered/read/pricing/errors written back onto
the conversation row by `whatsapp_message_id`). On a bad signature it still returns 200 so
Meta stops retrying, but logs `Webhook signature validation failed`. `WHATSAPP_APP_SECRET`
is **not set** in production (OPEN_FLAGS #1), so today that check is skipped entirely.

**90 `/tenant/*` routes**, grouped as they exist:

| Group | Endpoints (examples) |
|---|---|
| Onboarding & session | `POST /tenant/onboard`, `POST /tenant/session/login`, `GET /tenant/session/me` |
| Campaigns (Writer's Flow) | `GET/POST /tenant/wf/campaigns`, `POST …/:id/run`, `GET …/:id/leads` |
| Training the bot | `GET/POST /tenant/training`, `PATCH/DELETE /tenant/training/:id` |
| Catalogue & suppliers | `GET/POST/DELETE /tenant/catalog`, `GET /tenant/suppliers` |
| Orders | `GET/POST /tenant/orders`, `PATCH/DELETE /tenant/orders/:id` |
| Broadcast | `GET /tenant/broadcast/audience`, `POST /tenant/broadcast`, `GET …/history` |
| Recovery | `GET /tenant/abandoned-carts`, `POST /tenant/abandoned-cart-recovery` |
| Customer intelligence | `/tenant/customers`, `/customers/:phone`, `/conversations/search`, `/preferences`, `/favorites`, `/referrals`, `/products/performance` |
| Tenant settings | `GET/PATCH /tenant/profile`, `GET/PATCH /tenant/smtp`, voice picker, branding, analytics |
| Blogger | `/tenant/blogger/browser-access/*`, `/tenant/blogger/runs`, `/tenant/blogger/posts/:slug/publish/x` |

**Intelligence.** Eight LLM providers wired with a fallback order (`LLM_PROVIDER_ORDER`):
OpenRouter, Gemini, Groq, Cerebras, Mistral, HuggingFace, OpenAI, Grok. Per-tenant **voice**
is resolved deterministically (`utils/tenantVoice.js`, six profiles) and injected into
prompts; brand context comes from `utils/alphadomeBrandContext.js`. Follow-up automation
runs on an interval (13 min, batch 1, 24h cooldown, dry-run flag) — visible in the boot log.

**Money.** `POST /mpesa/stk-push` and `POST /api/kassangas/stk-push` initiate;
`POST /mpesa/callback` confirms. **`bot_orders` holds 0 rows** — the bot talks to people,
but nothing in this database records an order through it.

### 3.2 Scan-to-Pay (Kassangas merchant wallet)

105 rows in `kassangas_templates`, 155 in `subscriptions`, **newest 2026-10-30** — built,
used, then quiet.

| Surface | Route | Probe |
|---|---|---|
| Public pay page for a tokenised link/QR | `GET /pay/t/:tokenId` | **200 live** |
| Payment intent from that page | `POST /pay/t/:tokenId/intent` | live code |
| Merchant shop front | `GET /kassangas-music-shop` | **200 live** |
| Merchant portal (QR generation, collections) | `GET /kassangas-merchant-portal` | **200 live** |
| Client wallet | `GET /kassangas-client-wallet` | **200 live** |
| Marketplace / buy / history | `/api/kassangas/marketplace`, `/buy-product`, `/sales/history` | live code |
| Finance manager, referral links | `/api/kassangas/finance-manager`, `/referral-link` | live code |

Rules live in one pure module (`utils/scanPay.js`: MSISDN normalisation, tenant merchant
code, 12-character account reference, masked phone, collection summaries, STK readiness) so
the tenant dashboard and the public pay page cannot disagree. `payments` could not be
counted — PostgREST returned no count, so **settled volume is unverified**.

### 3.3 AI Jobs referral marketplace

**Live traffic, proven:** 351 `opportunities`, 11 categories, 4 sources, **6,029
`opportunity_events`**, newest **2026-11-11 09:14 UTC**. 11 `site_tenants` — a *separate*
registry from the WhatsApp `bot_tenants`, created deliberately so the jobs engine can never
touch the live money path.

| Surface | Purpose |
|---|---|
| `GET /ai-jobs`, `/ai-jobs/mercor`, `/ai-jobs/mercor/:category` | SEO landing layers (**200 live**) |
| `GET /s/:sourceSlug`, `/t/:tenantSlug`, `/apply/:id` | per-source, per-tenant pages, application interstitial |
| `GET /ai-jobs/guides/:slug` | guide content with FAQ schema |
| `GET /go/:id` | tracked outbound redirect, allowlisted domains only |
| `/admin/ai-jobs/*` | CRUD, analytics, blog generation from offers |

Monetisation is **referral links**: `t.mercor.com` codes per category (11), `respondent.io`
allowed, with an open-redirect guard in `utils/aiJobsConfig.js`. 78 marketplace offers were
captured by the browser runtime; 76 referral links verified as landing on the right role
(OPEN_FLAGS #7 closed). Only 78 of 226 Turing roles were ever collected (#6).

### 3.4 Digital Drops (built and shipped this week)

5 products across four rungs + 2 free lead magnets, one funnel: free → entry (KES 1,500) →
core (2,500 / 4,500 / 6,500) → premium (12,000) → `/build` ($3,000+). M-Pesa lane live; the
card lane is code-complete and inert (`DROPS_CARD_LINK` unset). Funnel instrumentation
returns leads / views / checkouts / paid / gross per rung. **`digital_orders`,
`digital_entitlements` and `digital_leads` are all 0** — no sale yet. It is the closest
system to revenue and the only one whose whole path a stranger can complete unaided.

### 3.5 The blog engine — the acquisition engine, currently paused

**841 `blog_posts`; newest 2026-11-07** (five days stale). Pages are rows first and files
second: `restoreBlogs()` writes `public/blog/*.html` at boot and `/blog/:slug` falls back to
a database read when the file is missing, so a freshly generated page cannot 404 between a
workflow run and the next deploy.

| Layer | Files |
|---|---|
| Generation, provider fallback, quality gates | `scripts/blogManager.js` (1,496), `utils/blogWriter.js`, `utils/blogQuality.js`, `utils/angleFallback.js` |
| Durability and queue | `utils/blogQueue.js`, `utils/blogJobs.js`, `blog_posts`, `blog_jobs` |
| Conversion instrumentation | `utils/conversionPlaybook.js`, `utils/ctaBlock.js`, `utils/contentJourney.js` |
| Scheduling | Render Workflow `blogQueue` + Render cron `*/30` + GitHub Actions `*/15`, `BLOG_RUN_LIMIT=3` |
| Sanitisation | `utils/articleHtml.js`, `scripts/repair_blog_html.js` |

Readership evidence: 14,289 `analytics_page_views`, 471 `analytics_clicks`.

## 4. The engine underneath: Browser Actor Runtime

83 `browser_actor_runs`, 19 `browser_actor_agent_tokens`, 16 `browser_actor_pairings`;
newest run **2026-11-07**.

| Capability | Where | Rule it enforces |
|---|---|---|
| Lease a MoreLogin desktop profile / cloud phone | `utils/browserActor/runtime.js`, `moreloginClient.js` (CLI + HTTP transports) | `debugPort` is a string and parsed once; a cloud `cdpUrl` is a credential and is never logged or persisted |
| Attach and drive a page | `utils/browserActor/cdp.js` | one Chrome DevTools Protocol client, no second driver |
| Tenant-owned credentials | `routes/browserAccess.js`, `utils/tenantBrowserProvider.js` | keys sealed AES-256-GCM under `TENANT_SECRET_KEY`; never returned, not even fingerprinted; refuse to store without the sealing key |
| Run queue | `utils/browserActor/runs.js`, `routes/agentRuns.js` | one active run per (tenant, kind) via a partial unique index; "alive" = recent heartbeat, not a status string; **partial is a real outcome** |
| Ship the worker | `utils/zipStore.js`, `scripts/build_worker_bundle.mjs`, `/worker-bundle` | store-only ZIP, no new dependency, runs with an empty environment and no DB key |
| Work arms | `utils/browserActor/tasks/` | `micro1`, `turing`, `turingReferrals`, `oneForma`, `socialPlatforms` (LinkedIn/X/Facebook/Reddit/YouTube), `superiorEssays` |
| Social listening | `scripts/browser_actor_social_listen.mjs` (475), `utils/socialIntent.js` | a zero must explain itself; every exit closes the run; engagement + recency scoring; `social_signals` table is **empty** (no run since 7 Nov) |

**Blocked by a vendor quota, not by code:** MoreLogin's daily profile-start limit
(OPEN_FLAGS #16), which is why the last run is 7 November. The code now classifies that as
`provider_quota` and refuses to retry.

## 5. Supporting engines (built, low or no current traffic)

| Engine | Evidence | State |
|---|---|---|
| **Tenant onboarding + discovery** | 12 `discovery_submissions`, newest **2026-10-30**; `/discovery` live (23 KB form) | functional, no inbound for 12 days |
| **Admin console** | `/admin` **401** without a key; `dashboard.html` 4,740 lines, `tenant_dashboard.html` 5,922 | live, operator-facing |
| **Tenant portal** | signed session, branding, analytics, responsive, SMTP per tenant | live |
| **Writer's Flow (outreach)** | `writers_flow/` 1,800 lines; `wf_campaigns`, `wf_leads`, `wf_outreach` **all 0** | code complete, never run at scale |
| **Alphadome Kernel (TS)** | `alphadome-kernel/` 28 files, separate service, `npm run start:kernel`, isolation proofs | **not part of the live web service** |
| **MiniHack trendjack** | `minihack/bounty2-trendjack/` 1,831 lines — trends → content briefs | not wired into the server |
| **ABOSS research pipeline** | 17 scripts, 20+ CSVs; `abos_*` tables **all 0** | a manual research workbook pipeline, not a running service |
| **DOP eval tasks** | `dop/` proof harness, `npm run dop:proof` | offline quality harness |
| **OneForma / Micro1 / Turing queues** | `utils/oneFormaQueue.js`, task modules | adapters ready, driven by worker runs |

## 6. What the database says (live census, all 67 tables checked)

Every table declared in `migrations/` exists in production — **67 of 67**. Row counts are
exact (`HEAD` + `count:exact`), read 2026-11-12.

**Live and holding data**

| Rows | Table | What it means |
|---:|---|---|
| 113,456 | `logs` | server log mirror |
| 14,289 | `analytics_page_views` | real readership |
| 12,803 | `whatsapp_logs` | every message in and out |
| 11,785 | `conversations` | real WhatsApp demand |
| 6,029 | `opportunity_events` | jobs-page engagement |
| 841 | `blog_posts` | the SEO corpus |
| 471 | `analytics_clicks` | outbound CTA clicks |
| 351 | `opportunities` | job offers with referral links |
| 155 | `subscriptions` | Kassangas/tenant subscriptions |
| 105 | `kassangas_templates` | Scan-to-Pay payment links issued |
| 84 | `users` | admin/portal users |
| 83 | `browser_actor_runs` | worker executions |
| 31 / 25 / 8 | `_bot_reconcile_report`, `_tenant_merge_report`, `_bot_coachdawn_report` | migration evidence trails |
| 24 | `bot_products` (+12 images, 4 variants, 3 collections, 7 items) | the catalogue the bot sells from |
| 19 / 16 | `browser_actor_agent_tokens`, `browser_actor_pairings` | paired tenant machines |
| 13 / 10 | `bot_tenants` (public) / `bot_tenants` (`alphadome` schema) | **two tenant registries** |
| 12 | `discovery_submissions` | inbound client applications |
| 11 | `site_tenants`, `opportunity_categories` | jobs multi-tenancy |
| 8 | `digital_events` | drops funnel (test traffic) |
| 5 / 2 | `digital_products`, `digital_lead_magnets` | the drops catalogue |
| 3 | `brands` | brand templates |
| 1 | `blog_jobs`, `referral_links` | |

**Live but empty — built for something that has not happened yet**

`digital_orders`, `digital_entitlements`, `digital_leads` (no sale, no lead);
`bot_orders`, `bot_templates`, `bot_training_data`, `bot_message_logs`, `bot_control_settings`
(the bot converses but its commerce tables are unused); `social_signals`;
`wf_campaigns`, `wf_leads`, `wf_outreach`; `service_requests`; `freelancers`, `tasks`;
`whatsapp_phone_tenant_mapping` (a likely cause of OPEN_FLAGS #5);
`automation_log`; all six `alphadome.abos_*` tables.

**Recency — what was alive this week**

| Newest row | Table |
|---|---|
| 2026-11-11 09:14 | `opportunity_events` (jobs pages) |
| 2026-11-11 09:11 | `analytics_page_views` |
| 2026-11-11 09:06 | `conversations`, `whatsapp_logs` |
| 2026-11-07 | `blog_posts`, `opportunities`, `browser_actor_runs` |
| 2026-10-30 | `discovery_submissions`, `kassangas_templates`, `subscriptions`, `site_tenants`, `bot_tenants` |

So: **WhatsApp and the jobs marketplace are running; the blog stopped five days ago;
Scan-to-Pay and the discovery form stopped a fortnight ago.**

## 7. Live vs dormant — the honest ledger

| System | Evidence of life | Verdict |
|---|---|---|
| WhatsApp bot | 11.7k conversations, message yesterday | **live, high volume, zero recorded orders** |
| AI Jobs pages | 6k events, yesterday | **live, monetisation unmeasured** |
| Blog engine | 841 posts, page views | **built, paused since 7 Nov** |
| Digital Drops | 5 products, funnel live | **shipped, no sale yet** |
| Scan-to-Pay | 105 templates | **built, dormant since 30 Oct** |
| Browser runtime | 83 runs | **blocked by vendor quota** |
| Discovery / onboarding | 12 submissions | **idle 12 days** |
| Writer's Flow, ABOSS, MiniHack, Kernel | 0 rows, not mounted | **code, not product** |

## 8. Structural risks worth fixing before scale

| # | Risk | Evidence | Consequence |
|---|---|---|---|
| 1 | **Signature verification is skipped on the WhatsApp webhook** | `WHATSAPP_APP_SECRET` unset (OPEN_FLAGS #1); code logs and continues | anyone with the URL can inject fake inbound messages |
| 2 | **Service-role key was exposed in chat once** | OPEN_FLAGS #2 | full RLS bypass; rotation status unknown |
| 3 | **One 16,713-line `server.js` with 222 routes** | file inventory | every deploy risks the WhatsApp money path; no router boundary to test |
| 4 | **Two tenant registries** (`bot_tenants`, `site_tenants`) plus legacy `alphadome.bot_tenants` | 13 / 11 / 10 rows | the "0 candidates for 254…" lookup gap (OPEN_FLAGS #5); onboarding can succeed where messaging cannot route |
| 5 | **161 env vars, 8 LLM providers** | env map | configuration drift is the dominant failure mode; a missing key degrades silently |
| 6 | **Dead servers and 25 MB binary in git** | 5 superseded servers, `ngrok.exe`, `.ipynb` | clone/build cost and audit noise; `main: index.js` is wrong |
| 7 | **19 npm vulnerabilities, 1 critical** | Render build log, OPEN_FLAGS #4 | untriaged, possibly in the payment paths |
| 8 | **No CI running the ~40 test suites** | only `.github/workflows/blog-automation.yml` is scheduled | thousands of assertions exist and are run by hand |
| 9 | **Commerce tables empty while conversation volume is high** | `bot_orders` 0 vs `conversations` 11,785 | the bot is an engagement tool today, not a sales channel — either orders happen elsewhere or intent is never converted |
| 10 | **`payments` unreadable via PostgREST** | count returned null | settled money cannot be audited from the app's own key |

## 9. What I could not verify (stated, not hidden)

- **Settled M-Pesa volume.** `payments` returned no count; no per-order ledger was found in
  the tables I could read. `bot_orders` and `digital_orders` are both 0.
- **SMTP delivery.** `health` reports the mailer as configured, but the only live send I
  attempted went to a reserved domain and failed. No evidence yet that mail reaches a real
  inbox from Render.
- **Render's environment itself.** No `RENDER_API_KEY` here, so service-level env values and
  deploy history can only be inferred from logs pasted in chat.
- **The `alphadome` schema's older objects.** Counts for several returned null through
  PostgREST; `bot_tenants` (10), `bot_products` (24), images/variants/collections did read.
- **Whether `server_marautat_base.js` / `server_with_context.js` are ever run.** Nothing
  imports them; they look like historical snapshots.

## 10. Where the revenue actually is (preview only — the plan comes next)

Ranked by distance to a first real shilling, using only what this audit found:

1. **Digital Drops** — the only complete stranger-to-delivery path. It needs a first sale, a
   card lane, and a sub-KES-2,000 entry product, in that order.
2. **The WhatsApp bot** — 11,785 conversations is the largest untapped asset in the
   repository. Nothing records what those conversations wanted. Instrumenting intent →
   offer → order is the highest-leverage change available.
3. **Scan-to-Pay** — 105 issued payment links prove merchants used it. It is dormant, not
   broken: one conversation with Kassangas restarts it.
4. **AI Jobs** — 6,029 events on pages that carry referral codes. It needs click-to-
   application instrumentation before it can be called a channel.
5. **`/build`** — the only $3,000+ offer, and the only one that needs a human to send an
   email. It is the highest-value, lowest-volume lever.

## 11. How to reproduce this audit

```bash
npm run drops:doctor              # schema truth for the drops tables
node scripts/drops_pipeline.mjs   # catalogue + funnel integrity, no network
npm run test:drops                # 381 assertions
npm run test:drops:flow           # 93 assertions
```

The censuses in sections 1, 6 and 7 were produced read-only: every table declared in
`migrations/` was probed with a `HEAD` count, and the public surfaces were probed over HTTP
on 2026-11-12. No row was written or modified to produce this document.





