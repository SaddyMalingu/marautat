# Tenant onboarding — how a new client gets in, and what they can do

**Status:** working end to end as of 2026-10-25, after the `ensureAlphadomeTenant`
guard. Read this before demoing "we can onboard you".

## The one rule

A tenant is **one identity with two shells**:

| Where | What it is | Who uses it |
|---|---|---|
| `public.bot_tenants` | real table, portal credentials (`portal_token`, `status`) | `/tenant/session/login`, session cookie |
| `alphadome.bot_tenants` | real table, same `id`, WhatsApp + AI + SMTP credentials | webhook lookup, `get_tenant_by_wa`, `get_catalog` |

Everything else in `public` named `bot_*` is an **auto-updatable view over
`alphadome`**, so the portal can read and write the bot's tables without knowing
the schema exists. Those tables carry
`bot_tenant_id … REFERENCES alphadome.bot_tenants(id)`.

**Therefore: a tenant that exists only in `public` can log into the dashboard
and cannot save a single product, FAQ or order.** PostgREST answers `23503
foreign_key_violation`; the reads just look empty, so the failure is silent
until someone tries to save.

## The chain, step by step

1. **Discovery form** — `GET /discovery` → `public/client-discovery-form.html`,
   posts to `POST /discovery`. Required: name, email, phone, business_name,
   industry, team_size, whatsapp_usage, revenue_target, ownership_interest,
   timeline, budget. Stored in `public.discovery_submissions`; falls back to
   `logs/discovery_submissions.jsonl` if the table is unavailable. The phone is
   normalised to `2547XXXXXXXX` on the way in.
2. **Owner approval** — `POST /admin/api/discovery/submissions/:id/approve`
   (`x-admin-key`). Refuses a submission without a usable Kenyan mobile, mints a
   `portal_token`, creates or updates the tenant, and **now also guarantees the
   `alphadome` twin** (`ensureAlphadomeTenant`). Idempotent: an already-approved
   card returns the same link instead of minting a new one.
3. **Invite** — `POST /admin/api/tenants/:tenantId/portal-link` issues/rotates
   the same kind of token for tenants that never came through the form
   (Kassangas, manual adds). Response includes `portal_url`
   (`/tenant-dashboard?t=<token>&phone=<phone>`), a `wa.me` hand-off and the
   message text. `catalogue_warning` is `null` when healthy — a string means the
   invite works but the catalogue cannot be saved yet.
4. **Sign-in** — `POST /tenant/session/login` with `{ key: <token> }`. The token
   identifies one tenant; a different `tenant_phone` is refused 403. Session
   lives in an HttpOnly cookie (`/tenant/session/me` rehydrates it).
5. **Dashboard** — `/tenant-dashboard` (`admin/tenant_dashboard.html`), gated by
   `tenantDashboardAuth`. Features and the table each one actually writes:

| Tab | Endpoint | Backing data |
|---|---|---|
| Product Catalog | `/tenant/catalog` | `public.bot_products` → `alphadome` (FK ← twin) |
| Orders | `/tenant/orders` | `public.bot_orders` → `alphadome` |
| Bot Training | `/tenant/training` | `public.bot_training_data` → `alphadome` |
| Bot Config | `/tenant/bot-settings` | **`alphadome` by phone** (404 if no twin) |
| SMTP | `/tenant/smtp` | `public.bot_tenants` (mirrored) |
| Writer's Flow → Research & Outreach | `/tenant/wf/campaigns` | `public.wf_campaigns` (`tenant_id`) |
| Writer's Flow → Blogger | `/tenant/blogger*` | `public.site_tenants` + `opportunities` + `blog_posts` |

Writer's Flow is the one surface that is **entirely public**: it lazily creates
`public.site_tenants` from the tenant's `client_phone`. It works for a tenant
with no `alphadome` row — which is exactly how the half-tenant bug survived a
dashboard review.
6. **WhatsApp** — a client is *reachable* only once
   `whatsapp_phone_number_id` (primary) or `client_phone` (fallback, exact
   string) resolves. The twin is born with `whatsapp_phone_number_id =
   "pending:<uuid>"` and an empty token, so nothing can route to it and every
   check reads "not configured". Entering the real Meta phone id + token in Bot
   Config writes `public`, and `bot_tenants_mirror` copies it onto `alphadome`
   (NULL never overwrites).

## What the guard does

`ensureAlphadomeTenant(row)` in `server.js`:

- looks the twin up by `id` first — **no-op when it exists**, so live credentials
  are never overwritten by a second invite;
- otherwise inserts `alphadome.bot_tenants` with the same uuid, the normalised
  phone, `is_active` copied, and `metadata.awaiting_whatsapp = true`;
- on `23505` (phone already held by a different uuid) it refuses and names the
  row to merge, instead of splitting the identity further.

`insertBotTenantRecord` mints the uuid itself and calls the guard **before** the
public insert, so a phone already claimed in `alphadome` fails with nothing
half-created; a failed public insert releases the reservation.

## Verify it (no database client needed)

```bash
node scripts/test_discovery_approvals.mjs        # 122 static checks, incl. birth order
node scripts/test_smoke_tenant_onboarding.mjs    # stubbed end-to-end, incl. FK failure case
node scripts/smoke_tenant_onboarding.mjs --key=<ADMIN_PASS> --tenant=<name> --issue --write
```

`--write` saves one training row through the dashboard API and deletes it again,
which is the only check that proves the foreign keys are satisfiable for that
tenant. A public-only tenant fails it with `23503`.

## Open gates (2026-10-25)

- **Coach Dawn** `cfc89b88…`: no catalogue, no `whatsapp_phone_number_id`;
  `_04_coachdawn.sql` is written and dry-run clean but **not applied**. Until it
  runs, an invite to her reports `catalogue_warning` (phone held elsewhere) or
  creates a twin with no products.
- **Kassangas** `portal_token` is NULL — no invite has been issued yet. Run the
  portal-link call above.
- Issuing an invite **rotates** the previous link. Tell the client when you do it.
