# Tenant portal — the client's own name, legible copy, Writer's Flow analytics

**Surface:** `admin/tenant_dashboard.html` (served at `/tenant-dashboard`, auth-gated)
**Backend:** `server.js` → `GET /tenant/writers-flow/analytics`
**Test:** `npm run test:tenant-branding` → `scripts/test_tenant_branding_analytics.mjs` (71 checks)
**Shipped:** 2026-10-27, three changes requested from a live demo of the four tenant links.

---

## 1. The header wears the client's business name

**Before:** every tenant saw `Tenant Portal` in the topbar; their own name sat in the
small grey slot on the right.

**After:** the topbar reads `joska Sportiff Academy`, `Malingu Ventures`,
`lifeline Inc.`, `Canary Onboarding` — whatever that client typed into the discovery
form. The tab title follows (`Scan to Pay · Malingu Ventures | Alphadome`) and so does
the sign-in card.

**Where the name comes from — nothing new had to be stored.** `POST /discovery` saves
`business_name`; approval writes it to `bot_tenants.client_name`
(`server.js:15663`); every session response already returned it as `tenant_name`
(`tenantSessionPayload`), and `/tenant/session/me` rehydrates it after a reload. The
page had it in `S.name` all along and spent it on a 0.88rem grey span.

**Implementation.** `tenantBrand()` → `applyBrand()` is the only writer of the three
surfaces (brand, sign-in title, `document.title`), called from `showApp()` and
`showLogin()`. Text is set with `textContent`, so a business name can never inject
markup. The phone number moved from being the second copy of the name to the small
slot (`+254 706 291 262`), and on phones it is hidden entirely — the name matters
more, and the number is on Profile and in every WhatsApp message the client received.

**Measured regression, fixed in the same commit.** A grid track declared `1fr` is
really `minmax(auto, 1fr)`, and that `auto` floor is the min-content width of the
widest item in the column — the topbar. With a real name in it the floor became
431px at a 360px viewport, so the whole document scrolled sideways:

| 360px viewport | document scrollWidth | name shown |
| --- | --- | --- |
| before the header change | 345px | n/a (`Tenant Portal`) |
| name added, `1fr` track | **431px** (sideways scroll) | `joska Sport…` |
| name added, `minmax(0, 1fr)` | 345px | `joska Sportiff Academy` |

`@media (max-width: 1023px) { .app-shell { grid-template-columns: minmax(0, 1fr); } }`
removes the floor so the header truncates instead of stretching the page. Below 479px
the word "Logout" collapses to its icon (still `aria-label="Log out"`, still a 40px
target) to hand ~40px back to the name. A 320px phone ellipsises by ~11px; 360px and
up show the full name. Verified in headless Chrome at 320/360/375/430/768/1024.

---

## 2. Muted copy is legible — measured, not eyeballed

**Complaint:** "Collect payments for your products and offers…" (Scan to Pay) and the
Writer's Flow voice explainer were "almost invisible".

**Cause:** both are `<p class="text-muted">`, and Bootstrap 5.3 paints that class
`#6c757d` **with `!important`**, so the page palette never reached them. On
`--bg-card` (`#181c2f`) that is **3.4:1** — below WCAG AA for body text, and hopeless
on a phone in daylight.

**Fix, in the page's own stylesheet (which loads after the Bootstrap `<link>`):**

```css
.text-muted, .text-body-secondary, .text-secondary, .form-text { color: var(--text-muted) !important; }
```

A later rule with the same `!important` wins, and the palette is back in charge. The
muted tone itself moved `#7c8db0` → `#8b9ac0`, because 4.98:1 passes on paper but still
reads as faint:

| surface | before (`#7c8db0`) | after (`#8b9ac0`) |
| --- | --- | --- |
| `--bg-main` `#0f1117` | 5.66:1 | **6.72:1** |
| `--bg-card` `#181c2f` | 5.05:1 | **6.00:1** |
| `--bg-sidebar` `#13162a` | 5.35:1 | **6.36:1** |
| Bootstrap's `#6c757d` on `--bg-card` — the reported state | **3.59:1** | n/a |

