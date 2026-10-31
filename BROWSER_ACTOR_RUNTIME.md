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

## Next steps, in revenue order

1. **Tender capture for one paying tenant** — smallest demo that closes a contract; wire `POST /capture` into the ABOSS worker and surface results in the tenant portal.
2. **Lead verification** — replace ABOSS's assumed contacts with a page-verified email/phone, from the tenant's own identity and geo.
3. **WhatsApp Web fallback** — for numbers where the Cloud API is not approved; the profile already carries the session cookies.
4. **Screenshots + evidence** — a tender PDF/screenshot is what a procurement buyer forwards internally.
5. **Move leases into Postgres** — only when a second server instance exists.

