# Browser Actor Runtime (MoreLogin)

> AlphaDome agents can now act on the open web through a **named, isolated, fingerprinted browser identity per tenant** — brokered by this server, attached over CDP, leased, and audited.

Status: **implemented, tested, and verified live** (2026-10-31). 101 assertions pass offline (no MoreLogin install, no browser, no database), and the adapter has been exercised against **MoreLogin Client 2.69.0.0 + ml-cli 2.8.4** on Windows x64.

---

## Decision summary (repo rule: one buyer, one workflow, one asset)

| | |
|---|---|
| **Target buyer** | An AlphaDome tenant or agency whose buying signal sits *behind a login* — tender portals, supplier/ERP portals, marketplaces, Facebook groups, LinkedIn, WhatsApp Web. Secondarily AlphaDome's own ABOSS outbound motion. |
| **Workflow solved** | "The agent must *be* the tenant on a site we have no API for." Tender capture, lead verification from a real Kenyan identity/IP, price and stock checks on supplier portals, marketplace listing checks. |
| **Reusable code already in repo** | `routes/` + `utils/` split and the pure-module/thin-route pattern from `utils/scanPay.js`; Supabase service-role fallback client convention (`utils/aiJobsService.js`); `ADMIN_KEY`/`ADMIN_PASS` auth idiom (`routes/aiJobsAdmin.js`); the ABOSS pipeline (`scripts/aboss_*`) as the first producer/consumer; `alphadome-kernel` as the reasoning layer. |
| **Minimal slice shipped** | `utils/browserActor/*` (MoreLogin client with CLI + HTTP transports, identity registry, lease broker, dependency-free CDP client) + `routes/browserActors.js` at `/api/agents/browser` + migration + probe CLI + test suite. |
| **Revenue impact** | Unlocks the two highest-ticket motions that were blocked on "we can't log in": **tender intelligence** and **verified lead qualification**. Both are already sold-into workflows (`aiJobs`, ABOSS); this removes the manual step and makes them deliverable per tenant instead of by hand. |
| **Main technical risks** | (1) Account bans if identities are shared or abused — mitigated by one-profile-per-tenant + leases. (2) `ml-cli` version drift — mitigated by pinning to documented CLI 2.8.3 contracts and typed errors. (3) Token leakage from Cloud `cdpUrl` — mitigated by handing it only to the lease creator. (4) A remote browser farm on a public host — mitigated by fail-closed auth. |
| **Next validation step** | On a host with the MoreLogin client: `npm run browser:doctor`, then `node scripts/browser_actor_probe.mjs capture --tenant <slug> --url <real tender portal>`, then wire ABOSS tender capture to `POST /api/agents/browser/capture`. |

---

## Architecture

```
 agent (ABOSS worker / kernel / any HTTP client)
   │  x-agent-key + tenant slug
   ▼
 POST /api/agents/browser/sessions        routes/browserActors.js
   │                                      ├─ identity.js   tenant -> envId (map | table | default)
   │                                      ├─ sessions.js   one lease per profile, TTL, token
   │                                      └─ runtime.js    start / close / phones
   ▼
 utils/browserActor/moreloginClient.js
   ├─ transport "cli"  -> ml-cli env start --env-id …   (port found via IPC pipe)
   └─ transport "http" -> POST 127.0.0.1:<port>/api/env/start
   ▼
 MoreLogin profile (fingerprint + proxy + cookies, one per tenant)
   ▼  debugPort
 utils/browserActor/cdp.js  ->  CDP over WebSocket (Node 22+, no npm dependency)
   ▼
 page facts: title, description, headings, text, links, form/button counts
```

Why this shape:

- **`ml-cli` is the default transport, not the Local API.** The client's port is not stable between launches; `ml-cli` discovers it over `\\.\pipe\MoreLogin-cli`. Hard-coding `--port 40000` would work on one host and silently fail on the next, so the adapter only forwards `--port` when an operator explicitly sets `MORELOGIN_PORT`. The direct HTTP transport exists for verification and for hosts where the port is pinned.
- **Both transports return one normalised shape.** MoreLogin answers `debugPort` as a **string** (`"9222"`). That is parsed once, in `normalizeStartResult`, so every caller attaches with a number.
- **No Puppeteer/Playwright dependency.** The few CDP calls an agent needs are ~150 lines over Node's built-in `WebSocket`. A solver that needs the full surface can still attach Puppeteer to `browserURL` — the endpoint is returned as-is.
- **Leases are in memory, audit is in Postgres.** A lease is a runtime fact; the audit table answers "who drove whose profile, when, from which agent".


---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_API_KEY` | *(unset)* | Shared key agents present as `x-agent-key` or `Authorization: Bearer`. Falls back to `ADMIN_KEY` then `ADMIN_PASS`. **If none is set the router answers 503** — it never opens a browser farm by accident. |
| `MORELOGIN_TRANSPORT` | `cli` | `cli` (ml-cli, IPC port discovery) or `http` (Local API directly). |
| `MORELOGIN_CLI_PATH` | `ml-cli` | Path to the CLI binary. |
| `MORELOGIN_PORT` / `ML_PORT` | *(unset)* | Only set this to pin the Local API port. Setting it disables IPC discovery. `http` defaults to `40000`. |
| `MORELOGIN_API_KEY` / `ML_API_KEY` | *(unset)* | Local API bearer token, if the client requires one. |
| `MORELOGIN_HOST` | `127.0.0.1` | Local API host. |
| `MORELOGIN_TIMEOUT_MS` | `20000` | Default request timeout. `env start` uses 45s and `cloudphone open` 150s regardless. |
| `BROWSER_ACTOR_PROFILES` | *(unset)* | JSON map, highest-priority binding: `{"acme":"1673823102599682","beta":{"envId":"42","runtime":"cloud"}}`. |
| `BROWSER_ACTOR_DEFAULT_ENV_ID` | *(unset)* | Single-profile demo mode. Never use in production: every unmapped tenant would share it. |

Identity resolution order: `BROWSER_ACTOR_PROFILES` → `browser_identities` table → `BROWSER_ACTOR_DEFAULT_ENV_ID` → **`profile_unmapped` error**.

Apply the schema: `migrations/2026-10-31_browser_actor_runtime.sql`.

---

## API

Base: `/api/agents/browser` · Header: `x-agent-key: <AGENT_API_KEY>`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Provider reachability (cached 30s) + active lease count. |
| `GET` | `/profiles` | Tenant→profile bindings, **masked** (`16**********82`). |
| `POST` | `/sessions` | Lease a profile and start it. Returns the attach point. |
| `GET` | `/sessions?tenant=` | Active leases (token never included). |
| `GET` | `/sessions/:id?tenant=` | One lease. |
| `POST` | `/sessions/:id/heartbeat` | Extend a lease (`leaseToken`, `ttlSeconds`). |
| `DELETE` | `/sessions/:id?close=false` | Release; closes the profile unless `close=false`. |
| `POST` | `/capture` | One-shot: lease → start → read page → release/close. |
| `GET` | `/phones` | Cloud phone inventory. |
| `POST` | `/phones/open` | Open a cloud phone (`id` or `keyword`, not both). |

### Lease a profile and attach

```bash
curl -s -X POST http://localhost:3000/api/agents/browser/sessions \
  -H "x-agent-key: $AGENT_API_KEY" -H 'content-type: application/json' \
  -d '{"tenant":"acme","purpose":"tender-capture","ttlSeconds":900}'
