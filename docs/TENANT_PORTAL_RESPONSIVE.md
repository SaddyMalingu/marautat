# Tenant Portal — responsive shell for every device

**Surface:** `admin/tenant_dashboard.html` (served at `/tenant-dashboard`, auth-gated)
**Test:** `npm run test:tenant-portal` → `scripts/test_tenant_portal_mobile.mjs` (102 checks)
**Owner of the behaviour:** the `RESPONSIVE SHELL` block in the page's last `<script>`

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

## Next validation step

Signed in as a test merchant on a real phone (360px): open the drawer with the
hamburger, filter to "scan", tap Scan to Pay, create a link, press Back, reload —
the section must come back; then open Orders and confirm the table scrolls inside
its panel instead of dragging the page.