Body copy (`--text-light`) stays at 12.1:1, so hierarchy survives. The test recomputes
all three ratios from the palette with the WCAG formula, so a future "nicer" grey
cannot quietly fail AA.

---

## 3. Writer's Flow analytics, per tenant

**The gap:** the owner's `/admin/ai-jobs` page reports page views, clicks, CTR, posts
this week, recent runs and top pages — for the whole platform. The tenant portal's
Analytics section reported WhatsApp conversations only, so a client paying for the
traffic engine could not see a single number about the pages it wrote for them.

**The endpoint:** `GET /tenant/writers-flow/analytics?days=30` (`tenantSessionAuth`).

Everything is derived from rows the tenant already owns, so **there is no migration**:

| number | source |
| --- | --- |
| offers | `opportunities` where `tenant_id = site_id` |
| pages, published, words, avg words | `blog_posts` for those offer ids (`content` is counted, never returned) |
| views, clicks, CTR | `analytics_page_views` / `analytics_clicks` where `page_path = '/blog/<their slug>'` |
| series (14 days), top countries | the same view rows, bucketed by day and `country` |
| recent pages | the tenant's newest `blog_posts.created_at` |

Isolation is structural, not a filter added afterwards: the page-path list is built
from the tenant's own slugs, and a row whose path is not in that map is dropped
(`if (!page) return;`). There is no query in the handler without a tenant filter.
The list is asked for in batches of 100 because PostgREST caps IN lists. A deployment
without `blog_posts` or the analytics tables answers with zeros plus a `note`
explaining what is missing, rather than a 500 on the section.

**The screen:** inside Analytics, under the existing conversation panels —
8 headline cards (pages written, live pages, page views, clicks, CTR, words, offers,
new pages this week), a *Top performing pages* table (views / clicks / CTR, each title
linking to the public page), a *By offer* rollup, a 14-day views chart, and the newest
pages. The `/admin/ai-jobs` shape, scoped to one client. A tenant with no pages yet
gets a call to action into Writer's Flow instead of a grid of zeros; a failed load
says so rather than showing zeros.

**Response shape**

```json
{
  "ok": true, "period_days": 30,
  "site": { "name": "joska Sportiff Academy", "slug": "joska" },
  "public_path": "/ai-jobs/t/joska",
  "totals": { "offers": 2, "pages": 9, "published": 9, "words": 8100,
              "avg_words": 900, "views": 64, "clicks": 11, "ctr": "17.2",
              "pages_this_week": 9 },
  "pages": [{ "slug": "…", "title": "…", "status": "published", "words": 900,
              "views": 40, "clicks": 8, "ctr": "20.0", "url": "/blog/….html" }],
  "offers": [...], "recent": [...], "series": [...], "top_countries": [...], "note": null
}
```

---

## Verification

| what | how | result |
| --- | --- | --- |
| new behaviour | `node scripts/test_tenant_branding_analytics.mjs` | 71 checks, 0 failed |
| no regressions | portal 114 · voice 23 · scan-pay 153 · discovery 122 · admin console 23 · landing 53 · blog-html 18 · blog-quality 15 · share-card 15 | 536 checks, 0 failed |
| rendering | headless Chrome, real page, stubbed API, at 320/360/375/430/768/1024 | brand reads in full ≥360px, muted 6.72:1, `realOverflow 0`, drawer still `fixed` 295px/`overflow-y:auto` |

The suite runs the helpers, not just greps them: `applyBrand()` is executed against a
fake DOM (name painted, phone formatted, fallback honest) and `wfAnalyticsHtml()` is
called with a failed load, an empty account, a populated account and a hostile page
title (which must come out escaped).

---

## Commercial frame (Alphadome operating rules)

