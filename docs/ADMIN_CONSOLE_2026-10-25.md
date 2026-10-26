# Super admin console — repair and refresh

Date: 2026-10-25
Surface: `admin/dashboard.html` (served at `/admin?key=<ADMIN_PASS>`)
Owner-facing impact: the console the operator uses to approve paying clients.

## What was actually broken

The console looked "fine but dated". It was not fine. Three defects were live:

1. **144 lines of markup and JavaScript sat above `<!DOCTYPE html>`.**
   A dashboard card block (`governanceCard`, `revenueLabCard`,
   `tenantSuccessCard`) plus their `fetch*` handlers had been pasted at the top of
   the file instead of inside the page. That has two effects:
   - the browser drops into **quirks mode**, which silently changes box sizing,
     table layout and font metrics across the whole console;
   - the JavaScript was outside any `<script>` tag, so it rendered as **visible
     source text** at the top of the page.
   None of the three cards existed anywhere else in the file, so the features were
   simply lost — the endpoints behind them (`/admin/api/policies`,
   `/admin/api/audit/actions`, `/admin/api/revenue-lab`,
   `/admin/api/tenant-success`) were all working and unused.

2. **A client's Submit took 121 seconds.** Measured on the live deployment with
   `scripts/canary_tenant.mjs`: `submit took 121222ms`. `POST /discovery` awaited
   the team notification and the client acknowledgement *before* responding, and
   Render drops outbound SMTP, so nodemailer sat out its full two-minute connect
   timeout. A prospect who waits two minutes assumes the form is broken.

3. **The phone drawer was a hand-copied second nav.** Eight links duplicated in a
   different order from the desktop list. The two had already drifted.

## What changed

### Structure
- Removed the 144 orphaned lines. `<!DOCTYPE html>` is line 1 again.
- The three lost cards are back, inside the dashboard render, wired to
  `loadGovernanceWidget()` / `loadRevenueLabWidget()` /
  `loadTenantSuccessWidget()` and called from `loadDashboardWidgets()` after
  `bindDashboardActions()`. Each card fails soft: `Unavailable`, not a blank box.
- The duplicate "Welcome to the Alphadome Admin Portal" block is gone; the hero
  at the top of the page already says it.
- The phone drawer now mirrors `#sidebarNav` at runtime, so the two cannot drift.

### Visual system
A v2 layer appended to `<style>` (late on purpose, so it overrides the older
per-component rules without rewriting them):
- One token set: `--ink-1/2/3`, `--panel`, `--line`, `--brand`, `--ok/warn/bad`,
  `--r-sm/md/lg`, `--shadow-1/2`, `--ring`, `--ease`.
- Sticky blurred top bar; the sidebar logo is no longer repeated at 2rem.
- Sidebar grouped into Start / Clients / Catalogue / Operations with an active
  pill and a pending-approvals badge (`[data-nav-badge]`).
- Cards became a real `auto-fit` grid. The old rule was
  `flex: 1 1 220px; max-width: 340px`, which left dead space on wide screens and
  made the four discovery counters look like four enormous panels.
- Card titles are now labels (uppercase, 0.74rem) and values are the hero
  (1.85rem, tabular). Hover is a 2px lift, not a `scale(1.03)`.
- Shared surfaces (`.ops-empty`, `.form-control`, `.btn`, `h2`) restyled once.
- `:focus-visible` ring, `prefers-reduced-motion` opt-out, dark scrollbars.

### Discovery approvals (the revenue surface)
- Filter is now chips with counts instead of a `<select>` nobody reads.
- One function, `setDiscoveryFilter()`, owns the filter state. Before, the chips,
  the list and the post-approval jump each mutated `discoveryState.filter`
  independently.
- The pending count is mirrored into the sidebar badge from the same `counts`
  object the page renders.
- Submission cards use `disc-card is-new|approved|rejected` (a coloured left
  rule), a `disc-facts` grid instead of a run-on list of `label: value` lines,
  and a dedicated `.disc-invite` panel for the portal link.
- Empty states are per-filter and say what to do next.

### Latency fix
- `notifyDiscoverySubmission()` now runs **after** `res.json()` (a `void` call).
  Persistence still happens before the response; only the courtesy notification
  moved.
- Every notification is bounded: Slack gets `{ timeout: 15000 }`, each SMTP send
  is wrapped in `withTimeout(..., 15000, label)`.
- The approval email is bounded at 12s and reports
  `email_error: "... timed out after 12000ms"` while still returning the link, so
  the operator sees "send it on WhatsApp" instead of a hung request.

## Verification

```
node --check server.js                      clean
scripts/test_discovery_approvals.mjs        122 passed, 0 failed
scripts/test_smoke_tenant_onboarding.mjs     12 passed, 0 failed
scripts/test_bot_schema_reconcile_sql.mjs    94 passed, 0 failed
scripts/test_tenant_merge_sql.mjs            63 passed, 0 failed
scripts/test_site_hygiene.mjs                16 passed, 0 failed
```

Document structure after the edit: 4626 lines, `<script>` 3/3, `<style>` 1/1,
`<div>` 723/723, `<!DOCTYPE html>` on line 1.

## The tool that proved it

`scripts/canary_tenant.mjs` creates one throwaway tenant through the real path
(public questionnaire -> owner approval) and asserts the result:

```
node scripts/canary_tenant.mjs --base=<url> --key=<ADMIN_PASS>
```

It prints the submit latency, the tenant id and `catalogue_warning`, then hands
you the exact follow-up:

```
node scripts/smoke_tenant_onboarding.mjs --base=<url> --key=<PASS> --tenant=<phone> --issue --write
```

Live run against the pre-fix deployment: `submit took 121222ms`,
`catalogue_warning` **absent** (old code), tenant `656831d8-…` created. Keep that
tenant as the permanent regression tenant; do not delete it.

## Still open

- Render must rebuild from `main` before any of this is live. `catalogue_warning`
  missing from an approve response is the tell that the old build is serving.
- After the rebuild, re-run the canary: submit should return in well under 5s and
  `catalogue_warning` should be `null`.
- Tenant `656831d8-…` was born under the old code and may be `public`-only.
  `--issue` repairs it through `ensureAlphadomeTenant()`.
- Kassangas (`0702245555`) still has no `portal_token` — no invite has been sent.
