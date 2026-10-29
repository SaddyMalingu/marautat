# Sessions that survive a deploy, and hubs search can find

**Shipped:** 2026-10-29
**Surfaces:** `utils/tenantSession.js` (new), `server.js` (tenant auth), `routes/sitemap.js`, `routes/aiJobs.js`, `utils/aiJobsViews.js`, `utils/aiJobsService.js`
**Tests:** `npm run test:session-persistence` (34 checks), `npm run test:hub-discovery` (29 checks)

Both changes came out of reading one deploy log. Neither was on the roadmap; both
were visible in the log within ten seconds of reading it.

---

## 2. The hub was live, and invisible

Probing production on the same day:

```
GET /ai-jobs/t/definitely-not-a-tenant  -> 404 "Site not found"   (flag is ON)
GET /ai-jobs/t/malingu-ventures         -> 200, a real page
GET /sitemap.xml                        -> 316 <loc>: 299 blog, 0 hubs
GET /ai-jobs/                           -> 0 links to any hub
```

The hub is the page a client pays for and hands to prospects. It returned 200,
and no crawler had any path to it. Not in the sitemap; not linked from the site's
own landing page. Its only traffic could be a URL somebody typed or shared.

**The fix, in three places:**

1. `getActiveSiteTenants()` in `utils/aiJobsService.js` — there was no way to ask
   "which tenants exist", only "give me this one slug".
2. `routes/sitemap.js` emits each hub and its offer pages
   (`/ai-jobs/t/<slug>`, `/ai-jobs/t/<slug>/o/<offer>`), gated on
   `AI_JOBS_MULTITENANT` so the sitemap can never advertise a 404 on a host where
   the routes are off. Wrapped in `try/catch`: a deployment without `site_tenants`
   logs a warning instead of returning a 500 for the whole sitemap.
3. `renderAiJobsLanding(categories, sources, tenants)` renders a "Businesses on
   Alphadome" section linking every hub, and `routes/aiJobs.js` passes the
   tenants only when the flag is on. Tenant names are HTML-escaped and slugs
   URL-encoded — a client controls its own business name, so that name is
   untrusted input on a public page.

The two-argument call still renders (the section simply does not appear), so
nothing that already called the renderer breaks.

---

## Commercial frame (Alphadome operating rules)

- **Target buyer:** the four live tenants — Malingu Ventures and the rest of the
  founder's plan — and every discovery lead the same approval flow converts.
- **Workflow solved:** (a) "why do I have to log in again every time you ship?"
  and (b) "I shared my page, is anyone else able to find it?"
- **Reused:** the existing tenant session, cookie and portal-token machinery; the
  existing sitemap generator; the existing hub views and `getOffersByTenant`.
  Nothing new was invented that already existed.
- **Minimal slice:** one new pure module, one service query, two routes wired, one
  optional argument on a renderer. No migration, no new environment variable, no
  page in the corpus re-rendered.
- **Revenue impact:** sessions are retention hygiene — a client bounced out of
  their portal while reading their own numbers is a client who wonders what they
  are paying for. Hub indexation is acquisition: the pages already exist and
  already convert; they were simply not discoverable.
- **Main risks:** (1) stateless tokens cannot be recalled across a restart, so
  logout relies on TTL for tokens copied off a device before a deploy; (2) the
  sitemap now depends on `site_tenants` being readable, which is handled but is a
  new failure path; (3) if `AI_JOBS_MULTITENANT` is ever flipped off, hub URLs
  vanish from the sitemap while search consoles slowly drop them — expected, but
  worth knowing before flipping the flag.
- **Next validation:** deploy, then (a) sign in, deploy again without signing out,
  and confirm the portal still opens; (b) `curl https://alphadome.onrender.com/sitemap.xml | grep -c '/ai-jobs/t/'`
  should be ≥ 1; (c) open `/ai-jobs` and confirm the businesses section links to a
  hub that returns 200. Then submit the sitemap in Search Console and watch
  coverage over the following week.

## 1. Every deploy signed every client out

The log, unedited:

```
19:24:57  ==> Running 'node server.js'
19:24:58  GET /tenant/analytics 401
19:24:58  GET /tenant/writers-flow/analytics 401
19:24:58  GET /tenant/attribution 401
19:25:07  POST /tenant/session/login 200
```

The cause was one line — `const tenantSessions = new Map()` in `server.js`. On
Render a deploy is a new process, the Map boots empty, and a session issued
minutes earlier no longer exists. Every signed-in client was bounced to the
sign-in form mid-session, every time.

**The fix:** a token that carries its own session, `v1.<payload>.<hmac>`.

```
payload = { t: tenantId, p: phone, n: name, e: expiresAt, j: jti }
token   = 'v1.' + base64url(json) + '.' + base64url(hmac_sha256(secret, body))
```

The server validates a token it has never stored, because the signature is
checked rather than a memory lookup. The payload is public — the same values the
login response already returned — and the HMAC is what makes it unforgeable.

### What was deliberately not changed

| Property | Status |
| --- | --- |
| TTL | unchanged: `TENANT_SESSION_TTL_MS`, 8 hours by default |
| Cookie | unchanged name `td_session`, `HttpOnly`, `SameSite=Lax`, `Secure` behind the proxy |
| Tenant still active | unchanged: every data route re-reads the tenant from `bot_tenants` via `tenantSiteFromSession`, so a deactivated client loses access immediately regardless of token |
| Logout | unchanged in effect on the instance that logs out; the token is added to an in-process revocation map |
| Same-process sessions | unchanged; the Map is still consulted first |
| Environment | **no new variable required** — the key falls back to `TENANT_DASHBOARD_PASS`, which the portal already refuses to serve without |

`TENANT_SESSION_SECRET` overrides the key if you want session signing separated
from the dashboard password. Rotating either value signs everyone out once — the
same trade as a password change, and the only one available to a stateless token.

### The honest limitation

A token cannot be recalled from a process that has already restarted. Logout is
immediate on the instance that served it; a token copied out of a browser before
a deploy stays valid until its 8-hour expiry. If that is not acceptable for a
particular client, the next step is a `tenant_sessions` table with a revocation
column — a migration and two queries, no redesign.