- **Target buyer:** the four live tenants on the founder's plan — Joska Sportiff
  Academy, Malingu Ventures, Lifeline Inc., Canary Onboarding — plus every discovery
  lead the same approval flow converts.
- **Workflow solved:** "whose portal am I in, why is half the copy unreadable, and what
  did the traffic engine actually deliver for me this month".
- **Reused:** the discovery → approval → `bot_tenants.client_name` chain, the session
  payload, the tenant-scoped Blogger graph, `analytics_page_views`, the existing
  `.stat-card` / `.panel` / `.table-scroll` components. Nothing new was built that
  already existed.
- **Revenue impact:** retention and renewal. A client who cannot see their own name or
  their own traffic numbers has no evidence the retainer is working; both are now on
  the first screen they open.
- **Main risks:** (1) `blog_posts.content` is read to count words, capped at 200
  posts, so a very large tenant sees words for the newest 200 pages only;
  (2) a page whose CTA points straight at the provider cannot have its clicks
  counted here — the provider answers that click, not this server — which is why
  the endpoint returns `clicks_note` and the section prints it (see below).
- **Next validation:** open `/tenant-dashboard?t=…` on a signed-in phone, confirm the
  header shows the business name, read the Scan to Pay and Writer's Flow sentences
  without squinting, and check Analytics shows that tenant's pages with their real
  view and click counts.

---

## Traffic that was never counted (2026-10-29)

Two gaps made the CTR figure — the one number that tells a client the writing
works — impossible to move:

**1. Clicks were never written.** `trackClick()` existed in `utils/analytics.js`
and had **no caller anywhere in the repository**. `analytics_clicks` was therefore
always empty, and every tenant's CTR was `0.0%` by construction, however well the
pages converted. The fix is one line in `/ai-jobs/apply/:id`, the only place that
sees both the reader and the page that sent them:

```js
trackClick(pagePathFromReferrer(req, '/ai-jobs/apply'), 'apply', req).catch(() => {});
```

`pagePathFromReferrer` (`utils/analytics.js`) accepts a referrer only when it is
same-host and one of the two shapes this site publishes (`/blog/<slug>`,
`/ai-jobs/t/<slug>[/…]`), so a stray or spoofed referrer cannot invent traffic on
a page the tenant owns. Anything unattributable is recorded as `/ai-jobs/apply` —
it counts for the platform, and is credited to nobody.

**2. Hub traffic was invisible.** `/ai-jobs/t/<slug>` recorded views only in
`opportunity_events`, which this portal does not read, so the one page a tenant
actually promotes showed zeros. All three tenant routes now also write the visit
to `analytics_page_views` under its real path, and the endpoint reports it as a
separate `hub` object (`views`, `clicks`, `ctr`) matched on the path prefix so the
hub's offer and category pages count too.

Hub figures are reported **beside** the pages, never folded into them: one is the
page the tenant hands out, the others are what search finds, and adding them
together would hide which is working.

**3. A zero now explains itself.** When views exist and clicks are zero, the
endpoint returns `clicks_note` and the section prints it:

> Page views are counted on every page. Clicks are only counted when the button
> goes through this site — a page whose offer links straight to the provider
> shows 0 clicks here even if readers clicked it.

That sentence is the difference between "the blog does not convert" and "we could
not see this click", and only one of those is true.

**Coverage limit, stated plainly:** pages whose CTA points at the provider
(`destination_url` / `referral_url`) are not measurable by this server. Making
them measurable means routing every CTA through `/ai-jobs/apply/<id>`, which
changes `ctaTarget()` in `utils/ctaBlock.js` and therefore re-renders the page
frames of the corpus (`content` untouched). That is a deliberate, separate
decision — not something to slip into a measurement fix.

Tests: `npm run test:tenant-branding` (95 checks, including the parser run
against real referrers) and `test_analytics_tracking.mjs` (20 checks, including
the real click line lifted out of `routes/aiJobs.js` and executed against a mock
Supabase).