```

```json
{
  "ok": true,
  "session": { "sessionId": "…", "leaseToken": "…", "tenant": "acme",
               "envIdMasked": "16**********82", "expiresAt": "…", "cdp": {"host":"127.0.0.1","port":9222} },
  "attach": { "host": "127.0.0.1", "port": 9222, "browserURL": "http://127.0.0.1:9222",
              "webdriver": "…", "wsUrl": null,
              "note": "Attach with Puppeteer (browserURL) or Playwright (connectOverCDP) on this host." },
  "provider": { "runtime": "local", "status": "RUNNING", "pending": false }
}
```

### One-shot capture (the call most agents want)

```bash
curl -s -X POST http://localhost:3000/api/agents/browser/capture \
  -H "x-agent-key: $AGENT_API_KEY" -H 'content-type: application/json' \
  -d '{"tenant":"acme","url":"https://tenders.example/ke","maxChars":4000,"maxLinks":40}'
```

```json
{
  "ok": true,
  "page": {
    "title": "Tender Portal KE", "url": "https://tenders.example/ke",
    "description": "Public tenders", "headings": ["Open tenders"],
    "text": "Supply of 200 laptops …",
    "links": [{ "text": "Apply", "href": "https://tenders.example/ke/1" }],
    "counts": { "links": 1, "forms": 1, "buttons": 2, "inputs": 3 },
    "readyState": "complete", "browser": "Chrome/124"
  },
  "session": { "sessionId": "…", "tenant": "acme" }
}
```

The lease is released and the profile closed even when capture throws — that is asserted in the suite.

### Errors (branch on `error`, not on prose)

| `error` | HTTP | Agent should |
|---|---|---|
| `unauthorized` | 401 | Fix the key. |
| `not_configured` | 503 | Operator action: set `AGENT_API_KEY` / map a profile. |
| `profile_unmapped` | 409 | Operator must bind the tenant (`details.fix`). |
| `profile_busy` | 409 | Wait for `details.expiresAt` or retry later. |
| `lease_conflict` | 409 | You are not the holder of this lease. |
| `cli_missing` | 503 | Install the client + `ml-cli` on this host. |
| `provider_error` / `provider_timeout` | 502/504 | Retry with backoff; check `details.providerCode`. |
| `cdp_error` / `cdp_timeout` | 502/504 | Profile started but not drivable; re-lease. |
| `unsupported_transport` | 501 | Feature needs `MORELOGIN_TRANSPORT=cli`. |

---

## Driving it from an agent

**In-process (kernel / ABOSS script)** — no HTTP hop:

```js
import { capturePage } from '../utils/browserActor/cdp.js';
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';

const runtime = createBrowserRuntime({ client: createMoreloginClient() });
const started = await runtime.startProfile(envId, { headless: true });
try {
  const page = await capturePage({ host: started.host, port: started.debugPort, url });
  // page.title, page.text, page.links …
} finally {
  await runtime.closeProfile(envId);
}
```

**Full control (Puppeteer / Playwright)** — attach to the port the lease returned:

```js
// Puppeteer
const browser = await puppeteer.connect({ browserURL: attach.browserURL });

// Playwright
const browser = await chromium.connectOverCDP(`http://${attach.host}:${attach.port}`);
```

Then keep the lease alive while you work:

```bash
curl -s -X POST "$BASE/sessions/$SESSION_ID/heartbeat" \
  -H "x-agent-key: $AGENT_API_KEY" -H 'content-type: application/json' \
  -d "{\"leaseToken\":\"$LEASE_TOKEN\",\"ttlSeconds\":900}"
```

If the process dies, the lease expires on its own (default 15 min, max 4 h) and the next agent can take the profile. No reaper timer is needed: expiry is enforced at every read.

### First revenue workflow: tender capture

1. `GET /ai-jobs` already produces opportunity rows; ABOSS already builds lead queues.
2. Add one step to the ABOSS worker: for each tenant with a tender portal, `POST /capture` on the portal's search URL.
3. Feed `page.text` + `page.links` into the existing generation engine (`alphadome-kernel/src/ai/promptEngine.ts`) to extract deadline, buyer, value, and eligibility.
4. Write into the existing `opportunities` table so the tenant portal and blog surfaces show it with zero new UI.

### Cloud phones

`GET /phones` lists them; `POST /phones/open` opens one. Opening is a **request accepted**, not proof the device finished booting — verify separately (same caution the vendor docs give). Phone actions are CLI-transport only in v1; the direct Local API transport deliberately reports `unsupported_transport` rather than inventing an endpoint.

---

## Security model

- **Fail closed.** No key configured → 503. Wrong key → 401. Comparison is constant-time.
- **One tenant, one profile, one holder.** Binding is explicit; a profile can only be leased once at a time, and only the holder's token can heartbeat or release it.
- **Tokens never persist.** `leaseToken` is returned to the creator only and never appears in list/detail responses. A Cloud `cdpUrl` is returned **once**, to the creator, and is never written to the audit row or a log line. `redact()` strips `api-key`/`token` from every diagnostic string.
- **SSRF guard.** `POST /capture` accepts only `http:`/`https:` absolute URLs, max 2048 chars.
- **Tenant scoping on reads.** `GET /sessions/:id` for another tenant's session returns 404, not 403 — no existence oracle.
- **RLS on.** Both tables have RLS enabled with no anon policy; only the service role touches them.

## Operator runbook

### Host prerequisite: the MSVC runtime

`ml-cli.exe` imports exactly one non-OS DLL — `VCRUNTIME140.dll`. On a host without
the Visual C++ runtime it dies at startup with `0xC0000135` (`STATUS_DLL_NOT_FOUND`)
and reports **nothing** on stdout, which is why the vendor bootstrap fails with
"Downloaded ml-cli could not report a valid version".

Two supported fixes, in order of preference:

1. **System-wide (needs one UAC approval):** install the Microsoft Visual C++
   2015–2022 Redistributable (x64). Most production hosts already have it.
2. **App-local (no elevation):** copy a genuine **x64** `vcruntime140.dll` next to
   `ml-cli.exe` in `%USERPROFILE%\.morelogin\bin`. Verify it first — a 32-bit copy
   fails differently (`0xC000007B`, `STATUS_INVALID_IMAGE_FORMAT`), which is the
   trap here: VS Code's bundled copy under `tools\` is x86.

Check a copy's architecture before trusting it (PE machine type at `e_lfanew+4`:
`0x8664` = x64, `0x14c` = x86). Confirm `Authenticode=Valid` and a Microsoft signer
too — the runtime is executable code.

```bash
# 1. Is MoreLogin usable from this host?
npm run browser:doctor
#    -> {"transport":"cli","reachable":true,…}   exit 0

