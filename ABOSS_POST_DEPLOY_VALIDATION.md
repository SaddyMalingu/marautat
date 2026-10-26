# A Boss Post-Deploy Validation

Run this immediately after deployment.

## 1) Quick Automated Check

Command:

```bash
node scripts/aboss_validate_production.cjs
```

Optional env overrides:

```bash
ABOSS_BASE_URL=https://alphadome.onrender.com
ABOSS_ADMIN_KEY=your_admin_key
```

## 2) Expected Outcomes

1. Ops and revenue endpoints return 200.
2. WF campaigns endpoint returns 200 or at minimum a clear schema error.
3. No missing-column errors for `channels` or `created_at` after deploy + migration alignment.

## 2b) Blog quality and landing-site checks (2026-10-25)

Run these on the machine that holds the deploy, before and after a content change:

```bash
npm run test:blog-quality   # voices, article brief, quality gate, repair prompt
npm run test:landing        # homepage contract: metadata, JSON-LD, pricing, claims
```

What to look for in the Render log on the first Writer's Flow run after deploy:

1. `[GEN] Voice: <profile> (<derived|configured>) for <brand>` — one line per
   journey, before the first angle.
2. `[GEN] Quality <slug>: nn/100, … words, … paragraphs, lists …%` — per page.
3. `[GEN] Repaired <slug>: old → new` when a draft failed the gate and the
   rewrite scored higher. A page that never logs a quality line came from the
   composed fallback (the AI tier was dry), not from the brief.
4. The tenant portal toast now reads `Optimized — 9 pages ready · 84/100 avg ·
   voice: the precise operator`, so a buyer can see the outcome without opening
   nine pages.

## 3) If WF Campaigns Still Fail

1. Run/verify DB migration for `wf_campaigns` columns.
2. Confirm table includes at least these fields:
   - `id`
   - `name`
   - `keywords`
   - `status`
3. Re-run:

```bash
node scripts/aboss_validate_production.cjs
```

## 4) Revenue Window Checklist

1. Confirm test-user cutoff is active.
2. Confirm fallback recovery actions work for post-cutoff subscriptions.
3. Start contact research using `ABOSS_RAPID_CONTACT_RESEARCH.md`.
4. Execute outreach scripts from `ABOSS_SECTOR_OUTREACH_SCRIPTS.md`.
