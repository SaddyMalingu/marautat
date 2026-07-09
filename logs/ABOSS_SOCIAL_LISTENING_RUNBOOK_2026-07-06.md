# ABOSS Social Listening Runbook (2026-07-06)

## Recommended Flow (Best for Speed + Accuracy)
Use a hybrid rollout:
1. Phase 1 (Immediate): browser-assisted/manual capture for real posts into ABOSS_SOCIAL_SIGNALS_RAW.csv.
2. Phase 2 (Scale): API-based ingestion for platforms where approved APIs are available.
3. Keep one rule always: no output without source row evidence.

## Why This Is Best
- Browser/manual gets you live leads today without waiting for API approvals.
- API ingestion increases volume and consistency once credentials and compliance are ready.
- Same scoring engine works for both, so quality logic stays stable.

## Daily Operating Cadence
1. Run intent query pack from ABOSS_SOCIAL_LISTENING_QUERIES.csv.
2. Capture real posts into data/ABOSS_SOCIAL_SIGNALS_RAW.csv with post_url and post_text.
3. Run: npm run aboss:social-listen.
4. Execute outreach from:
   - logs/ABOSS_SOCIAL_OUTREACH_READY.csv
   - logs/ABOSS_SOCIAL_WHATSAPP_PRIORITY.csv
5. Record outcomes and rerun every 3-4 hours.

## Required Source Record Fields
- platform
- post_url (required)
- post_text (required)
- author_handle or author_name
- profile_url (if available)
- sector_hint, city_hint, intent_hint
- contact_hint (if visible)
- captured_by

## Quality Gates
1. Reject rows missing post_url or meaningful post_text.
2. Reject duplicate post_url rows.
3. Reject obvious exclusions (ads/news/memes/job posts).
4. Promote only score >= 65 and exclusion_flag != yes.

## KPI Targets
- Per intent category: 10-30 leads/day.
- Outreach-ready ratio: >= 35 percent of captured rows.
- Median first-touch latency: < 15 minutes for high-intent leads.
- Contactability: >= 40 percent with phone/email/DM route.

## Compliance Notes
- Capture only publicly visible content.
- Respect platform terms and local privacy obligations.
- Do not scrape private groups or protected data.