# 2. What profiles exist in the account?
node scripts/browser_actor_probe.mjs profiles

# 3. Prove one profile works end to end
BROWSER_ACTOR_PROFILES='{"acme":"1673823102599682"}' \
  node scripts/browser_actor_probe.mjs capture --tenant acme --url https://example.com

# 4. Run the offline suite (CI, no MoreLogin needed)
npm run test:browser-actor
```

Mounting `ml-cli` (Windows, per vendor docs): copy `ml-cli.exe` into a folder on `%PATH%` (e.g. `%LOCALAPPDATA%\MoreLogin\bin`), reopen the terminal, then `ml-cli --version`.

## Known limits (v1, deliberate)

1. **The MoreLogin desktop client must run on the same host as the broker.** That is the vendor's local-runtime constraint. Cloud runtimes remove it (`runtime: "cloud"`), but a Cloud `cdpUrl` is only usable by a worker on that same network — the HTTP API hands it over; it does not proxy the browser session.
2. **Leases are per-process.** Two server instances would each keep their own lease table. Fine for the current single-instance deploy; move the broker to Postgres (`browser_actor_sessions` + a `select … for update`) before horizontal scaling.
3. **No screenshot/PDF capture yet.** One evaluate returns text facts; screenshots are a second CDP call (`Page.captureScreenshot`) and a decision about storage.
4. **No per-tenant URL allowlist.** Any authenticated agent can point a profile at any http(s) URL. Add `allowed_domains` to `browser_identities` when a second tenant onboards.
5. **`env close` falls back to `env stop`** if an older CLI build rejects the subcommand. Both are probed, neither is guessed.

## Distribution layer (X automated, LinkedIn assisted)

A Writer's Flow page already yields a share card (`utils/postShare.js` → hook ≤140,
excerpt ≤240, hashtags) and `admin/tenant_dashboard.html` already renders it. This
layer adds the two places the card can go — and the difference between them is a
legal constraint, not a preference.

| Platform | Method | Why |
|---|---|---|
| **X** | API v2 `POST /2/tweets`, per-tenant OAuth 2.0 user token | Programmatic posting is the intended use of the API. |
| **LinkedIn** — company page | Community Management API (app review + page admin) | The only sanctioned programmatic publishing path. |
| **LinkedIn** — personal profile | **Assisted**: the agent composes, the human presses Post | LinkedIn prohibits automated activity on a member account. There is deliberately **no endpoint** that posts to it. |

On a phone the two paths **must** differ, and this is a vendor limitation rather
than a bug in the portal: LinkedIn's app takes over `linkedin.com` links and drops
any prefilled text, so `feed?shareActive=true&text=…` pre-fills the composer on
desktop and silently loses the copy on mobile. Therefore:

- **Desktop** — opens the composer with the post already typed in.
- **Mobile** — opens the official `sharing/share-offsite/?url=…` link, so the
  article *preview card* still appears, and the tenant pastes from **Copy for
  LinkedIn**.
- **X** — the intent link behaves the same on both, so it is left alone.

`wfIsMobileShare()` in `admin/tenant_dashboard.html` decides which link to render;
a test asserts both branches exist.

Endpoints (tenant session required, mounted beside the existing share card):

- `GET /tenant/blogger/posts/:slug/prefill` — one card → X text (t.co-weighted) and
  LinkedIn body, plus warnings: template-mode disclosure, dropped excerpt, fold risk.
  Sends nothing.
- `POST /tenant/blogger/posts/:slug/publish/x` — publishes to X. `{"dry": true}` (or
  `?dry=1`) returns the exact text without touching the API or a rate-limit slot.

Enforced in code and pinned by tests:

- X counts a URL as **23 characters**. Text is measured *before* the call, so a
  282-character post fails locally instead of after a round trip.
- The link is never cut. **Hashtags go first, then the excerpt, then the hook is
  trimmed** — a tenant never sends a customer a truncated URL.
- A tenant with no token gets `409 social_not_configured`, never a fake success.
- The token never reaches a response body, a `details` object, or a log line.
- `linkedin.assisted` is always `true`; the absence of a LinkedIn publish route is
  the control, so do not add one.

| Variable | Purpose |
|---|---|
| `SOCIAL_X_TOKENS` | JSON map `{"tenant-slug":"user-access-token"}` (same convention as `BROWSER_ACTOR_PROFILES`) |
| `X_USER_ACCESS_TOKEN` | single-tenant fallback |
| `X_API_BASE` | default `https://api.x.com` |

Verify with `npm run test:social-publish` (83 assertions, no X credentials needed).

## Marketplaces the tenant already works on

The Writer's Flow header already sends tenants to these, so the agent's job is to
read the account the tenant already has — not to invent a funnel:

| Platform | Portal button | Registered as |
|---|---|---|
| **Micro1** | `https://refer.micro1.ai/opportunities` | `account` — reads the tenant's own login |
| **Turing** | `https://work.turing.com/jobs` | `account` |
| **Mercor** | referral links (`utils/aiJobsConfig.js`) | `referral` |

