# Tenant Portal — responsive shell for every device

**Surface:** `admin/tenant_dashboard.html` (served at `/tenant-dashboard`, auth-gated)
**Test:** `npm run test:tenant-portal` → `scripts/test_tenant_portal_mobile.mjs` (114 checks)
**Owner of the behaviour:** the `RESPONSIVE SHELL` block in the page's last `<script>`

> **2026-10-27 — the header is now the client's business name.** That made the
> topbar's min-content wider than a phone, and because the shell track was declared
> `1fr` (= `minmax(auto, 1fr)`) the whole document grew to 431px at a 360px viewport.
> The drawer breakpoint now uses `minmax(0, 1fr)`, the phone number is hidden below
> 480px and the word "Logout" collapses to its icon, so the name reads in full.
> Details, measurements and the analytics change: `docs/TENANT_PORTAL_BRANDING_ANALYTICS.md`.

## Target buyer and workflow

A merchant — a shop owner with a phone, not a laptop — opens the portal from a
WhatsApp link in the afternoon to check today's numbers, create a Scan to Pay
link, and see which customers owe money. Before this change that page assumed a
1440px monitor: on a phone the section list was a drawer with no scrim, no close
button and no scroll lock, tables pushed the whole document sideways, and a reload
always threw the merchant back to the dashboard.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Breakpoints | permanent 240px rail above 768px | drawer below 1024px, sticky rail above |
| Drawer | `.open` class only | scrim, Escape, leftward flick, scroll lock, focus return, `aria-expanded` |
| Sections | 30 rows, no search | filter box that also hides emptied group headings |
| Tables | loose `<table>`s widened the page | every table gets its own horizontal scroller |
| Forms | 14px `.form-control-sm` → iOS zoom | 16px on phones, so the page never zooms under the thumb |
| Inputs/taps | ~40px rows, 32px buttons | 46px nav rows, 40px buttons, 34px small buttons |
| Deep links | none | `#/section` — reload keeps the section, Back walks through sections |
| Viewport | `100vh` (jumps under mobile toolbars) | `100dvh` with a `100vh` fallback |
| Notches | ignored | `env(safe-area-inset-*)` on the WhatsApp bubble and content padding |
| Wide screens | content stretched to 2400px | `#spa` capped at 1440px, 264px rail above 1440px |
| Keyboard | nav rows were `<div>`s | `role="button"`, `tabindex`, Enter/Space, `aria-current`, focus ring |

## Why these choices

- **1023px, not 767px.** A 768px tablet with a permanent 240px column leaves 528px
  for six-column tables. The drawer gives it the whole width.
- **Tables get a wrapper, not `display:block`.** Bootstrap's `.table-responsive`
  wrappers are respected; only loose tables are wrapped, and only tables with four
  or more columns get a 560px minimum width, so a three-column table still fits.
- **The filter lives in the drawer.** It is the cheapest way to make 30 rows usable
  with a thumb; group headings disappear when their rows do.
- **`#/section` in the URL.** `history.pushState` on a nav click, `replaceState` on
  a programmatic render, `hashchange` re-enters `go()`. This is what makes the
  Android back button behave like an app instead of throwing the merchant out.
- **Nothing was rebuilt.** The same `go()`, the same renderers, the same Scan to
  Pay screen; the shell around them grew the missing states.

## Degraded paths

- No `matchMedia`/`MutationObserver` (old WebView) → `innerWidth` fallback, tables
  keep their existing wrappers.
- `prefers-reduced-motion` → drawer and scrim animations are suppressed.
- The QR poster, the camera scanner and the WhatsApp fallback are untouched; the
  suite re-asserts them so a shell change cannot regress that screen.

## Revenue impact

The portal is the surface a paying merchant uses daily and the one a prospect sees
during a demo. A portal that only works on a laptop reads as a dashboard nobody
uses on the floor; the same page working on a phone is what turns "we could try
it" into a pilot.

## Main technical risks

1. `position: sticky` on the rail depends on no ancestor creating a scroll
   container — hence `overflow-x: clip` (with `hidden` as the fallback).
2. The table wrapper is driven by a `MutationObserver`; it is idempotent but every
   batch walks the tables in `#spa` once.
3. `go()` now writes history. A link that expects `location.hash` to be empty would
   see `#/home`; nothing in the repo reads it.

## Regression: the drawer filled the screen (fixed 2026-10-27)

What merchants saw on a phone: the section list rendered as a full-width column
under the topbar, could not be scrolled to reach Writer's Flow, and picking a
section left the screen frozen behind it.

Cause was cascade order, not a missing feature. `@media` adds **no** specificity,
so a `max-width: 1023px` block that declares `.sidebar { display: none }` placed
*above* the base `.sidebar { display: flex; ... }` rule loses to it, because the
later rule of equal specificity wins. The drawer rules had been inserted up with
the shell grid instead of below the rail.

What that produced, measured in Chrome at 360×640:

| state            | before the fix                              | after            |
| ---------------- | ------------------------------------------- | ---------------- |
| drawer closed    | `display:flex`, static, **360×1879px** inline | `display:none`   |
| drawer open      | fixed 300×580, scrollable                   | fixed 295×580, scrollable |
| after a tap      | back to the 1879px inline column            | `display:none`   |

The full-height inline column pushed the content off screen while
`body.nav-open { overflow: hidden }` removed the only way to scroll, which is the
"nothing moves" half of the report.

Rules that follow from it, and are now asserted in
`scripts/test_tenant_portal_mobile.mjs`:

1. The phone drawer block must be declared **after** the base `.sidebar` rule;
   the test compares character offsets, not just that both strings exist.
2. The open drawer must be pinned (`top: var(--topbar-h)`, `bottom: 0`) *and*
   given an explicit `height`/`max-height` in `vh` and `dvh`. A fixed box with no
   bounded height cannot scroll internally, so the list hangs off the viewport.
3. `openNav()` is a no-op from 1024px up, where the rail is permanent — otherwise
   a stray call drops a scrim over the only navigation a desktop user has.

Geometry was verified with a throwaway Chrome DevTools Protocol run (mobile
emulation, stubbed `fetch`, real stylesheet) at 360×640, 812×375, 768×1024 and
1024×768, plus a screenshot of the open drawer. Static greps alone would not have
caught this one: the markup, the media query and the JS were all correct.

## Next validation step

Signed in as a test merchant on a real phone (360px): open the drawer with the
hamburger, filter to "scan", tap Scan to Pay, create a link, press Back, reload —
the section must come back; then open Orders and confirm the table scrolls inside
its panel instead of dragging the page.
