# Multi-Tenant AI Jobs — Phase 1 Runbook (site_tenants)

**Decision:** Option B — dedicated `alphadome.site_tenants` registry for the AI Jobs / blog / referral engine. Isolated from the WhatsApp `bot_tenants` path so the live money flow is never at risk.

**Status:** Phase 0 (safety net) + Phase 1 (additive schema) complete. Phases 2-4 pending your go-ahead.

## Rollback points (created in Phase 0)
- Tag `pre-multitenant-baseline` -> committed HEAD before any work.
- Branch `feat/multi-tenant-ai-jobs` holds all work.
- Your original uncommitted edits are preserved in commit `8a9ebcc` (wip safeguard).

To abandon everything and return to the exact prior state:
```
git checkout main
git branch -D feat/multi-tenant-ai-jobs   # optional
```

## Files added in Phase 1
- `migrations/2026-10-11_add_site_tenants_multitenant.sql` — forward (additive)
- `migrations/2026-10-11_add_site_tenants_multitenant_ROLLBACK.sql` — revert (drops only new objects)
- `scripts/validate_site_tenants_phase1.cjs` — read-only validation + optional isolation proof
- npm scripts: `npm run tenants:validate`, `npm run tenants:validate:isolation`

## What Phase 1 changes
- Creates `alphadome.site_tenants` (slug, name, branding, `allowed_redirect_domains`, is_active).
- Seeds tenant `default` (= today's Mercor experience).
- Adds NULLABLE `tenant_id` to: `opportunity_sources`, `opportunity_categories`, `opportunities`, `referral_links`, `opportunity_events`, `public.blog_posts`.
- Backfills every existing row to `default`.
- **No code reads `tenant_id` yet** -> live behavior is byte-for-byte unchanged.

## Apply to STAGING first (recommended)
```
# 1) Point at staging Supabase
$env:SUPABASE_URL="https://<staging-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<staging-service-role-key>"

# 2) Apply forward migration (Supabase SQL Editor: paste & run the .sql)
#    Path: migrations/2026-10-11_add_site_tenants_multitenant.sql

# 3) Validate structure (read-only)
& 'C:\Program Files\nodejs\node.exe' scripts/validate_site_tenants_phase1.cjs

# 4) Prove isolation (creates + removes its own throwaway rows)
$env:RUN_ISOLATION_TEST='true'; & 'C:\Program Files\nodejs\node.exe' scripts/validate_site_tenants_phase1.cjs
```
Expected: all checks PASS, `default` tenant present, `total == scoped` on every table.

## Promote to PRODUCTION
Only after staging is green and you've confirmed the live site still renders `/ai-jobs` and `/ai-jobs/mercor/*`:
1. Open Supabase prod -> SQL Editor.
2. Run `migrations/2026-10-11_add_site_tenants_multitenant.sql`.
3. Run the verification SELECTs at the bottom of that file.
4. Re-run the validator against prod (read-only).

## Revert Phase 1 (if ever needed)
- **Code-only instant revert (preferred, Phase 3):** set `AI_JOBS_MULTITENANT=false`. No DB change.
- **Full schema revert:** run `..._ROLLBACK.sql` (drops only the new columns + `site_tenants`; content untouched).

## Phase 3 — Multi-Tenant Traffic Engine (DONE, commit fb15c4f)
Generalized the engine beyond jobs: any `site_tenant` can drive SEO traffic to ANY offer
(job, product, service, brand, affiliate, course). All flag-gated + backward compatible.

**Data model (additive):** `opportunities` gains `offer_type` (default 'job'), `cta_label`,
`destination_url`. Existing rows backfill to `offer_type='job'` → identical behavior.
- Migration: `migrations/2026-10-15_phase3_offer_types.sql` (run BEFORE deploy).

**Feature flag:** `AI_JOBS_MULTITENANT` (default OFF). When OFF, `/ai-jobs/t/*` returns 404
and nothing changes. Set `AI_JOBS_MULTITENANT=true` in Render env to enable.

**New tenant routes (when flag ON):**
- `GET /ai-jobs/t/:tenantSlug` — tenant hub (all offers, type-badged)
- `GET /ai-jobs/t/:tenantSlug/o/:offerSlug` — individual offer (offer-aware CTA)
- `GET /ai-jobs/t/:tenantSlug/:categorySlug` — tenant category

**Offer-aware CTAs:** job→Apply, product→Shop Now, service→Learn More, brand→Explore,
affiliate→Get Deal, course→Enroll. Admin `/admin/ai-jobs` now has Tenant + Source + Offer
Type + Destination URL + CTA pickers on the create form.

### Deploy order (important — migration BEFORE code)
1. Supabase SQL Editor → run `migrations/2026-10-15_phase3_offer_types.sql` (additive, safe).
2. Push branch → `main`; Render redeploys.
3. (Optional) set `AI_JOBS_MULTITENANT=true` in Render to turn on tenant routes.
4. Live-test:
   - `/ai-jobs` and `/ai-jobs/mercor/*` unchanged.
   - `/ai-jobs/s/respondent` unchanged.
   - With flag ON: `/ai-jobs/t/default` lists all default-tenant offers.
   - Create a `product` offer in admin (set Destination URL) → it renders with "Shop Now".

## Rollback
- Instant: set `AI_JOBS_MULTITENANT=false` (tenant routes 404; everything else unchanged).
- Schema: `migrations/2026-10-15_..._ROLLBACK` not required (columns are nullable/additive);
  to fully revert, drop the 3 columns or redeploy previous commit.

## Phase A — Tenant-Portal Writer's Flow (Blogger) — commit 11e4f12
Exposes a **Writer's Flow** section in the tenant portal (`/tenant-dashboard`) for
founder's-plan clients, with two tabs: **Research & Outreach** (placeholder) and **Blogger**
(fully functional, tenant-scoped).

- **Nav:** new "Growth → Writer's Flow" item (`data-sec="writers-flow"` → `renderWritersFlow`).
- **Migration:** `2026-10-16_tenant_blogger.sql` adds `site_tenants.client_phone`
  (links a logged-in `bot_tenants` to its Blogger `site_tenants` row). **Run BEFORE deploy.**
- **APIs (tenantSessionAuth, auto-scoped):** `GET /tenant/blogger` (each offer now
  carries `page_count`), `GET /tenant/blogger/offers/:id/posts` (the pages that
  offer produced: `slug`, `title`, `angle`, `status`, `url`),
  `POST /tenant/blogger/offers`, `POST /tenant/blogger/offers/:id/publish`,
  `POST /tenant/blogger/offers/:id/blog`, `DELETE /tenant/blogger/offers/:id`,
  `DELETE /tenant/blogger/posts/:slug` (only posts with this tenant's `tenant_id`;
  removes the row and the static `public/blog/<slug>.html`).
- **Reaching what was generated (2026-10-22):** the **Blog** button is now
  **Optimize**, the offers table has a **Pages** column (`page_count`), and
  expanding a row lists every page of that offer with an **Open** link
  (`/blog/<slug>.html`) and a per-page **Delete**. A successful run expands the
  list on its own, so the deliverable is clickable instead of a number in a toast —
  before this a tenant generated 9/9 pages and had no handle on any of them (the
  dashboard only re-rendered the table). Verifier check **8d** asserts that every
  generated slug is listed for the offer and that the first page serves 200 HTML,
  so "generated but unreachable" fails the suite.
- **Share and Review (2026-10-22):** each page row now carries four actions —
  **Open**, **Share**, **Review**, **Delete**.
  - **Share** opens a mini card with the public URL (copy button), the AI-written
    **hook** / **summary** / **excerpt**, 3 key points and hashtags, plus
    *Copy caption*, WhatsApp and X targets. Backed by
    `GET /tenant/blogger/posts/:slug/share`, which returns
    `{ url, absolute_url, hook, summary, excerpt, bullets, hashtags, mode }`.
    `mode='ai'` means a model wrote the card; `mode='template'` means every
    provider was dry and it was composed from the page's own text by
    `utils/postShare.js` (same honesty rule as the page composer). `?ai=0`
    forces the deterministic card, which is what the verifier uses. Cards are
    cached in-process for 30 min keyed by `slug|updated_at`, so re-opening Share
    does not buy the same answer twice and a review invalidates it.
  - **Review** re-runs the polish pass that generation already runs per post
    (`reviewBlog`), for one page, via `POST /tenant/blogger/posts/:slug/review`.
    It rewrites `content` + `html_content`, the static file and `/blog/` index.
    The response is `{ ok, mode:'polished'|'unchanged', ai, changed }`; the
    portal says *"no AI provider was available — page left unchanged"* rather
    than claiming a polish that did not happen. The pass is bounded by
    `BLOG_REVIEW_AI_TIMEOUT_MS` (default `45000`) so a dry tier answers instead
    of holding the button for a multi-minute provider walk. That pass also used
    to rebuild
    the page CTA from a bare id (`/ai-jobs/apply/undefined`); it now loads the
    offer row, so the CTA and `tenant_id` survive a review.
  - Both routes scope through `tenantOwnsPost()`: the page's `tenant_id`, or the
    offer it was generated from when `tenant_id` is still NULL (phase-1 schema).
  - Verifier checks **8e** (card has hook/summary/excerpt + absolute URL) and
    **8f** (review runs, then the page still serves 200) cover the two actions;
    `npm run test:share-card` proves the composer offline (15 checks).
- **Scoping:** on first Blogger access, a `site_tenants` row is lazily created from the
  tenant's `bot_tenants` name/phone → public page at `/ai-jobs/t/<their-slug>`.
- **One journey per offer:** `generateBlogPostsForOpportunity` holds an in-process
  lock keyed by offer id and returns `{ success:false, busy:true }` for a second
  concurrent call — the route answers **409** instead of starting a competing
  walk. Live 2026-10-22 a double click ran two walks on the same offer; they
  rate-limited each other on the shared free tier and both ran past 14 minutes.
  Verified live the same day on `589d7d0`: `POST …/blog 409 - 217ms` while the
  first run was still walking (client saw `409 busy` in 1.05 s). The verifier
  asserts this on every run (check **8a**), so a regression to "two walks per
  click" fails the suite rather than just costing minutes.
- **Posts outlive their offer:** if the offer row is deleted mid-run, the
  `blog_posts_opportunity_id_fkey` insert is retried without `opportunity_id`
  (the page stays on disk, in the tenant's list, and in restore-on-boot) instead
  of being lost to a logged `[DB] Save error`.
- **Public page requires** `AI_JOBS_MULTITENANT=true`.

### Deploy order (migration BEFORE code)
1. SQL Editor → run `migrations/2026-10-16_tenant_blogger.sql`.
2. Push → `main`; Render redeploys.
3. Log into `/tenant-dashboard` → **Writer's Flow** → **Blogger** tab.
4. Create an offer (any type) → Publish → open the public page (flag must be ON).

### Verify a deployment — `npm run verify:writers-flow`
End-to-end check of the live host (`scripts/verify_writers_flow.js`). It reports
PASS / FAIL / WARN per check and always deletes the rows it creates.

```bash
BASE_URL=https://alphadome.onrender.com \
TENANT_TEST_PHONE=<tenant phone> TENANT_DASHBOARD_PASS=<tenant key> \
npm run verify:writers-flow
```

Checks: **build identity** (is the served bundle the latest commit?), route
registration (401 not 404, plus a 404 control), login, context, offer create,
**slug collision** (same title twice must yield two slugs), publish,
**blog generation** (must never return 200 with 0 posts), **double click**
(a second run on the same offer while the first is live must answer
`409 {busy:true}` immediately — probed 1.5 s into the run, so it costs no extra
time), **blog coverage** (warns when fewer than 9 unique angle pages were
written, and reports `mode=ai|template|mixed`), **bounded run** (fails if the
generation call exceeds 120 s wall clock, i.e. the `BLOG_RUN_BUDGET_MS` ceiling
stopped being applied), **offer pages** (every slug the run produced must come
back from `GET /tenant/blogger/offers/:id/posts` and the first page must serve
200 HTML — this is the tenant's only handle on what it paid for), public page,
cleanup, **blog
cleanup** (generated `verify-writers-flow-*` posts are deleted).

Live baseline on `589d7d0` (2026-10-22 13:42 UTC): 18 passed / 0 failed /
0 warnings — `409 busy` in 1.05 s, 9 posts in 82.8 s, 9/9 unique pages, 9 posts
deleted, offers back to 3.

Re-run on `2c5405c` (13:53 UTC) with the daily free quota **fully exhausted**:
18 passed / 0 failed / 0 warnings, `mode=template`, 9/9 pages in **19.1 s**
(`blog 200 - 18832ms`, `409 - 379ms`). A dry quota is fast, not slow: the first
angle fails provider-wide, `isAiFailureFatal()` stops the walk, and the remaining
eight pages are composed from the offer data. So the two worst cases are both
bounded — half-dry ≈ the 90 s budget, fully dry ≈ 20 s — and neither can return
fewer than nine pages.

**Why a run can still overshoot the budget by seconds (fixed after `2c5405c`).**
A dashboard run on 2026-10-22 13:54 UTC (offer `ed024a64`, 90 s budget) returned
nine pages in **109.3 s** with `[GEN] AI budget spent (108s of 90s)`. The cause
was one call, not the loop: the `openrouter/free` attempt started with **12.8 s**
of budget left and answered **30.7 s** later — almost exactly
`BLOG_AI_TIMEOUT_MS` (30 s). Clamping the axios `timeout` to the remaining budget
was not a bound at all, because in Node that timeout measures **socket
inactivity**: an upstream that trickles its response keeps the socket "active"
and the value is never reached. `ai()` now arms an `AbortController` for
`min(BLOG_AI_TIMEOUT_MS, remaining)` and destroys the socket itself when it
fires, so a stalled or trickling provider is cut **at** the deadline
(`[AI] openrouter <slug> aborted after Ns — time box spent`). Regression test:
`test:ai-providers` → *"a slow provider is cut at the deadline, not at its own
pace"* (1500 ms budget against a stub that needs 5000 ms must return in < 3 s,
and an abort stays transient, never fatal). `[GEN] Done:` now ends the run with
`posts in Ns of Ms budget`, so the host log alone proves the ceiling.

**Why a provider that never answered could still spend the whole angle (fixed
after `d921f7f`).** A 90 s run on 2026-10-22 18:03 UTC (offer `2442b8c8`, 45 s
angle budget) returned nine composed pages with this log:

```
[AI] openrouter model google/gemma-4-31b-it:free unusable (429) — trying minimax…
[AI] openrouter model minimax/minimax-m3.1-flash:free unusable (404) — trying nvidia…
… four more 429s …
[AI] openrouter openrouter/free aborted after 30.0s — run budget spent
[AI] gemini gemini-flash-latest aborted after 6.3s  — run budget spent
[AI] hf skipped — run budget spent
[GEN] AI unavailable for [Awareness] (transient) — composed from the offer data
```

The deadline was respected but not **shared**: OpenRouter's queue (six `429/404`
answers plus one 30 s stall on the router slug) took 37 s of a 45 s angle, so
Gemini — never tried — was cut 6.3 s into its first call, and HF never ran. The
tier then looked dry and all nine pages fell back to composed copy. Three
fixes:

1. **Fair share.** Each keyed provider owns an equal slice of whatever is left
   (`remaining / providersWithAKeyLeft`), and time a provider does not use rolls
   into the next slice. One keyed provider still owns the whole deadline, so
   single-key hosts behave as before; three keys on a 45 s angle give ~15 s each.
2. **Retired slugs are retired.** A `404` now removes that slug for the life of
   the process (`[AI] openrouter retired <slug> (404) — dropped for this
   process`) instead of re-paying the round-trip on all nine angles.
3. **The router slug is time-boxed.** `openrouter/free` picks an upstream per
   request and held the full attempt timeout on both 13:55 and 18:03, so it is
   capped at `BLOG_ROUTER_MODEL_CAP_MS` (8 s) like the last resort it is.

Regression tests in `test:ai-providers`: *"a stalled provider cannot spend the
next provider's share"* (3 s deadline, stalled OpenRouter + healthy Gemini must
return Gemini's content in ~1.5 s), *"a 404 slug is probed once per process, not
once per angle"*, and *"the last-resort router slug is time-boxed"*.

**Why a dead key still cost 16-31 s per Share/Review (fixed after `a7eef63`).** The
fair share above decided *who* owns the deadline, not *whether* a provider had
earned one. Live 2026-10-23 04:24-04:27 every keyed provider was dead in a
different way — OpenRouter's free slugs `429/404`, `gemini-flash-latest` `429 You
exceeded your current quota`, `hf` `402 You have no remaining credits` — and each
walk re-probed all three: `POST …/posts/<slug>/review 200 - 31336ms`, then another
at `16896ms`, both ending in *AI tier unavailable — copy unchanged*. Three fixes:

1. **A dead key is skipped, not re-probed.** Auth/billing (`401/402/403`, "no
   remaining credits") retires the provider for the life of the process
   (`[AI] hf retired for this process (402) — no point re-probing every angle`); a
   daily-quota `429` ("exceeded your current quota", "plan and billing") puts it on
   a `BLOG_PROVIDER_QUOTA_COOLDOWN_MS` cooldown (default 5 min). A plain `429`
   ("temporarily rate-limited upstream") stays eligible — that one clears in
   seconds and the slug walk already handles it.
2. **A cooling key stops claiming a share.** `remaining / providersLeft` counted
   corpses as candidates, so a healthy key was handed one third of the deadline.
   Only providers that can still answer are counted now, and time they do not use
   rolls to the next one.
3. **One key = one quota.** A billing/quota answer stops that provider's slug walk
   instead of burning its whole share on the remaining six slugs — the `429` naps
   alone were 6.9 s of a 5 s Share slice. With nothing eligible the walk answers
   immediately: `[AI] every keyed provider is cooling down — openrouter (402 needs
   an account fix, not a retry), gemini (quota 429), hf (402 …)` in ~1 ms.

Regression tests in `test:ai-providers`: *"an out-of-credits key is not dialled
again on the next angle"*, *"a cooling provider stops claiming a share of the
deadline"* (quota-dead OpenRouter asked **once**, healthy Gemini serves both
angles), and *"a known-dead tier answers immediately instead of holding the
button"* (zero requests, < 250 ms against a 45 s Review budget). None of this
repairs a dead key — it only stops paying for the answer. The fix per status is in
the table below.

Exit `0` = no failures, `1` = at least one, `2` = missing config. A stale
`build identity` FAIL means the host is serving an older commit — redeploy from
the Render dashboard (this repo has no CI deploy script).

**Why the first click on the cooldown build still cost 15-32 s (`95ef246`).**
Keys were now skipped, but one *slug* kept being paid for: live 2026-10-23
05:17-05:18, `nvidia/nemotron-3.5-lightning:free` accepted the request and sent
**zero bytes** — 13.1 s of a Share slice, then 30.0 s alone (gemini and hf were
already out of rotation, so it owned the whole deadline), then 13.5 s on the next
Share. `POST …/review 200 - 16209ms` and `32230ms`, both *AI tier unavailable —
copy unchanged*: 56 s of three clicks re-proving one silence. A `404` retired the
slug; silence retired nothing. Now:

1. **Silence is evidence.** An attempt that is cut by its box with no byte
   received (axios `onDownloadProgress`, so a response that merely trickles is
   *not* counted) and that got a *fair* box (≥ `min(BLOG_AI_TIMEOUT_MS, 8 s)`;
   a slice cut to 2 s by a neighbour says nothing about the model) counts as a
   silent box for that slug.
2. **Two silent boxes retire the slug** for the process, exactly like a `404`:
   `[AI] openrouter retired nvidia/nemotron-3.5-lightning:free (no bytes in 2
   time boxes) — dropped for this process`. Set
   `BLOG_AI_STALL_RETIRE_AFTER=0` to disable.
3. **The second attempt is a probe, not another share.** A slug that already sat
   out a fair box gets `min(remaining, 8 s)` next time (constant `STALL_PROBE_MS`),
   so the live sequence becomes 13.1 s + 8 s once, then nothing on every later
   click instead of 30 s per click forever.

Regression test in `test:ai-providers`: *"a slug that answers nothing twice is
retired, not re-boxed every click"* (silent OpenRouter slug, Gemini serving both
clicks, third click answered by the next live slug with **no** further probe of
the dead one). Again this only stops paying for a dead thing — a silent free
slug is an OpenRouter-side problem, and the fix per provider is to top up or
rotate the key, or drop the provider.

### When blog generation fails — `npm run test:ai-providers`
The writer never fabricates posts: if the LLM returns nothing it fails loudly
and the 502 body ends with `Last AI error: <provider> <status> <body>`. That
string is the diagnosis — you do not need host logs.

| `Last AI error` contains | Meaning | Fix |
| --- | --- | --- |
| `openrouter/hf 402 no remaining credits` | key valid, account out of credits | set `GEMINI_API_KEY` (free, no card) or `OPENROUTER_API_KEY`, or buy credits |
| `401` / `unauthor` | key revoked or wrong | rotate the key on Render |
| `404` + `unavailable for free` | the free model slug was retired (2026-10-22: `llama-3.1-8b-instruct:free`, `minimax/minimax-m3.1-flash:free`) | nothing — the writer falls through `OPENROUTER_FREE_MODELS` on `404`, including past a retired `OPENROUTER_MODEL` pin, and drops the dead slug for the rest of the process; clear the pin if the console logs show it leading every run |
| `404` (any other) | model route not available on that account | set `OPENROUTER_MODEL` / `HF_MODEL` |
| `429` + `rate-limited upstream` | that one model's upstream pool is saturated; the key is fine | nothing — the writer advances to the next slug in `OPENROUTER_FREE_MODELS` (live 2026-10-22: gemma-4-31b was throttled while five siblings were healthy) |
| `429` + `You exceeded your current quota` | your own free-tier quota (per day) | wait for the reset window, add a second key, or add credits (OpenRouter free tier: 50 req/day, 1000/day after a one-time $10 credit). **Gemini quota belongs to the Google Cloud project, not the key**, and resets at midnight Pacific (10:00 EAT): a freshly created key in the *same* project pours from the same exhausted daily bucket, so it fixes nothing. A new project, billing on the old one, or another provider does |
| only 1 post written, run then stops | fail-fast matched one exhausted provider (e.g. `hf 402`) in the joined error string | fixed 2026-10-22: only an all-provider auth/billing failure aborts a journey; redeploy and re-run the verifier |
| `verify-writers-flow-*` posts visible on `/blog` | verifier runs published real posts before the post-delete endpoint existed | `npm run prune:verify-posts` on the host to list them, `npm run prune:verify-posts -- --apply` to delete (needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `no AI provider key configured` | no key at all | set one of the three keys |

Providers are tried in order — **OpenRouter → Gemini → Groq → Cerebras →
Mistral → OpenAI → HuggingFace** — so any single key is enough. The journey only aborts
when **every** provider it could try failed on auth/billing (`401/402/403`, "no
remaining credits"). One exhausted provider next to a healthy one, or a `429` /
`RESOURCE_EXHAUSTED` quota reply, lets the remaining angles continue — otherwise
a permanently dead HuggingFace `402` in the chain caps every run at one post.
Within a provider, the models are a list too (OpenRouter's free slugs, Gemini's
two flash aliases, Groq's three), and a `404`/silent alias advances to the next
one instead of ending the run.

**Zero-spend recovery.** Google AI Studio issues a `GEMINI_API_KEY` with a free
tier and no credit card (https://aistudio.google.com/apikey). The writer talks to
Gemini through its OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), so setting only that
one var restores generation on the next restart — no code change and no purchase.

**The keys live on the host, not in the repo.** A fresh clone has no `.env` (it is
gitignored; this tier's keys exist only as Render environment variables), so
`npm run check:ai-key` printing `(no key)` on your machine says nothing about the
host — do not "add a key" because the local probe is empty. To test the key the
host is *actually* using, reveal it in Render → **Environment** and pass it
in-process:

```
npm run check:ai-key -- --only=gemini --key GEMINI_API_KEY=AIza...
```

Nothing is written to a file and only a masked form is printed. The value is read
by the same `ai()` walk the host runs, so `SERVED` here means the host's key will
serve; a `429 quota` here means the host will not, and no amount of redeploying
changes that. `scripts/render_env_sync.ps1` reads the live set before it PUTs, so
it re-asserts whatever key is already there rather than blanking it — but never
run it with `-DeleteOptional`, which deliberately drops `GEMINI_API_KEY`,
`OPENROUTER_*` and `HF_*`.

#### Prove a key before you deploy it — `npm run check:ai-key`
Rotating a key used to be a guess: the only feedback was the Writers tab, or the
host log after the fact. On 2026-10-23 the tier held four keys and served no
copy — HF `402`, Gemini `429` daily quota, four of five OpenRouter free slugs
`429`/`404` — and every click still came back `200` in ~31 s. This check asks the
provider directly, through the same `ai()` walk that serves Writers, Share,
Review and replies, so its verdict cannot drift from production:

```
npm run check:ai-key                       # every provider that has a key
npm run check:ai-key -- --only=gemini      # just one
npm run check:ai-key -- --key GEMINI_API_KEY=AIza...   # no file, no .env needed
```

It prints the masked key it used, then per provider either
`SERVED in 0.4s — "OK"` or the chain's own status/body *plus the fix*
(`out of credits`, `key rejected`, `daily quota spent`, `slug retired`,
`no answer inside the time box`). Exit code `0` = at least one provider wrote
copy, `1` = none did — so it can gate a deploy.

Sequence when the tier is already keyed — the usual case, because the keys are
Render variables: reveal the var in Render → **Environment**, then run
`npm run check:ai-key -- --only=<provider> --key <VAR>=<value>` until it says
**SERVED** or names the account problem. If it names quota, wait for the reset
(Gemini: midnight Pacific, 10:00 EAT) or change project/provider — redeploying
does not help. Sequence for a brand-new key: create it → probe it with `--key` →
add the same var on Render → **Manual Deploy** (auto-deploy is off on this host) →
boot log must say `gemini=true` → click Review on the Writers tab and confirm the
API body says `mode:"polished"` → `npm run verify:writers-flow`.

**A deploy that builds the wrong commit looks exactly like a broken fix.** Live
2026-10-23 14:56: `main` was two commits ahead of `origin/main`. Render built
`origin/main` (`facc1404`), booted with the four-provider line
(`openai openrouter gemini hf` — no `groq`, `cerebras`, `mistral`) and the old
`OPENROUTER_KEY`-only read, and the first Review after "deploy" still ended
`AI tier unavailable — copy unchanged` in 16.4 s. The fix was never wrong, it was
never deployed. Before a Manual Deploy:

```
git status -sb                      # must be "## main...origin/main" with no "ahead"
git --no-pager log --oneline -1 origin/main
```

After it, the first `[SYSTEM] LLM providers:` line is the proof of which code is
live — `Deployed commit:` in the same block names the SHA, so a stale build is
one line away from being obvious.

**A visitor and a health check look the same in this log — until you count what
they fetch.** Live 2026-10-24 03:55, on a host with no `[SYSTEM]` block in view:

```
[PAGE] Landing page loaded by ::1 at 2026-10-24T03:54:36.466Z   GET / 200 - 4ms
[PAGE] Landing page loaded by ::1 at 2026-10-24T03:55:36.216Z   GET / 200 - 4ms
POST /api/kassangas/track-visit 200 - 6ms
GET /media/tmp5_0ryzre.mp4 206 - 95ms   (×10 clips, ~40 MB, inside 13 s)
```

`::1` is Render's in-instance proxy, not the visitor: `app.set('trust proxy', 1)`
had never been set, so `req.ip` — and therefore every `ip` / `source_ip` column in
the analytics and admin-audit logs — was `::1` for everybody. The fix is one line
at the top of `server.js`; `npm run test:site-hygiene` proves that a forwarded
`X-Forwarded-For: 203.0.113.9` resolves to the visitor, that a forged prefix
cannot move it, and that `/favicon.ico` no longer 404s twice per demo visit.

Rules for reading this log:

- A `/` hit with **no follow-up requests** is a pinger or the Render health check.
  A `/` hit followed by `track-visit` + media ranges is a person.
- `206` on `/media/*.mp4` and `CLOSED BEFORE END` on the same file is a browser
  swapping `src` mid-stream, not a server bug — count the clips instead: the
  landing carousel is set to 24 s per clip, so ten clips inside 13 s means the
  `error` / `load-timeout` path is advancing it, and the visitor never finishes a
  clip. `public/media` is 47 MB across 11 files (eight still named `tmp*.mp4`,
  plus a byte-identical copy of the same clip under both a dashed and a spaced
  filename), and every visit pulls most of it.
- A landing page whose payload is 47 MB cannot be shown on a bad connection: it
  is the first thing a prospect sees. Cut the carousel to three clips under 3 MB
  each before a demo — the server side of the page is fine.


Relevant env (all optional except one key):

| Var | Default |
| --- | --- |
| `OPENROUTER_API_KEY` | — (preferred; aliases `OPENROUTER_KEY`, `OPEN_ROUTER_API_KEY`) |
| `OPENROUTER_MODEL` | unset → tries `google/gemma-4-31b-it:free`, `minimax/minimax-m3.1-flash:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3.5-lightning:free`, `poolside/laguna-s-2.1:free`, `openrouter/free` in order. A pin is tried **first** and the free list still follows it, so a retired pin cannot starve the writer (2026-10-22: the host was pinned to `llama-3.1-8b-instruct:free`, OpenRouter retired it, and every angle 404'd while three healthy free models sat unused). Retired (`404`) and throttled (`429`) slugs advance to the next model; only `401/402/403` stops the list |
| `BLOG_ANGLE_DELAY_MS` | `1200` — pause between angles so nine sequential calls stay inside per-minute free limits; set `0` on a paid key |
| `BLOG_FALLBACK_MODE` | `auto` — when an angle gets nothing from every provider, compose it from the offer's own fields (`public/blog/<slug>.html` still gets a full page). `off` restores the loud 502 for diagnosis |
| `BLOG_AI_MAX_MISSES` | `2` — consecutive angles that return nothing from any provider before the rest of the run is composed without further AI calls. This is a latency budget, not a quorum rule: per-run only, so the next run tries AI again. `0` always walks every angle |
| `BLOG_AI_TIMEOUT_MS` | `30000` per HTTP attempt (was `120000`). A provider that accepts the connection then stalls must not hold the tenant's request open for two minutes per model slug |
| `BLOG_RUN_BUDGET_MS` | `90000` — hard wall-clock ceiling for the whole AI walk, counted from the first angle and applied to **every** AI call (compose, duplicate retry, review). When it is spent the remaining angles are composed from the offer data, so a run finishes in roughly this long with all nine pages. Live 2026-10-22: `1 of 9 pages in 6 minutes` while free slugs answered `429` and the stall burned the old 120 s per-attempt timeout; later that day a run that answered **one** angle out of nine still held the request `166 s` (`mode=mixed`, 8 pages composed anyway) because the ceiling was only applied after a miss. Fixed on `589d7d0` the same day: the deadline now applies to every call, and the same nine-angle run that previously took `166 s` returned in **`82.8 s`** with **9/9** unique pages (8 composed from the offer data, `mode=mixed`) — the verifier's **8c** check fails the suite if a run ever exceeds 120 s again. The ceiling is enforced *inside* each call by an `AbortController`, not only between calls (see *Why a run can still overshoot the budget…* above), so an overshoot is at most the page being saved, never a whole provider timeout. Raise the budget (e.g. `240000`) on a funded key where AI copy matters more than latency. `0` disables the ceiling |
| `BLOG_ANGLE_BUDGET_MS` | `45000` — ceiling for **one angle's** provider walk, split equally between the providers that have a key (see *Why a provider that never answered…*). A single angle tries up to seven candidate model slugs on one key: live 2026-10-22 one angle cost 37 s (5 models, one stalled 23 s before returning `429`). Effective per-call deadline is `min(now + this, run deadline)`, and each call in an angle (compose, duplicate retry, review) gets its own slice. Set `0` to cap only per attempt. The review pass is skipped once 60 % of the run budget is spent, so the tail of the budget buys AI-written pages rather than polish on page three |
| `BLOG_ROUTER_MODEL_CAP_MS` | `8000` — time box for the `openrouter/free` router slug, the only candidate with no upstream latency promise (it held a full 30 s attempt on both 2026-10-22 incidents). Every other slug is bounded by `BLOG_AI_TIMEOUT_MS` and the provider's share of the deadline. `0` disables the extra cap |
| `BLOG_PROVIDER_QUOTA_COOLDOWN_MS` | `300000` — how long a provider that answered a **daily-quota** `429` ("You exceeded your current quota", "check your plan and billing") is skipped. Live 2026-10-23: nine angles plus every Share and Review each paid a fresh `429` to Gemini, and each dead key still claimed a third of the deadline. `0` re-probes it on the next angle |
| `BLOG_AI_STALL_RETIRE_AFTER` | `2` — how many *fair* time boxes a model slug may spend sending **zero bytes** before it is retired for the process (a slug that only trickles is never counted). Live 2026-10-23 05:17-05:18: `nvidia/nemotron-3.5-lightning:free` was handed 13.1 s, 30.0 s, then 13.5 s across three tenant clicks and answered none. The first retry after a silent box is a probe capped at 8 s. `0` disables it |
| `WHATSAPP_AI_BUDGET_MS` | `12000` — wall-clock ceiling for one WhatsApp reply's walk through the same provider chain (`scripts/blogManager.js`, `ai(prompt, deadline, messages)`). The reply path used to keep its own copy of the provider list and it drifted: it read `OPENROUTER_KEY` (the host sets `OPENROUTER_API_KEY`), posted to `api.openrouter.ai` (no such host — `getaddrinfo ENOTFOUND`), pinned `meta-llama/llama-3.3-70b-instruct:free` (retired), and never tried Gemini at all, so a live Gemini key sat unused while the bot answered "Hello" from the static welcome (live 2026-10-23 06:36). One chain now serves writers, Share, Review and replies; `0`/unset keeps the 12 s default |
| `GEMINI_API_KEY` | — (free tier, no card) |
| `GEMINI_MODEL` | unset → tries `gemini-flash-lite-latest` then `gemini-flash-latest`. A pin is tried **first** and the alias list still follows it (same rule as `OPENROUTER_MODEL`). Live 2026-10-23 10:40: the daily quota had reset and no request `429`'d, yet `gemini-flash-latest` sent **zero bytes for its whole 15 s slice** and the click still ended "AI tier unavailable — copy unchanged" — one alias was a single point of failure, so the light alias now leads |
| `GROQ_API_KEY` / `GROQ_MODEL` | — / unset → `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `openai/gpt-oss-20b`. Free tier, no card (https://console.groq.com/keys). Fastest first token in the chain, and it fails *fast*: a throttled key answers `429` in ~100 ms instead of eating the slice. `GROK_API_KEY` is accepted as an alias (see *The variable name is part of the wiring*) |
| `CEREBRAS_API_KEY` / `CEREBRAS_MODEL` | — / unset → `llama3.1-8b`, `gpt-oss-120b`. Free tier, no card (https://cloud.cerebras.ai). A different company with a different quota, so a Gemini *and* Groq dry spell still leaves one answer |
| `MISTRAL_API_KEY` / `MISTRAL_MODEL` | — / unset → `mistral-small-latest`, `open-mistral-nemo`, `mistral-large-latest`. Free "experiment" tier (https://console.mistral.ai), EU-hosted, OpenAI-compatible. Last free step before paid OpenAI; alias `MISTRALAI_API_KEY` accepted |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | — / `gpt-4o-mini` |
| `HF_API_KEY` / `HF_MODEL` | — / `meta-llama/Llama-3.1-8B-Instruct:novita`. **Not a free tier in practice**: a valid key on an unfunded account answers `402 "You have no remaining credits"` (live 2026-10-23) and is retired for the process. `HF_API_KEY_WRITERS_FLOW` is an *alias name* for the same credential, not a second account — if your two HF keys are different accounts, unset the dry one so the alias is actually read (the walk takes the first non-empty var) |
| `*_BASE_URL` | provider default (used by the offline test) |

**The variable name is part of the wiring.** On 2026-10-23 this host was
provisioned with `GROK_API_KEY` (for Groq), `OPEN_ROUTER_API_KEY` (for OpenRouter)
and `MISTRAL_API_KEY`. All three keys were valid; two of the names were read by
nothing, so two tiers were invisible and the only symptom was a boot line saying
`groq=false openrouter=false` while the Render dashboard showed the variable
sitting there. A key that exists and is never read is the same outage as no key —
the 2026-10-22 incident hid behind exactly that kind of false signal (`hf=true`
on a `402` account). Two answers are now in the code:

1. **Canonical name first, dashboard spellings accepted** — `OPENROUTER_API_KEY`
   → `OPENROUTER_KEY` → `OPEN_ROUTER_API_KEY`, `GROQ_API_KEY` → `GROK_API_KEY`,
   `MISTRAL_API_KEY` → `MISTRALAI_API_KEY`, `HF_API_KEY` →
   `HF_API_KEY_WRITERS_FLOW` (one `keyFrom()` helper in `scripts/blogManager.js`,
   so the boot log, the probe and the walk cannot disagree).
2. **The probe prints the var it read** — `npm run check:ai-key` shows
   `Groq  gsk_…only (26 chars) via GROK_API_KEY`, which is how you see a
   misspelling in one line instead of guessing why a saved key does nothing.

Canonical names are still the ones to use on a new service, and `render.yaml`
should carry them. Any *other* name (`OPENROUTER_KEY_ID`, `GROQ_KEY`, …) is still
a key nobody reads.

`npm run test:ai-providers` proves the whole chain offline against a stub
server — no keys, no network, no DB. It reproduces the 402 incident and the
2026-10-22 live failures, and verifies fallback order, empty-content handling,
model override, retired-slug fallthrough, throttled-slug (`429`) fallthrough, the
402-still-aborts rule, provider cooldowns, silent-slug retirement and the fast-fail
when every key is out of rotation (**33 checks**), plus the no-key message — the
newest seven cover Gemini's light→full alias fallback, the `GEMINI_MODEL` pin,
Groq serving when OpenRouter+Gemini are out, Cerebras as the backstop when three
earlier keys are `402`, the two dashboard spellings (`GROK_API_KEY`,
`OPEN_ROUTER_API_KEY`) reaching their provider, and Mistral answering after four
`402`s.

**Which free tiers to wire (and why this order).** Every provider below speaks
the same OpenAI-compatible shape, so support is a key + a URL + a model list in
`scripts/blogManager.js` — no new code path, no adapter. Limits move; check the
console before you promise a buyer a number. What matters for a live demo is that
a *key that answers* exists in more than one company.

| Provider | Get a key | Free tier | Why it is in this chain | Watch out |
| --- | --- | --- | --- | --- |
| Groq **(wired)** | https://console.groq.com/keys | rate-limited, no card | fastest first token (LPU) and ~100 ms `429`s, so a dry key costs a fraction of a second instead of a slice | per-minute caps: a 9-angle run can hit one, which is what the slug walk absorbs |
| Google AI Studio (Gemini) **(wired)** | https://aistudio.google.com/apikey | daily quota, no card | the zero-spend workhorse; two flash aliases | the quota belongs to the Cloud **project**, resets midnight PT; the heavy alias can send zero bytes for 15 s |
| Cerebras **(wired)** | https://cloud.cerebras.ai | small daily quota, no card | a third, independent pool with a different speed profile | smallest free quota of the three — backstop, not workhorse |
| Mistral La Plateforme **(wired)** | https://console.mistral.ai | rate-limited experiment tier | EU-hosted, OpenAI-compatible, a fourth independent company | free tier is opt-in and rate-limited; `mistral-large-latest` is slow |
| OpenRouter `:free` slugs **(wired)** | https://openrouter.ai/keys | ~50 req/day, ~1000/day after a one-time $10 | widest model menu, and `openrouter/free` routes to whatever is healthy | slugs get retired (`404`) and throttled (`429`) with no notice — never the only key (live 2026-10-23: 2×429 + 2×404 in one walk) |
| GitHub Models | https://github.com/settings/tokens (PAT) | per-model request caps with a GitHub account | GPT-class copy on a free tier, OpenAI-compatible endpoint | PAT, not an API key; per-model caps are low |
| Cloudflare Workers AI | https://dash.cloudflare.com | daily free "neurons" | one more independent pool | **not** OpenAI-compatible — needs an adapter, so it is *not* a drop-in like the rest |
| Together AI | https://api.together.ai | small starter allowance | many open models | not a durable free tier; it becomes paid |

**Do not** plan on HuggingFace Inference Providers as the free tier: an unfunded
account answers `402 "You have no remaining credits"` no matter how valid the key
is (live 2026-10-23, twice). Prepaid credits or PRO are required. OpenAI is paid;
Anthropic, xAI and DeepSeek have no durable free API tier.

**Free-tier budget.** One journey is 9 sequential generation calls plus one
review call per post, so a handful of test runs exhausts a small free tier — a
real `429` from Gemini after repeated runs is expected, not a code bug. Angles
are paced by `BLOG_ANGLE_DELAY_MS` (default 1200 ms) and each throttled slug
falls through to the next model, so nine angles can complete on free slugs alone.
Keep at least **three keyed providers**: on 2026-10-23 this host had four keys and
still served no copy, because all four were the same two failures (a dry HF
account and a Gemini project out of quota) plus a free pool that was throttled —
and only one of those keys was ever dialled inside a slice.

**When every tier is dry at once** (live 2026-10-22: OpenRouter `429` on the
remaining free slugs, Gemini daily quota spent, HuggingFace `402`), the journey
no longer ends empty. Each angle is composed from the offer's own fields by
`utils/angleFallback.js` — title, type, price, location, skills, CTA — and the
run still writes nine pages under nine distinct URLs. The response says so:

| Field | Meaning |
| --- | --- |
| `result.mode` | `ai` (every angle from a model), `template` (every angle composed), `mixed` (the AI tier recovered mid-run) |
| `result.fallback` | how many posts were composed rather than generated |
| `posts[].fallback` | `true` on a composed post — the dashboard toast says "composed from offer details" |

Composed copy is deliberately honest: it never invents a price (it asks for one
when the offer states none) and it escapes tenant-supplied fields. It is a demo
and continuity guarantee, not an AI substitute — the page reads as structured
advice, and the flags above make sure nobody claims a model wrote it.

`npm run test:blog-fallback` covers this path offline (10 checks): a unique slug
per angle, 230+ words per composed post, no pair above the duplicate threshold,
survival with a title-only offer, HTML escaping, no markdown artefacts, the
price never invented, CTA resolution for every offer type, plus both directions
of the job/buyer split described below.

**Offers are not all jobs.** The journey was written for the Mercor job catalog,
so a tenant's service listing produced "How to Get Hired as a Kassangas Music
Shop" and "Remote … Jobs" on its own blog. Every template now branches on
`offer_type`: `job` (the default, which is what every legacy row and every
untyped row resolves to) keeps the career copy, everything else gets buyer copy
("What It Costs and What You Get", "How to Brief …", "Taking … Beyond a Single
Site"). The prompts branch too, so the AI is not asked to write career advice
for a service either.

**One page per angle.** Until 2026-10-22 the two templates inside an angle were
slugged `<offer>-<angle>`, so the second post overwrote the first — a "9 of 9
angles" run wrote five pages. Slugs now carry the stage
(`<offer>-awareness-1`, `<offer>-awareness-2`, …) and the verifier counts unique
slugs, not array entries.

### Phase B (next) — Research & Outreach
Tenant-scope the original WF: add `wf_campaigns.tenant_id`, `/tenant/wf/*` endpoints,
per-tenant SMTP, and the Research & Outreach tab UI.

## Next (Phase 4, optional)
- Converge tenant resolution onto `alphadome-kernel` behind parity tests.
- Per-tenant custom domains / branded paths; respondent.io sample offers.
- Founder's-plan gating for Writer's Flow (currently shown to all active tenants).