- `utils/browserActor/platforms.js` is the registry an adapter reads. A test asserts
  its URLs still equal the anchors in `admin/tenant_dashboard.html`, so an adapter
  can never be written against a link the tenant stopped using.
- `migrations/2026-10-31_seed_micro1_turing_sources.sql` registers both as
  `opportunity_sources` (dual-schema, idempotent) and merges `micro1.ai` /
  `turing.com` into the tenant redirect allowlist so `/go/:id` links validate.
- **Reading is the whole job.** Matches land in `opportunities` and render in the
  portal that already exists. Nothing auto-applies to a marketplace on a tenant's
  behalf — that is where these platforms stop being tolerant and where a tenant's
  reputation gets spent.

```bash
BROWSER_ACTOR_PROFILES='{"malingu-ventures":"2116562908359495680"}'
```

The live identity verified on 2026-10-31 belongs to **Malingu Ventures** (profile P-4,
Turing signed in as *Saddy Malingu*). Writer's Flow is the **feature inside their
tenant portal**, not the tenant: a role read from this profile is Malingu Ventures'
offer and nobody else's. `toOfferDraft()` therefore refuses to build an offer without
a tenant slug rather than defaulting one.

### Refer-and-earn: the link is the asset

The offer's `referral_url` is the CTA, and `offerMeta()` already resolves
`destination_url || referral_url || application_url`. So an offer published without
the tenant's own referral link helps the marketplace for free.

Verified live (2026-10-31): `work.turing.com/dashboard/job_referral` loads
authenticated, but the referral link is **not in the DOM until you interact** —
`pickReferralUrl()` therefore returned `null`, and that refusal is the feature: a
guessed CTA would send a tenant's traffic nowhere.

Practical consequence: **don't scrape the link — inherit it.** The Writer's Flow
offer form already has a `referral_url` field (`POST /tenant/blogger/offers`), so
every link a tenant uses is already stored per offer. `resolveReferralUrl()` reads
that history and picks the newest link whose hostname matches the platform
(`turing.com` / `micro1.ai`), refusing cross-platform matches and lookalike domains
— so a Turing link can never land on a Micro1 page. A configured default is used
only when the tenant has no history, and only for its own host.

That is deterministic, needs no UI interaction, and needs no new secret.

`toOfferDraft()` maps a role onto the portal's own offer form: `offer_type: 'job'`
(so the existing career copy in `utils/contentJourney.js` applies to the referred
candidate), `status: 'draft'` (agent proposes, tenant publishes), the parsed rate as
`compensation_max` in USD, and `referral_url` from the tenant.

### Importing roles as draft offers

```bash
node scripts/browser_actor_collect.mjs --tenant <slug> --platform turing --out tmp/turing_roles.json
node scripts/browser_actor_import.mjs  --tenant <slug> --in tmp/turing_roles.json          # plan only
node scripts/browser_actor_import.mjs  --tenant <slug> --in tmp/turing_roles.json --apply  # write drafts
```

Offers are `opportunities` rows — the portal's own table (`POST /tenant/blogger/offers`
writes the same shape). Four properties hold, each pinned by a test:

- **`slug` is globally UNIQUE**, so it encodes tenant + source + role
  (`malingu-ventures-turing-project-lead-ai-training`). Two tenants finding the same
  role can never fight over one row, and a re-run resolves to the same slug.
- **Re-running creates nothing.** Existing rows are skipped (by slug, or by title for
  hand-made offers) and the planner has **no update path at all** — which is how a
  tenant's per-offer `referral_url` survives every subsequent run.
- **Every row is `status: 'draft'`.** Nothing publishes itself.
- **An unknown tenant slug writes nothing** and prints the slugs that do exist, so a
  typo is visible instead of silently creating orphan rows.

A newly discovered role arrives **without** a referral link, by design: each link is
unique per role. `attachReferrals()` fills in only what the tenant already holds for
*that specific role*, and reports the rest in `needsReferralLink` so the tenant can
paste them (the offer form already has the field).

### Per-role referral capture

A role's own link is read from the live session, one role at a time:

```powershell
node scripts/browser_actor_referrals.mjs --tenant malingu-ventures --limit 3   # plan only
node scripts/browser_actor_referrals.mjs --tenant malingu-ventures --from tmp/referrals.json --apply
```

This is a **click** on the tenant's logged-in account (`expand card → referral
bonus`), not a read, so it lives in its own script behind its own flag instead of
inside the collector. Default is plan-only; `--apply` attaches.

Rules, each pinned by a test:

- a link is accepted only when it carries a referral token (`?ref=`, `?code=`, `/r/`,
  `referr`, `invite`) **and** sits on the marketplace host. `/dashboard/job_referral`
  is never accepted, even though it contains the word "referral".
- `pickRoleReferralUrl` exists because `pickReferralUrl` — written for the
  tenant-level Refer & Earn page — *penalises* `/jobs` paths, which is exactly where
  a per-job link lives. Reusing it captured nothing, and said nothing.
- an offer that already has a link is a **conflict**, never an overwrite. The write is
  additionally guarded by `.is('referral_url', null)`, so a race with the tenant
  pasting a link by hand cannot clobber it.
- the same link may not land on two offers.
- a modal with no confident pick writes nothing and keeps its candidates in
  `tmp/referrals.json` — that is a human decision, not an agent's.

It needs the profile map, which is **not** in `.env` yet (earlier runs passed it
inline in the shell, so nothing was persisted):

```
BROWSER_ACTOR_PROFILES={"malingu-ventures":"<morelogin envId>"}
```

Without it the script stops with `profile_unmapped` and writes nothing — the
identity layer refuses to guess which browser belongs to which tenant.

#### What the live run proved (2026-10-31, P-4, roles 1-2)

The mechanism works end to end — profile started, listing rendered, cards clicked,
evidence written — but it captured **zero** links, and the reason is a fact about
the marketplace rather than a bug:

- Opening a role **navigates to a real per-role page**: `work.turing.com/jobs?jobId=112467`.
  The original adapter note ("no per-card href") was true of the card, wrong about
  the destination: clicking the rate badge exposes a stable `jobId`.
- **The job detail page has no referral control.** Every clickable on it was nav or
  a filter chip: `Toggle menu · Home · Jobs · Applications · Refer & Earn ·
  Complete Profile · All 226 · Priority 12 · …`. No "Apply Now", no "Referral
  bonus". So `turingDetailReferralExpr` correctly reported
  `no_detail_referral_affordance` for both roles.
- The per-job link is therefore expected to come from the **`Refer & Earn`
  dashboard** (`/dashboard/job_referral`), which is where the tenant mints links.
  That is the next slice, not a selector tweak.

Two bugs the run exposed and this fix closes:

- `turingOpenReferralExpr` returns `by`, but the runner read `opened.clickedBy`, so
  a click that definitely happened was recorded as `clickedBy: null`.
- `isListingPage` compared only the pathname, and `?jobId=…` keeps the pathname
  `/jobs`. So the runner believed it was still on the listing while reading a
  **detail page**, and would have kept clicking stale card indexes. It now treats a
  `jobId` as leaving the listing and navigates back between roles.

#### Where the link actually is (verified 2026-10-31, then working)

The job page **does** offer a referral — the first attempt missed it twice over:

1. The words "Referral Bonus · $750" are a **`<span>` label**. The clickable is
   `<button>Share & earn $750</button>`, which never says "referral".
2. The click opens a dialog titled *"Share this with your network"* **immediately**,
   but the readonly input holding the link is filled a beat later. Waiting only for
   `role="dialog"` read an empty box and reported a marketplace with no links.

The link, confirmed two independent ways (the input's value, and
`navigator.clipboard.writeText` hooked and then triggered by *Copy link*):

```
https://work.turing.com/r/<code>      e.g. r/xako-8LrQK
```

Two properties that shape every write:

- **Each role gets its own code** — `Project Lead → r/xako-8LrQK`,
  `Business Analyst → r/bpy0B4Jmoc`.
- **A link is stable per role.** It does not change when the page reloads or the card
  is clicked again (confirmed by the tenant, 2026-10-31). An earlier version of this
  file claimed Turing re-mints the code on every open, inferred from a mismatch in
  the database. That inference was **wrong**, and it was dangerous: it made a wrong
  link look benign, and the overwrite guard then preserved it.

#### Where a link really goes is checkable — so check it

`GET https://work.turing.com/r/<code>` renders a page whose `<title>` is the job, so
every link can be verified without a browser:

