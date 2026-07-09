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