```
r/xako-8LrQK  -> "Project Lead - AI Training - Turing"                    matches
r/9PkwepYCFE  -> "Strategic Project Lead – Software Engineering - Turing"  WRONG JOB
```

That second link was live in production on the Project Lead offer, pasted by hand.
`utils/browserActor/referralVerify.js` resolves a link and judges it:

- pass on identical normalized titles, or when the page appends only known marketing
  tail words (`| Apply on Job` — Micro1 does this, and treating it as a mismatch
  failed 5 correct links);
- **never** pass on "one contains the other": `Project Lead - AI Training` and
  `Strategic Project Lead - Software Engineering` share a prefix, which is exactly
  how the wrong link got in.

The capture path now verifies every link before writing and refuses anything that
does not resolve to its role. `scripts/browser_actor_audit_links.mjs` runs the same
check across stored links: `11 checked → 10 match, 1 mismatch`, and the mismatch was
cleared and replaced with a verified one.

#### Provenance: which links are ours, and which are the tenant's

Verified 2026-11-01 against the live database:

| Marketplace | Links | Where they came from | Payee check |
|---|---|---|---|
| Turing | 71 | **us** — every row created by the importer on 2026-10-31, each carrying `external_id` = `turing:<role>` | 71 distinct `/r/<code>`, one per role |
| Micro1 | 5 | **the tenant** — created 2026-10-28…30, `external_id` null on all five | 1 distinct `referralCode` across all five: their own account code |

No Micro1 adapter exists, and the collector cannot write one:
`scripts/browser_actor_collect.mjs` refuses any platform other than `turing`, and
`utils/browserActor/tasks/` contains only `turing.js`. So nothing of ours has ever
touched those five links, and the run that produced the 71 could not have produced a
Micro1 URL.

`planCodeIntegrity()` checks the thing title-verification cannot: **does this link
pay the tenant?** A link can open the correct job while carrying someone else's
referral code, and then the tenant does the work and another account is paid.

- query codes (`?referralCode=`) are **account level** — repeats are normal, and a
  different code is a different payee, so it is flagged `foreign_code`;
- path codes (`/r/<code>`) are **per role** — a repeat means two offers claim one
  role, so it is flagged `shared_code`.

Both rules are decided by URL shape, not by code frequency: a first attempt guessed
"the most common code is the account" and immediately flagged all five Micro1 links as
duplicates of each other, which is exactly how correct account-level links look.


The audit records its verdict per offer (`link_verdict`, `link_checked_at` — see
`migrations/2026-11-01_add_referral_link_verification.sql`), so the coverage strip
can answer *"is any link wrong?"* without resolving 76 URLs on every page load:

- `76 links verified` — every stored link resolves to its own job.
- `1 referral link points at the wrong job` — leads the line, because this is the
  only number here that costs money while looking fine everywhere else.
- `N links not yet verified` — honest unknown, shown when the column is null or the
  migration is not applied. **Unknown is never rendered as healthy.**

`GET /api/agents/browser/referral-audit?tenant=<slug>` returns the same verdicts on
demand, and `GET /tenant/blogger/coverage` feeds the strip.






## Next steps, in revenue order

1. **Tender capture for one paying tenant** — smallest demo that closes a contract; wire `POST /capture` into the ABOSS worker and surface results in the tenant portal.
2. **Lead verification** — replace ABOSS's assumed contacts with a page-verified email/phone, from the tenant's own identity and geo.
3. **WhatsApp Web fallback** — for numbers where the Cloud API is not approved; the profile already carries the session cookies.
4. **Screenshots + evidence** — a tender PDF/screenshot is what a procurement buyer forwards internally.
5. **Move leases into Postgres** — only when a second server instance exists.


## Writer's Flow controls (2026-11-02)

The portal could show *outcomes* — coverage, link health — but nothing about the *work*:
no way to start a run, no way to watch one, and no way to act on a link that verification
had already proven wrong. The Writer's Flow section now has a **Collection control** panel,
per tenant, with three capabilities.

### The split that makes it honest

| Work | Where it runs | Why |
|---|---|---|
| **Verify links** | inside the HTTP request | One `GET` per link. No browser, so the tenant gets an answer in the same click. |
| **Capture / refresh** | on the operator's machine | The leased browser lives there. The portal records the *request* and shows the exact worker command. |

A page that cannot do something should say so rather than spin. A queued run reads
*"waiting for a runner"*; a run whose heartbeat is older than 5 minutes reads *"stopped
reporting"* — never *"running"*.

### Endpoints

```
GET  /tenant/blogger/writer-flow        funnel per marketplace, run history, next actions
POST /tenant/blogger/links/verify       { limit? }  verify now, write verdicts, log a run
POST /tenant/blogger/links/:id/resolve  { action: recheck | clear | accept }
POST /tenant/blogger/runs               { kind, limit, skip, refresh }  queue for a runner
POST /tenant/blogger/runs/:id/cancel
```

Every query is tenant-scoped in the query, never in a post-fetch check.

### The three rules the panel enforces

1. **Unknown is not healthy.** A link with no verdict is *unverified* (amber), not *ok*.
   A database without the runs table says *"run history unavailable"*, not *"no runs"*.
2. **A human decision outranks the robot.** `accept` writes `link_note = 'accepted by
   tenant'`, and the verifier skips those rows. Only an explicit *Check* retires the
   override — the tenant asking again is the only thing that clears it.
3. **Clearing keeps the reason.** `clear` nulls `referral_url` but stores
   `cleared by tenant: pointed at <job>`, so the audit trail outlives the wrong link.

### Run tracking

`browser_actor_runs` (see `migrations/2026-11-02_writer_flow_runs.sql`), one row per run:

- `queued -> running -> succeeded | partial | failed | cancelled`
- a **partial unique index** on `(tenant_id, kind) WHERE status IN ('queued','running')`
  means two operators on two machines cannot both claim one tenant's capture.
- the runner heartbeats every ~2s from `scripts/browser_actor_referrals.mjs`; a crash
  closes the row as `failed` rather than leaving it looking alive.

Worker hand-off:

```bash
node scripts/browser_actor_referrals.mjs --tenant <slug> --limit 120 --skip 0 --apply --run-id <uuid>
# or, without the id: --claim takes the oldest queued run for that tenant
```

### Tests

`npm run test:writer-flow` — 134 assertions covering the heartbeat/stall rules,
partial-vs-success, the one-active-run rule, the human-override rule, the funnel
arithmetic, the store's payloads (against an in-memory table), the endpoints over real
HTTP, and the not-yet-migrated deployment the production database is currently in.


## Micro1 adapter (2026-11-02) — the second marketplace, and what it proved

Turing's adapter assumed "no per-role URL, rebuild the listing between roles". Micro1
disagrees on every one of those points, which is why it is a separate runner rather than a
`--platform` branch.

### What the live dashboard actually does

```
page     https://refer.micro1.ai/opportunities/   "Referral dashboard | micro1"
grid     div.grid.grid-cols-1.lg:grid-cols-3      -> 12 cards
card     div.p-1.rounded-md.flex.flex-col         (no anchors anywhere)
           badges   "Posted Yesterday" / "New" / "High demand"
           h2       the job title          <- the only stable handle
           "micro1 1 Opening"
           skills   chips + "+N"
           pay      "Pay: $250,000 - $450,000/year"
           button   "Refer and earn $1,500"
click    does NOT navigate and opens NO dialog — it copies a share link:
           https://jobs.micro1.ai/post/<jobUuid>?referralCode=<accountCode>&utm_...
```

So, in three rules the code now encodes:

1. **Account code + per-role job id.** The same `referralCode` appears on all five links the
   tenant already owned; the job id is what changes per role. `pickMicro1ReferralUrl`
   therefore *refuses* a post URL with no `referralCode`: it opens the right job and pays
   nobody, which looks identical to success in a list of URLs.
2. **A real job page exists** (`jobs.micro1.ai/post/<uuid>`), so `destination_url` is the
   clean job page and `referral_url` is the coded one. A reader who is not the referred
   candidate never receives the tenant's code.
3. **The job body is client-rendered** — 48 KB of HTML, 57 characters of text, no JSON-LD.
   The description needs the browser, which is exactly what `CONTENT_EXTRACTORS.micro1` is.

### Two bugs the live run found (both would have shipped wrong links)

| Symptom | Cause | Fix |
|---|---|---|
| Two roles captured with **the same job id** | The share link field *persists*; a slow click meant the previous role's link was still on the page | Snapshot candidates **before** the click and accept only a link that is new, polled up to 5 s. No fallback to an existing link — another role's link is worse than none. |
| "Generalist" resolved to **"Music & Sound Annotation Expert"** | The share popover renders *inside the grid*, so card **indices shifted** after a click | Close the popover between roles and find the card **by title**, never by index. A duplicate-job-id guard runs as a backstop. |

Both were caught by `verifyReferralLink`, not by reading the capture file — which is the
argument for verifying before writing rather than after.

### Running it

```bash
node scripts/browser_actor_micro1.mjs --tenant <slug> --limit 12            # plan
node scripts/browser_actor_micro1.mjs --tenant <slug> --limit 12 --apply    # import drafts
  --only-missing        skip roles this tenant already has (do this by default)
  --no-descriptions     links only (much faster; bodies come from the job-page pass)
  --run-id <uuid>       report progress into browser_actor_runs for the portal
```

### The constraint that shapes the runner: one start is expensive

MoreLogin allows a fixed number of profile **starts per day**, and exceeding it fails the
start with *"The daily startup limit is exceeded"* — the same `19124` code as a genuine
start failure, which is why the message is matched rather than the code
(`classifyProviderFailure`). Two rules follow:

- **A failed start is classified before it is retried.** A quota failure is not
  retryable, so the run stops with the one instruction that helps rather than spending
  more of the allowance discovering the same thing.
- **A successful start must do all the work it can.** One navigation reads all 12 cards;
  the bodies come from the same session; `--only-missing` skips roles the tenant already
  owns; the report prints `alreadyImported` so a wasted start is visible.

Measured on the live dashboard: **12 cards, ~350 ms per link, ~2.2 s per body**. A verified
sample run produced 4/4 links `match` with bodies of 5,391 and 3,168 characters.



## Tenant-owned browser access (BYO MoreLogin, 2026-11-02)

The tenant brings their own MoreLogin account and profile, signs into Micro1/Turing **on
their own machine**, and hands Alphadome an API key. We never see a password or an OTP, so
"could an Alphadome employee log in as me?" is answered by architecture rather than policy.

### Why this shape

| | Hosted (operator's profiles) | BYO (this) |
|---|---|---|
| Custody of the session | ours | the tenant's |
| Password/OTP visible to us | during a remote login | never |
| Daily start quota | ours (OPEN_FLAGS #16) | theirs |
| Fingerprint / IP a marketplace sees | our proxies | their own machine |
| What we store | nothing | one sealed API key per tenant |

### The flow

```
tenant (5 min, their machine)     portal
  create MoreLogin account   →    Writer's Flow → Your own browser
  create one profile         →    paste the MoreLogin API key → Connect
  sign into Micro1/Turing         (profile list is read live from their account)
  inside that profile
                             →    Verify sessions  → "connected · micro1 + turing"
```

Endpoints (all tenant-session scoped):

```
GET  /tenant/blogger/browser-access            status + which profile a run would use
POST /tenant/blogger/browser-access/connect    { apiKey, envId?, label?, runtime? }
POST /tenant/blogger/browser-access/verify     start once, read each marketplace listing
POST /tenant/blogger/browser-access/disconnect
```

### What is stored, and what is never returned

`site_tenants.metadata.browserAccess`:

```json
{ "envId": "2116…", "runtime": "cloud", "label": "Acme Studio",
  "keySealed": "v1.<iv>.<tag>.<ct>", "keyFingerprint": "sha256:ab12…",
  "connectedAt": "...", "verifiedAt": "...", "verifiedPlatforms": ["micro1"],
  "reauthRequired": false, "reauthPlatforms": [], "lastCheckedAt": "..." }
```

- The key is **AES-256-GCM** sealed under `TENANT_SECRET_KEY`. Missing that env var ⇒
  connecting is refused with the variable named; nothing is stored in the clear.
- `publicAccessStatus` is the only shape a tenant sees: **no key, no ciphertext, no
  fingerprint**, and the profile id is masked.
- `disconnect` deletes the record and leaves the tenant's MoreLogin account untouched.

### Three rules the endpoints enforce

1. **A key may only bind a profile it owns.** `connect` reads the profile list live from the
   tenant's account; an `envId` outside that list is a 403, and an account with several
   profiles must choose (409 with the list).
2. **Runs prefer the tenant's own profile.** `resolveRunnerIdentity` order is
   tenant → hosted → default → refuse. A seal that will not open stops the run with
   `reconnect_required`; it never falls back to the operator's profile, because running as
   the wrong account is worse than stopping.
3. **"Verified" is evidence.** `verify` starts the profile once and reads each listing:
   cards ⇒ `signed_in`, a sign-in affordance and no cards ⇒ `login_wall` ⇒ written as
   `reauthRequired`. A check that could not run is a 502 and **never** becomes "signed out".

### Not yet verified live

The cloud attach path (`cdpUrl` → websocket) in `utils/tenantBrowserProvider.js` is written
against the documented contract but has not been exercised end-to-end: this host's plan is
out of daily starts (OPEN_FLAGS #16) and malingu-ventures runs a hosted **local** profile.
The first BYO tenant run is the test — everything pure is covered by
`npm run test:browser-access` (100 assertions), including the sealing, the masking, the
refusals, the resolution order and key rotation.

### The sealing key, operationally

`TENANT_SECRET_KEY` is the only secret this feature needs, and it has one rule that is easy
to get wrong: **the portal seals, the runner opens, so both must hold the same value.** A
mismatch is silent until a run starts and then reports `reconnect_required`, which looks
like the tenant's fault.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # generate
npm run secrets:check                                                     # verify this host
```

`secrets:check` prints the `sha256:` fingerprint of the configured key(s) and, per tenant,
whether their stored key opens — with `current`, with the **retiring** key, or not at all.
Compare the fingerprint in the Render log with the one on the operator machine; equal
fingerprints mean equal secrets, and neither side has to reveal it. Exit code is 1 if any
tenant cannot be opened, so it can gate a deploy.

Rotation is a three-step move, supported by `TENANT_SECRET_KEY_PREVIOUS`:

1. `TENANT_SECRET_KEY_PREVIOUS=<old>` and `TENANT_SECRET_KEY=<new>`, on the portal **and**
   every runner host.
2. Deploy. Old seals keep opening (the runner logs that the tenant is on the retiring key);
   new connects seal with the new key.
3. Once `secrets:check` reports zero on the retiring key, remove
   `TENANT_SECRET_KEY_PREVIOUS`.

Without step 3 the old key stays valid forever, which defeats the point of rotating.


### The tenant can start the capture themselves

Because a BYO profile is **cloud**, the browser is reachable from Render — so a tenant can
press a button instead of waiting for an operator:

```
POST /tenant/blogger/browser-access/capture   { platform: 'micro1', limit?: 12 }
  → 409 not_connected     no profile connected
  → 409 local_runtime     their profile runs on the operator machine, not in the cloud
  → 400 unsupported       only micro1 has a verified adapter
  → 409 already_running   one run at a time, enforced by browser_actor_runs
  → 202 { run }           a queued row + a spawned runner; the portal polls the row
```

The route does not run the capture inline: it queues a run, spawns the **same** script an
operator would run (`--tenant … --apply --only-missing --run-id …`), and answers 202. The
child's stdout goes to `tmp/run-<id>.log`, its report to `tmp/run-<id>.json`, and progress
lands in the run row the portal already polls.

Two consequences worth stating: the run costs one of the **tenant's** daily starts, and a
Render redeploy during a run kills the child — which is why the row records what happened
rather than leaving the tenant guessing. A durable job runner is the next step if this
becomes the normal path.



Every script that starts a browser now goes through `resolveRunnerIdentity({ supabase, tenantSlug })`:
`browser_actor_micro1.mjs`, `browser_actor_referrals.mjs` (Turing), `browser_actor_collect.mjs`, and
`browser_actor_inspect.mjs` (so an operator can debug a BYO tenant's profile). One resolver, one
order — tenant → hosted → default → refuse — instead of five copies that could drift.

Two deliberate exceptions:
- `browser_actor_probe.mjs` (the host doctor) keeps the env map: it tests *this machine's*
  MoreLogin install, not a tenant's account.
- `browser_actor_inspect.mjs` writes its debugging artifact by hand rather than spreading the
  identity object, because that object now carries the tenant's decrypted key and the artifact
  is a file on disk.



### When cloud browsing is not available: the tenant's own worker

A desktop MoreLogin profile can only be driven from the machine that started it, and its
debug port has no authentication — exposing it would hand anyone who finds the URL remote
control of a logged-in marketplace account. So there are exactly two ways a profile gets
used, and both are honest about where the browser is:

| Profile runtime | Who runs the capture | What the tenant sees |
|---|---|---|
| `cloud` | the portal (spawns the runner) | progress immediately |
| `local` | **the tenant's own machine** | `202 queuedForWorker`, then progress when their worker picks it up |

The local path, end to end — and note that the tenant never leaves the portal except to paste one line:

```
portal:  Capture now  → POST /browser-access/capture
                       → 202 { run, queuedForWorker: true, needsWorkerToken }   (no spawn; nothing to fake)
         "Queued for your worker — it starts as soon as your computer picks it up."
         (first time, no worker yet: "create a worker token below and start the worker there")

portal:  Create worker token → POST /browser-access/worker-token
                             → 201 { token, command, note: "not shown again" }
         the panel prints the command under a Copy button and warns once

tenant:  paste it into a terminal on the MoreLogin machine, leave it running:
         node scripts/browser_actor_worker.mjs --api https://… --token wkr_…
worker:  GET  /api/agent/runs              this tenant's queued/running rows
         POST /api/agent/runs/:id/claim    atomic: update … where status = 'queued'
         spawn scripts/browser_actor_micro1.mjs --run-id <id>   (the same path an operator uses)
         POST /api/agent/runs/:id/finish   counters → succeeded | partial | failed

portal:  "Run captures on your computer. last seen 2/11/2026, 14:02"     (or "never connected")
         Revoke wkr_ab12… (my computer)   ← one click, effective immediately
```

The panel states three things a tenant needs and nothing else: whether a worker exists, whether it
has ever checked in, and how to switch one off. "Last seen" is the field that separates "queued and
waiting for my machine" from "queued and nobody is listening" — the difference between patience and
a support ticket.

#### What the tenant actually downloads

`GET /tenant/blogger/browser-access/worker-bundle` streams a zip built **on demand from this repo's
own source files** (`utils/browserActor/workerBundle.js`), so a pilot never runs a stale artifact.
Thirty files, ~229 kb, and what is *not* in it is the point:

| Not in the zip | Why it matters |
|---|---|
| `.env`, service-role key, JWT | A tenant laptop must never hold a key that can write for **every** tenant |
| `TENANT_SECRET_KEY` | That key unseals *any* tenant's MoreLogin key; it cannot leave the server |
| a worker token | Typed by the tenant on their machine, saved as `worker-token.txt`, never transmitted to us |
| `node_modules`, any npm package | The browser layer is CDP + `ml-cli` directly, so there is nothing to install and no supply chain to audit |
| anything tenant-specific | The same zip is served to everyone |

The tenant's experience is three steps in the panel: *Download* → *Create a token* → double-click
`Start Worker.cmd` and paste it. `Start Worker.cmd` checks for Node.js and, if it is missing, says so
and gives the link rather than printing a stack trace. `worker-bundle/README.txt` is written for
someone who has never opened a terminal.

#### Agent mode: why the tenant machine never touches the database

Handing out a bundle that required `SUPABASE_SERVICE_ROLE_KEY` would have been the largest security
regression in this repo — one careless tenant screenshot and every tenant's data is writable. So the
privileged half of the capture moved to the server, behind the worker token:

```
tenant machine                                    portal
  GET  /api/agent/runs/:id/context     ───────►   resolves the tenant from the token, resolves the
                                                  profile, returns envId + the roles they already own
                                                  (never the MoreLogin key)
  POST /api/agent/runs/:id/progress   ───────►    counters + heartbeat
  spawns the same capture script,
  drives the local profile, reads pages
  POST /api/agent/runs/:id/result     ───────►   sanitises the payload, re-verifies every link,
                                                  plans + inserts offers, closes the run
```

`scripts/browser_actor_micro1.mjs` runs both ways from one file: with Supabase for an operator, and
with `--agent-api/--agent-token` for a tenant. `dotenv` and `@supabase/supabase-js` are imported
lazily so the bundled copy needs neither.

Rules that keep the new endpoints safe rather than merely convenient:

- **The tenant comes from the token**, never from the body — same as the claim path.
- **The context refuses anything but the tenant's own local profile.** A tenant worker cannot be
  pointed at the operator's hosted browser, and a cloud profile is refused with "press Capture again".
- **The result payload is untrusted input.** Titles and bodies are bounded, unknown fields dropped,
  and a `javascript:`/`file:` URL is discarded rather than stored and rendered later.
- **Every link is re-verified server-side** before it is attached, so a compromised worker cannot
  inject a link that pays somebody else.
- **A closed run cannot be written to** (409), so a retry cannot double-insert.
- **No MoreLogin key in the context.** A stolen `wkr_` token therefore buys the ability to burn that
  tenant's own daily starts — not control of their marketplace accounts.

Verified mechanically: the extracted zip runs in a temp folder with an **empty environment** (no
`SUPABASE_*`, no `TENANT_SECRET_KEY`, no `node_modules`) and stops with
`the portal refused this run (404)` — proving it loads, starts, and reaches the portal without ever
looking for a database.

Rules that make it safe rather than merely convenient:

- **The token is the tenant.** The tenant comes from the token row, never from the request,
  so a worker cannot claim another tenant's run however it shapes its body.
- **Hash-only storage.** A database leak yields no working credential; a lost token is
  revoked and reissued, not recovered.
- **Revocation is immediate**, and revoked tokens are refused even though the row stays for
  the audit trail.
- **Claim is a compare-and-set**, so two workers on two machines race safely: one wins, the
  other gets a 409.
- **Nothing runs on the tenant's machine they did not ask for**: the worker acts only on rows
  already queued in *their own* portal.

The worker adds an install step, so it is the fallback — not the default. Cloud tenants get
the button with no setup; a tenant whose plan has no cloud browser installs one command and
gets the same button.

### Source attribution (why the funnel said "Unattributed")

`migrations/2026-10-31_seed_micro1_turing_sources.sql` was **never applied**, so
`opportunity_sources` held only mercor and respondent and all 96 offers had
`source_id = NULL`. `scripts/backfill_offer_sources.mjs` fixes that as **data** (no DDL):
it creates the missing source rows and attributes offers only on concrete evidence —
the importer's own slug convention, or a referral link on the marketplace's own host.
Result: 83 attributed (78 Turing, 5 Micro1), **13 left alone** because they are hand-made
offers with no evidence. A guess there would have attributed somebody's own product to
Micro1.

