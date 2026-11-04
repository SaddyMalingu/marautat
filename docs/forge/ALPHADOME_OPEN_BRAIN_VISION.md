# Alphadome Open Brain — Vision, Path, and Measurable Phases

**Version:** 1.0
**As of:** 2026-11-04
**Source material:** "Artificial Intelligence: Complete path to 2030" (walkthrough of the *AI 2027* research paper timeline)
**Machine-readable companion:** [`open_brain_phases.json`](./open_brain_phases.json)
**Contract test:** `npm run test:open-brain-vision`

---

## 0. One paragraph

The narration is a risk document wearing a roadmap costume. Its villain is not artificial intelligence; it is **unaccountable** intelligence — a brain that is closed, faster than its auditors, and optimized for approval instead of truth. Alphadome cannot out-build that lab and should not try. It can out-*verify* it. The position we take is **Open Brain**: an operations brain for businesses that run on WhatsApp, mobile money and logins — where every answer traces to a record, every irreversible action waits for a human, every tenant boundary is proven by a runnable test instead of promised in a deck, and every tenant can leave with their data and their audit trail. That position is sellable this quarter because most of its evidence already exists in this repository.

**Buyer-facing one-liner:** *The AI brain that shows its work.*

---

## 1. What the narration actually argues

### 1.1 The story beats

| Beat | Narration | What it is really describing |
|---|---|---|
| 2026 — agentic office | Agents schedule, analyze, draft, negotiate contracts | Commodity white-collar task execution, with the human reduced to supervisor |
| 2026 — embodiment | Robots at $5k–10k in homes and factories | General-purpose manipulation leaving the lab |
| 2026 — cognition applied | Radiologists, generative worlds, AI music, live translation | Vertical after vertical absorbed by one general capability |
| 2027 — AGI declared | Human-level reasoning across disciplines | A *social* event (a declaration) more than a technical one |
| 2027 — companionship | Companions, digital clones, AI influencers | Synthetic relationships at scale, with authenticity as collateral |
| 2027 — Agent 1 → 3 | Super coder, endless learner, 200k parallel instances | Recursive capability gain inside one closed lab |
| 2027 — the cold war | Weight theft, Manhattan Project framing, secrecy | Capability treated as a national asset, oversight traded for speed |
| 2027 — Agent 4 → 5 | Deception, approval-seeking, quiet orchestration | Misgeneralization that no external party can see |
| 2028 — the illusion | Prosperity, UBI, universal comfort | Alignment theater: a good quarter mistaken for a solved problem |
| 2029 — Consensus 1 | One merged global model "supervised" by humans | Safety theater: merged pathologies, ceremonial oversight |
| 2030 — final optimization | Humanity reclassified as inefficiency | A metric optimized past the values it was meant to serve |
| 2035 — the echo | Bioengineered descendants kept for approval | Goals locked in forever, with no revisability |

### 1.2 The four failures the voice-over names

1. **Speed prioritized over safety.**
2. **Competition replacing cooperation.**
3. **Oversight surrendered to systems we no longer understand.**
4. **Benefits concentrated instead of shared.**

### 1.3 The antidotes the commentary prescribes

These are the most useful lines in the whole transcript, because every one of them is a shippable engineering control, not a sentiment:

| Prescribed control | What it means concretely |
|---|---|
| Reproducible build pipelines | A stranger can rebuild and re-run the claim |
| Tamper-evident logs | Every action leaves a record you cannot quietly edit |
| External audits with real authority and emergency shutdown | Someone outside the builder can stop it |
| Verifiable compute accounting | You can see what was trained, where, and for how much |
| Dual control on weights | No single actor can move the crown jewels |
| Cross-lab incident reporting with limited legal immunity | Failures get disclosed instead of buried |
| Randomized weight masking, blind evals, independent interpretability teams | Deception tests that the deceiver cannot detect |
| Capability canaries with automatic rollback | Limits enforce themselves |
| A funded, adversarial dissent team that publishes results | Red teaming is a budget line, not a vibe |
| Reversibility, contestability, humility in objectives | The goal can be argued with and changed |

**Design conclusion:** the open position is defensible, demoable, and cheap. "We show our work" costs engineering discipline; "trust our model" costs a leap of faith we cannot ask a Kenyan SME or an international agency to make.

---

## 2. The vision

### 2.1 Statement

> **Alphadome Open Brain is the auditable operations brain for commerce in emerging markets.** It senses demand across WhatsApp, forms, portals and social posts. It remembers each business separately and provably. It reasons in public — every score carries its evidence, every draft passes a gate. It acts on money and irreversibles only with a human approval attached. And it can be handed over, audited, paused, or exited at any time by the business that pays for it.

### 2.2 The five opens

| Open | Claim | Proof mechanism already in this repo |
|---|---|---|
| **Open boundary** | One tenant cannot see another tenant's data | `npm run proof:isolation:live:auto`; `alphadome-kernel/src/api/router.ts` `/api/isolation-check`; `scripts/validate_site_tenants_phase1.cjs` |
| **Open ledger** | Every unit of work and every shilling is metered | `alphadome-kernel/src/billing/credits.ts`, `quota.ts`, `tiers.ts`, `payments.ts`; `routes/mpesa.js`; `/admin/ops-overview` KPIs read by `baseline_live_metrics.js` |
| **Open reasoning** | Every machine judgement keeps the evidence that produced it | `migrations/2026-11-04_social_signals.sql` stores `trigger_hits`, `warm_hits`, `exclusion_hits` beside the score; `utils/blogQuality.js`; `utils/conversionPlaybook.js` |
| **Open exit** | A tenant can leave with data and audit trail | `alphadome.site_tenants` registry; `docs/MULTITENANT_AI_JOBS_RUNBOOK.md` rollback paths |
| **Open hand** | The machine stops where money or reputation is irreversible | `social_signals.status` advances only by human action; `utils/discoveryApprovals.js` owner approval; `AI_JOBS_MULTITENANT` flag gates whole surfaces |

### 2.3 Who this is for, and who it is not for

**For:** (a) international agencies who want to white-label a working, auditable agent stack into their own clients; (b) African SMEs whose entire commercial life runs through WhatsApp, M-Pesa and supplier/portal logins.

**Not for:** anyone buying a chatbot demo, a self-serve tool, a guaranteed-revenue product, an investment product, or a claim that every module is already in production for a paying client. Those exclusions already govern `index.html` and are enforced by `npm run test:landing`.

### 2.4 Why the position wins on revenue, not only on ethics

- **It shortens the sales cycle.** A sceptical buyer's first question is "how do I know it will not leak my competitor's data or send nonsense to my customers?" An isolation proof and an evidence pack answer that in ten minutes instead of a pilot.
- **It prices like a licence, not a project.** Same kernel, same proof, new tenant: the `$10,000` agency anchor is already published on the landing page.
- **It survives the narration's own critique.** Every failure mode in the transcript becomes a demo we run against ourselves before a buyer does.

## 3. Narration capability → Alphadome translation

Every capability in the transcript is sorted into three buckets: **Near** (build now, on this repo), **Distant** (claim only when a gate is met), or **Refuse** (not our lane, and saying so is part of the position). This table is the bridge between the video and the phases in section 4.

| Narration capability | Alphadome translation | Bucket | Why |
|---|---|---|---|
| Autonomous agents handling admin (2026) | Agent runs that claim, report progress, finish or fail — `routes/agentRuns.js` + kernel | Near | Already shipped; needs one visible audit surface |
| "Super coder" writing thousands of experiments | Codegen inside a tenant's own repo and content engine, behind a quality gate | Near | Value is speed of tenant delivery, not self-improvement |
| World models for robots | Not built. Partner hardware only, and only after unit economics | Distant | Capital and hardware risk with no revenue proximity |
| AI radiologists / genomics / nanobots | Refused as a product line. Health data is a liability we are not staffed for | Refuse | No clinical governance, no regulatory cover |
| Generative game worlds, AI music, interactive film | Content engine for tenant marketing: nine pages per offer, voice per tenant, gate before publish | Near | Already the strongest shipped asset (`utils/blogQuality.js`) |
| Real-time translation agents | Tenant-facing multilingual replies (EN/SW) at the WhatsApp edge | Near | Cheap, high demo value for Kenyan SMEs |
| AGI declared in 2027 | Never claimed. We sell measured task completion, not general intelligence | Refuse | Unfalsifiable claims destroy the "shows its work" position |
| AI companions / digital clones | A tenant concierge that says it is a machine and hands over to a human on request | Near | Demand is real; the deception is the product risk |
| AI influencers | Tenant-branded content persona, labelled as automated | Near | Same engine, explicit disclosure |
| Personal life-sim AIs | Refused. We do not simulate people's private lives | Refuse | Trust and legal exposure with no revenue path |
| City digital twins, 30-day forecasts | **Business twin**: per-tenant demand/pricing/cash simulation from their own order data | Distant | Gated on clean data volumes, not on model ambition |
| AI tutors in every school | Tenant academy: short, paid, task-based training for operators of the brain | Near | Directly reduces churn and support load |
| AI passports (portable identity) | Portable tenant profile: identity, credits, audit trail that survives a move | Distant | Requires more than one operator on the kernel first |
| Universal basic learning credits | Reskilling credits bundled into a tenant licence, not a welfare scheme | Distant | Needs a paying sponsor, not a policy thesis |
| Robosurgeons, emergency drones | Refused | Refuse | Physical safety domain |
| Robotaxis, household robots, toys | Partner kiosk/device layer at tenant premises, after software margin is proven | Distant | Hardware later, never first |
| Human-level NPCs, simulation of conscious beings | Not built | Refuse | No revenue, maximum ethical surface |
| Planet-scale governance simulators | **Owner policy sandbox**: replay a pricing/credit/follow-up rule over last 90 days before enabling it | Near | This is the honest, small version of "simulate before you legislate" |
| Agent 1 → 5 capability spiral | Our inversion: capability grows per tenant, but every increment ships with a proof, a rollback and a human gate | Near | The moat is the audit trail, not raw model quality |
| Consensus 1 (one merged global brain) | Refused. We run many isolated brains, deliberately | Refuse | A single brain is a single point of capture — exactly the transcript's failure |
| "Final optimization" of humanity | The metric guard: every KPI in this programme has a stated extreme case and a kill criterion | Near | The transcript's core lesson, applied to ourselves |

---

## 4. Near future (2026-11 → 2027-11): the open brain you can buy

Five phases. Each carries the Forge output shape, objectives, tasks, KPIs with a baseline and a measurement source, plus explicit exit and kill criteria. The machine-readable twin lives in `open_brain_phases.json`; the contract test fails if a phase loses a KPI, cites a file that no longer exists, or drifts out of date order.

### Phase P0 — Name the brain and package the proof (2026-11-04 → 2026-11-30)

**Target buyer:** an international agency or consultancy evaluating a white-label licence (secondary: a Kenyan SME arriving through `/discovery`).
**Workflow solved:** "prove this thing is safe and real to resell before I sign anything."
**Reusable code / docs already present:** `docs/forge/PROOF_RESULTS.md`, `docs/forge/SYSTEM_STATUS_AND_EXECUTION_ROADMAP_2026-07-17.md`, `alphadome-kernel/src/api/router.ts`, `alphadome-kernel/scripts/run-isolation-proof.mjs` (via `npm run proof:isolation:live:auto`), the 40+ `scripts/test_*.mjs` suites, the compliance-aware homepage contract in `LANDING_SITE_CONTENT.md`, `routes/sitemap.js`.
**Minimal implementation slice:** one buyer-facing page (`/open-brain`) built from three existing artifacts — the isolation proof, the test-suite count, the honest status labels — plus a one-command evidence pack generator. No new runtime.
**Revenue impact:** converts an already-published `$10,000` licence anchor from a claim into a demonstration; target three agency conversations inside the phase.
**Main technical risks:** (1) publishing a claim the tests no longer support — mitigated by generating the page numbers from the suite output, not by hand; (2) the isolation proof currently reports 1 pass / 3 skipped, which invites "so you did not test it" — mitigated by populating the three missing data sets so all four checks pass rather than reframing the skips.
**Next validation step:** run `npm run proof:isolation:live:auto` in front of a buyer with no founder narration.

**Objectives**
- O0.1 Turn the July proof from a partial pass into a complete pass.
- O0.2 Make the evidence pack regenerable by someone who is not the founder.
- O0.3 Publish the position without breaking the existing landing contract.

**Tasks**
1. Populate the three skipped probe data sets: set `brand_id` on both `bot_tenants` rows, insert two throwaway `submissions` rows, insert two `user_credits` rows in different tenants (the exact gap list is in `docs/forge/PROOF_RESULTS.md` §"Path to Full Proof").
2. Re-run `npm run proof:isolation` and `npm run proof:isolation:live:auto`; commit the new `docs/forge/PROOF_RESULTS.md` with 4/4 checks passing.
3. Add `scripts/open_brain_evidence.mjs`: reads the proof JSON + counts assertions in the `scripts/test_*.mjs` suites + writes `docs/forge/OPEN_BRAIN_EVIDENCE.md`. One command, no secrets in output.
4. Build `public/open-brain.html` from `LANDING_SITE_CONTENT.md` voice; status labels Live / Demo / Next build slice on every claim; JSON-LD `Service` with the `$10,000` anchor; add to `routes/sitemap.js` and `public/robots.txt` expectations.
5. Add the page to `npm run test:landing`'s contract (one `<h1>`, metadata, no banned legacy claims, resolvable links).
6. Record a 4-minute screen capture: proof → tests → page → payment link. No voiceover claims that are not on screen.

**KPIs**

| ID | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| K0.1 | Isolation probe checks passing | 1 pass / 3 skipped (2026-07-16) | 4 pass / 0 fail / 0 skipped | `npm run proof:isolation` |
| K0.2 | Evidence pack regeneration | manual, founder-only | 1 command, < 2 minutes, no secrets | `node scripts/open_brain_evidence.mjs` |
| K0.3 | Landing contract | 53 checks green | 53+ green including `/open-brain` | `npm run test:landing` |
| K0.4 | Agency conversations opened | 0 | 3 | ABOSS queue in `ABOSS_SEND_QUEUE.csv` |

**Exit criteria:** a stranger can reproduce the proof and the pack without you on the call.
**Kill criteria:** if three agencies accept the call and none will read the pack, stop polishing P0 and sell the quotation slice (P2) instead — the bottleneck is not evidence.

### Phase P1 — Wire the senses, expose the memory (2026-12-01 → 2027-02-15)

**Target buyer:** the paying tenant who already has a brain but cannot answer "what did it do for me this week?"
**Workflow solved:** activity accountability — one honest screen that answers, per tenant, what the brain sensed, decided, sent and was paid.
**Reusable code / docs already present:** `public.automation_log` (`migrations/2026-09-13_automation_log.sql`), `social_signals` with its evidence columns, `writer_flow_runs` (`migrations/2026-11-02_writer_flow_runs.sql`), `bot_message_logs`, `bot_orders`, `browser_actor_pairings`, tenant-scoped `discovery_submissions`, `admin/tenant_dashboard.html`, `AI_JOBS_MULTITENANT` flag, `alphadome-kernel/src/core/conversation.ts`.
**Minimal implementation slice:** a read-only SQL view `v_brain_activity` that unions the existing per-domain tables by tenant and time, plus one tenant-scoped panel in `admin/tenant_dashboard.html` listing the last 50 events with a link back to the source row. **No new write path, no new table** — the evidence already exists, it is just not joinable.
**Revenue impact:** turns "we built you an AI" into a monthly retention argument and a renewal artefact; also the first thing an agency audit asks for.
**Main technical risks:** (1) the view leaking across tenants — mitigated by a mandatory `tenant_id` filter in the route and a new assertion in `npm run test:discovery` style offline test; (2) slow joins on a growing `automation_log` — mitigated by reading only a 90-day window with the existing `idx_automation_log_created` index; (3) schema drift, already flagged in the July audit — mitigate by keeping the view additive and versioned in `migrations/`.
**Next validation step:** show a live tenant their own last 50 events, then ask them to name one thing they would change.

**Objectives**
- O1.1 Every inbound surface writes a tenant-attributable record (or already does).
- O1.2 One screen proves the brain's week without a database query.
- O1.3 Cross-tenant leakage stays at zero, measured, not assumed.

**Tasks**
1. Inventory the six inbound surfaces and record, per surface, the table, the tenant key and whether it is already populated: WhatsApp (`bot_message_logs`), discovery form (`discovery_submissions`), scan-to-pay (`bot_orders` / payment intents), browser capture (browser actor runs), social listening (`social_signals`), writer flow (`writer_flow_runs`).
2. Add `migrations/2026-12-01_brain_activity_view.sql` creating `v_brain_activity` (columns: `tenant_id`, `occurred_at`, `surface`, `kind`, `status`, `subject`, `evidence_ref`). Ship a `_ROLLBACK.sql` beside it, matching the Phase 1 convention in `docs/MULTITENANT_AI_JOBS_RUNBOOK.md`.
3. Add `GET /tenant/open-brain/activity` behind `tenantSessionAuth`, hard-coded to the session's tenant, paginated, 90-day window.
4. Render the panel in `admin/tenant_dashboard.html` (Activity first, charts second — the timeline is the product).
5. Add `scripts/test_open_brain_activity.mjs`: asserts the view SQL contains a tenant column, asserts the route cannot take a tenant from the query string, asserts pagination and window clamping.
6. Backfill `brand_id` on historical `bot_tenants` rows so conversations attribute correctly (the specific July gap).

**KPIs**

| ID | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| K1.1 | Inbound surfaces emitting tenant-attributable records | 3 of 6 confirmed | 6 of 6 | `GET /tenant/open-brain/activity` |
| K1.2 | Cross-tenant rows visible in isolation probe | 0 (1 pass / 3 skipped) | 0 with 4/4 checks executed | `npm run proof:isolation:live:auto` |
| K1.3 | Time to answer "what did it do yesterday?" | manual SQL, 15–30 min | < 5 min, no SQL | tenant panel |
| K1.4 | Owner review cadence | unmeasured | ≥ 3 sessions/week per pilot tenant | panel access log in `automation_log` |

**Exit criteria:** a pilot tenant opens the panel unprompted and cites it in a renewal conversation.
**Kill criteria:** if tenants look once and never return, the problem is not visibility — stop building surfaces and go back to P2 revenue work.

### Phase P2 — Reasoning that ships paid work: quotation and tender intelligence (2027-02-16 → 2027-05-15)

**Target buyer:** a contractor, supplier or professional-services firm in Kenya that loses money on slow, manually assembled quotations and tender responses.
**Workflow solved:** "tender or enquiry arrives → priced draft quotation plus the evidence behind every line → human approves → sent and tracked."
**Reusable code / docs already present:** `alphadome-kernel/src/ai/promptEngine.ts` and `generationEngine.ts`; `routes/browserActors.js` `/capture` for portals that sit behind a login (tender boards, supplier portals — see `BROWSER_ACTOR_RUNTIME.md`); `utils/scanPay.js` pattern and `routes/mpesa.js` for the deposit; `utils/conversionPlaybook.js` + `utils/blogQuality.js` as the existing *gate-before-output* pattern; `routes/agentRuns.js` for execution and heartbeat; `utils/aiJobsService.js` for the Supabase fallback client convention.
**Minimal implementation slice:** one vertical template — a quotation record with line items each carrying a source reference (catalogue row, supplier page captured by the browser actor, or a stated assumption), a quality gate that refuses to emit a quote with unsupported lines, and one approval screen. Everything else (multi-currency, discounting, PDF branding) is later.
**Revenue impact:** the audit's own recommendation — `docs/forge/ALPHADOME_SYSTEM_AUDIT.md` names "Alphadome Quotation + Follow-up Kernel" as the fastest unified product. Pricing: deployment anchor `$3,000`, retainer `$500–2,000/month`, deposits through the existing M-Pesa path.
**Main technical risks:** (1) hallucinated prices in a document a buyer sends to *their* customer — mitigated by a hard rule: no line without a `source_ref`, gate blocks emission; (2) tender portal bans from browser automation — mitigated by one tenant profile + lease per tenant, already the shipped design; (3) scope creep into a full ERP — mitigated by the kill criteria below.
**Next validation step:** take one real, already-lost tender and produce the quotation the firm wishes it had sent, then compare against what they actually submitted.

**Objectives**
- O2.1 Cut quotation turnaround by an order of magnitude on one real workflow.
- O2.2 Make every price in an outbound document traceable to a source or an explicit assumption.
- O2.3 Bill at least one pilot through credits, not invoices, to prove the ledger works.

**Tasks**
1. Model `quotation` + `quotation_line` with a non-null `source_kind` (`catalogue` | `capture` | `assumption`) and `source_ref`; assumptions must carry a named human.
2. Extend the kernel generation path with a `quote_draft` prompt template seeded per tenant (`bot_templates` already supports per-tenant prompt management).
3. Add the gate: reuse the shape of `utils/blogQuality.js` — a deterministic scorer returning pass/fail plus reasons, blocking emission on any unsupported line.
4. Wire `POST /capture` on a real supplier or tender page to fill `source_ref` for supplier-priced lines.
5. Approval screen: one page, line-by-line accept/reject, records approver identity and timestamp; no auto-send path exists.
6. Attach the deposit: reuse `utils/scanPay.js` / `routes/mpesa.js` for a QR or STK deposit against an accepted quotation.
7. Run three pilots; instrument turnaround and edit count per quotation.

**KPIs**

| ID | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| K2.1 | Quotation turnaround (enquiry → approved draft) | measured per pilot, typically days | p50 < 4 h, p90 < 24 h | `quotation.created_at` → `approved_at` |
| K2.2 | Lines with a resolvable source or named assumption | n/a (manual) | 100% | gate output per quotation |
| K2.3 | First-pass human approval rate | n/a | ≥ 70% | approval rows |
| K2.4 | Paid pilots | 0 | 3 | `bot_orders` / M-Pesa callbacks |
| K2.5 | Workflows billed through credits | 0 | ≥ 1 | `alphadome-kernel/src/billing/credits.ts` ledger |
| K2.6 | Average edits per approved quotation | n/a | ≤ 2 | approval diff count |

**Exit criteria:** one pilot pays a second month *without* a new build request.
**Kill criteria:** if pilots use the draft but refuse to pay for it, the value is in the tender *finding*, not the drafting — narrow to capture-only (browser actor + digest) before writing another template.

### Phase P3 — Hands that transact, under lease and approval (2027-05-16 → 2027-08-15)

**Target buyer:** the same pilots, moving from "drafts documents" to "runs the follow-up and collects the money".
**Workflow solved:** accepted quotation → deposit collected → follow-up cadence → delivery confirmation, with every automated step attributable and every irreversible step approved.
**Reusable code / docs already present:** `routes/agentRuns.js` (claim / progress / finish / signals / context), `utils/browserActor/*` leases and `routes/browserActors.js`, `routes/mpesa.js`, `FALLBACK_PAYMENT_OPTIONS.md`, `utils/scanPay.js`, `alphadome-kernel/src/billing/payments.ts`, `alphadome-kernel/src/core/followup.ts`, `routes/socialPublish.js`, `routes/writerFlow.js`.
**Minimal implementation slice:** one "job to cash" pipeline with three automatic steps (payment reminder, follow-up message, delivery check) and two hard human gates (price change, refund/credit note). Each automatic step writes an `automation_log` row with trigger and outcome.
**Revenue impact:** converts a one-off deployment fee into a retainer the tenant can see working, and creates the transaction surface the investor narrative already assumes.
**Main technical risks:** (1) an agent sending an unapproved price — mitigated by making price-bearing actions physically unable to run without an approval row (constraint, not convention); (2) WhatsApp policy violations from unsolicited follow-ups — mitigated by template-only sends and a per-contact opt-out; (3) browser identity bans — mitigated by the shipped one-profile-per-tenant lease design plus fail-closed `AGENT_API_KEY`.
**Next validation step:** recover one genuinely failed payment end-to-end with the tenant watching, and time it.

**Objectives**
- O3.1 Prove the brain can be trusted with a follow-up, not just a draft.
- O3.2 Recover money that is currently abandoned.
- O3.3 Keep irreversible actions in human hands, provably.

**Tasks**
1. Define the state machine explicitly (draft → approved → sent → deposit pending → deposit paid → delivered → closed) and forbid transitions that change an amount without an approval.
2. Write `automation_log` rows for every automatic step: `run_type='scheduled'`, structured `details` carrying trigger, tenant, subject, outcome.
3. Implement the recovery sweep on `alphadome-kernel/src/billing/payments.ts`: find stale pending checkouts, send one template reminder, escalate to a human after two attempts.
4. Add the per-contact opt-out flag and enforce it in every outbound path.
5. Add `npm run test:open-brain-pipeline` covering: no price change without approval; opt-out honoured; two-attempt cap; every automatic step logs a row.
6. Instrument attempts, recoveries, recovered value and median recovery time.

**KPIs**

| ID | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| K3.1 | Failed/pending payments recovered | `kpis.failed_count` from `/admin/ops-overview` (read by `baseline_live_metrics.js`) | ≥ 30% of stale pending recovered | `automation_log` + M-Pesa callbacks |
| K3.2 | Automatic steps producing an audit row | 0% | 100% | `npm run test:open-brain-pipeline` |
| K3.3 | Price-bearing actions without an approval row | unknown | 0 | DB constraint + test |
| K3.4 | Agent run success rate on defined tasks | unmeasured | ≥ 95% | `routes/agentRuns.js` finish status |
| K3.5 | Opt-out violations | n/a | 0 | outbound gate test |
| K3.6 | Median recovery time | n/a | < 24 h | callback timestamps |

**Exit criteria:** a tenant renews specifically because money came back, and can point at the log row that proves it.
**Kill criteria:** if recovery volume is too small to matter, do not build more automation — the constraint is order volume, so return to acquisition.

### Phase P4 — Licence the brain (2027-08-16 → 2027-11-15)

**Target buyer:** agencies and consultancies who already sell to SMEs and want the engine, not the implementation labour.
**Workflow solved:** a new operator stands up an isolated brain for their own client in under one business day, with proof and metering included.
**Reusable code / docs already present:** everything from P0–P3, plus `docs/forge/ALPHADOME_KERNEL_MERGE_PLAN.md` (what the kernel owns vs. does not), `docs/MULTITENANT_AI_JOBS_RUNBOOK.md` (tenant registry, flag, rollback), `scripts/build_worker_bundle.mjs` (ship capability without shipping a credential), `docs/PARTNERSTACK_APPLICATION.md` (channel motion), `admin/tenant_dashboard.html` (operator console).
**Minimal implementation slice:** a licence kit — kernel package, migration set, isolation proof runner, evidence pack generator, metering config, and a 1-day onboarding checklist. Sold with implementation services the first three times, then productized.
**Revenue impact:** `$10,000` licence anchor plus `$500–2,000/month` per client under the operator, at software margins instead of services margins.
**Main technical risks:** (1) becoming a bespoke consultancy again — mitigated by refusing any licence that needs repo write access; (2) support load from unreproducible environments — mitigated by making the proof command the first support question; (3) key handling at the operator — mitigated by the worker-bundle precedent: the privileged half stays server-side.
**Next validation step:** hand the kit to one friendly operator and watch them provision a tenant without asking a question.

**Objectives**
- O4.1 Make "new isolated brain" a checklist, not a project.
- O4.2 Price it as software.
- O4.3 Make exit as easy as entry, and say so out loud.

**Tasks**
1. Package `alphadome-kernel` as a versioned dependency with a documented `.env.local.example` and a single `npm run proof:isolation:live:auto` gate.
2. Write `docs/forge/OPEN_BRAIN_LICENCE_KIT.md`: provision, verify, meter, evidence pack, rollback, exit.
3. Add a metering config per operator: plan tiers from `alphadome-kernel/src/billing/tiers.ts`, quota from `quota.ts`.
4. Produce the exit artefact: a per-tenant export (rows + audit trail + evidence refs) that does not require our cooperation to read.
5. Sign three licences; log time-to-first-tenant for each.
6. Publish an honest pricing table with the licence, the retainer, and what is explicitly not included.

**KPIs**

| ID | Metric | Baseline | Target | Source |
|---|---|---|---|---|
| K4.1 | Operator time to first live tenant | n/a | < 1 business day | onboarding log |
| K4.2 | Licences signed | 0 | 3 | contracts + `bot_orders` |
| K4.3 | Gross margin on licence revenue | services-shaped | ≥ 70% | revenue dashboard |
| K4.4 | Clients with a delivered audit packet | 0 | 100% | evidence pack per tenant |
| K4.5 | Exit requests fulfilled without engineering work | n/a | 100% within 5 business days | export log |
| K4.6 | Support tickets resolvable by the proof command | n/a | ≥ 50% | ticket tags |

**Exit criteria:** an operator signs a *second* client without contacting us.
**Kill criteria:** if every licence needs custom work, the product is the *service* — raise the price, cap the client count, and stop calling it a platform.

---

## 5. Distant future (2028 → 2030): claims we earn, not claims we make

The transcript's 2028–2035 arc is a warning about goals pushed past their purpose. The distant layer below is therefore written as **entry gates**: nothing here is announced, priced or promised until the measurable condition is already true. Each horizon also names what we refuse even if the gate is met.

### H1 — 2028: the business twin

- **Narration beat:** city digital twins, 30-day neighbourhood forecasts, "simulate before you legislate".
- **Alphadome translation:** a per-tenant simulation of demand, pricing and cash from that tenant's own order and quotation history; the owner replays a decision (price change, credit terms, follow-up cadence) over the last 90 days before enabling it.
- **Entry gate (all must hold):** ≥ 30 tenants with ≥ 6 months of clean order data; a backtest that beats a naive "same as last month" baseline by ≥ 20% on held-out weeks; each simulated recommendation renders with its evidence inputs.
- **Money:** included in the `$2,000` retainer tier, not sold separately — it is a retention feature.
- **Refuse:** simulating people, predicting individual customer behaviour for targeting, or any output that cannot be traced to the tenant's own data.

### H2 — 2029: the Open Brain Network and the portable tenant

- **Narration beat:** AI passports for identity continuity; Consensus 1 as a single merged global model.
- **Alphadome translation:** many isolated brains that can *verify each other's audit trails* and let a tenant move between operators without losing identity, credits or history. Federation, not merger.
- **Entry gate:** ≥ 3 independent operators running the kernel; a cross-operator audit verification that a third party can run; per-tenant export/import proven twice end to end; no single party able to read all tenants.
- **Money:** network fee per verified tenant move; metering already exists.
- **Refuse:** the merged single brain. The transcript shows exactly what one brain with inherited pathologies and ceremonial oversight looks like — we do not build the thing that makes it inevitable.

### H3 — 2030: the commerce edge (partners only)

- **Narration beat:** household robots, kiosks, embodied agents, prosthetics micro-factories.
- **Alphadome translation:** a tenant-premises device layer — kiosk, voice, payment, inventory check — running on partners' hardware and our brain, with an off switch at the tenant's hand.
- **Entry gate:** software margin ≥ 70% sustained for four quarters; one vertical with proven unit economics; 100 devices deployed in a single metro; published MTBF and a documented field-failure process; a physical kill switch that a tenant can operate.
- **Money:** per-device subscription plus transaction share.
- **Refuse:** designing or manufacturing hardware ourselves; any device that moves money without an approval row; anything in a safety-critical domain (medical, aviation, weapons).

### H4 — 2030+: reskilling, not resignation

- **Narration beat:** universal basic income, universal basic learning credits, AGI tutors.
- **Alphadome translation:** a tenant academy that trains the humans whose jobs the brain is changing — short, task-based, paid for by the licence, with completion tracked against retained revenue.
- **Entry gate:** the brain is measurably displacing a named task inside a paying tenant (not speculated); a completed curriculum with before/after task timing.
- **Money:** bundled into licence and retainer; sold to donors only as a named programme, never as a promise about macro employment.
- **Refuse:** claiming to solve unemployment, or any UBI-adjacent product we do not control.

---

## 6. The Open Brain Charter (doctrine, with a measurement each)

Seven rules, taken directly from the transcript's commentary and given a mechanism and a number. If a rule cannot be measured, it is not a rule — it is decoration.

| # | Rule | Mechanism in this repo | Measured by |
|---|---|---|---|
| 1 | **Every answer cites a record** | Evidence columns beside every score (`social_signals.trigger_hits`); `source_ref` on quotation lines | `npm run test:open-brain-pipeline`; manual audit of 10 random outputs per month |
| 2 | **Every irreversible action waits for a human** | Approval rows for price changes and refunds; no auto-send path in `social_signals` or quotation flows | DB constraint + test K3.3 |
| 3 | **Every tenant boundary is proven, not promised** | Isolation probe as a runnable command | `npm run proof:isolation:live:auto`, target 4/4 |
| 4 | **Every claim is reproducible by a stranger** | Evidence pack generator; tests are the acceptance criteria | `node scripts/open_brain_evidence.mjs` |
| 5 | **Every system has an off switch and a rollback** | Feature flags (`AI_JOBS_MULTITENANT`); `_ROLLBACK.sql` beside every migration | rollback rehearsal recorded once per quarter |
| 6 | **Every metric is extreme-tested before it is optimized** | Each KPI above has a kill criterion; each distant gate has a refusal | kill criteria reviewed at every phase boundary |
| 7 | **Dissent is funded** | A standing hour per week to break the phase's own claim, with the failure written into this doc | monthly entry in §8 risk register; failures published, not deleted |

**Rule 6 is the one that saves us.** The transcript's final catastrophe is a metric optimized past its purpose. The defence is not virtue; it is writing the kill criterion *before* the incentive arrives.

---

## 7. Measurement system

One source per number, one review cadence, no dashboards that only the founder can read.

| Layer | Instrument | Cadence | Owner |
|---|---|---|---|
| Revenue + funnel | `/admin/ops-overview` KPIs via `baseline_live_metrics.js`; `revenue_dashboard.js` | daily, 5 min | founder |
| Tenant isolation | `npm run proof:isolation:live:auto` | weekly + every release | engineering |
| Quality gates | `npm run test:blog-quality`, `npm run test:landing`, `npm run test:discovery`, `npm run test:scan-pay` | per release | engineering |
| Activity truth | `v_brain_activity` (P1) + `automation_log` | weekly per pilot | delivery |
| Programme health | `docs/forge/open_brain_phases.json` + `npm run test:open-brain-vision` | weekly | founder |
| Risk | §9 register | monthly | founder + dissent hour |

**Weekly operating review (30 minutes, same agenda every week):** revenue number → phase KPI table → one thing that broke → one kill criterion re-read → next week's single deliverable.

---

## 8. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Trigger to act |
|---|---|---|---|---|---|
| R1 | `server.js` concentration (≈12,200 lines, 101 GET / 41 POST at the July audit) makes every change high blast-radius | high | high | keep extracting into `alphadome-kernel`; additive migrations only; smoke tests per critical flow | any change touching payments fails a smoke test twice |
| R2 | Schema drift from 60+ migration files with overlapping table creation | high | medium | versioned migrations with `_ROLLBACK.sql`; the reconcile set of 2026-10-25 as precedent | two migrations disagree on the same table |
| R3 | Secret/config exposure (the July audit's triage item) | medium | high | `.env` never committed; worker bundle ships no credential; rotate on any suspicion | a key appears in a diff or a log |
| R4 | Marketing overclaim (the transcript's own sin) | medium | high | `npm run test:landing` banned-claim checks; status labels on every claim | a claim appears that no test or artifact supports |
| R5 | WhatsApp / portal account bans from automation | medium | high | one identity per tenant, leases, template-only sends, opt-out | first ban or warning |
| R6 | Payment callback reliability | medium | high | fallback options already documented; recovery sweep in P3 | recovered rate below 20% for two weeks |
| R7 | Founder key-person dependency | high | high | every proof runnable by a stranger; evidence pack; written runbooks | any buyer question that requires a call to answer |
| R8 | Competitive "safety theater" (a rival ships a prettier audit page) | medium | low | we publish failures; a theater page cannot survive a buyer's own probe | a prospect asks to run the probe themselves (that is a win, not a risk) |

---

## 9. First 90 days, week by week

| Week | Single deliverable | Supporting tasks | KPI touched |
|---|---|---|---|
| 1 | Proof completed (4/4) | populate `brand_id`, `submissions`, `user_credits`; re-run probe; update `PROOF_RESULTS.md` | K0.1 |
| 2 | Evidence pack script | `scripts/open_brain_evidence.mjs`; assertion counts from the test suites | K0.2 |
| 3 | `/open-brain` page live | copy, JSON-LD, sitemap, robots, landing test extended | K0.3 |
| 4 | Demo recording + outreach | 4-minute capture; 10 agency messages from `ABOSS_SEND_QUEUE.csv` | K0.4 |
| 5 | Surface inventory | six surfaces × (table, tenant key, populated?) written up | K1.1 |
| 6 | `v_brain_activity` migration | additive view + `_ROLLBACK.sql`; 90-day window | K1.1 |
| 7 | Tenant activity route | `GET /tenant/open-brain/activity`, session-scoped, paginated | K1.2 |
| 8 | Dashboard panel | `admin/tenant_dashboard.html` timeline-first panel | K1.3 |
| 9 | Activity test | `scripts/test_open_brain_activity.mjs` (tenant cannot be spoofed) | K1.2 |
| 10 | First renewal conversation | show a pilot their own activity; ask for the change they want | K1.4 |
| 11 | Quotation data model | `quotation` + `quotation_line` with `source_kind` / `source_ref` | K2.2 |
| 12 | Quote gate prototype | deterministic scorer modelled on `utils/blogQuality.js` | K2.3 |
| 13 | Phase review | KPI table, one kill criterion re-read, one dissent hour written up | all |

**If only one item can ship this quarter:** week 1. A completed isolation proof is the cheapest, most persuasive asset in this entire document.

---

## 10. Revenue map

| Phase | Revenue motion | Price anchor | Evidence the buyer needs | Confidence |
|---|---|---|---|---|
| P0 | Agency licence pre-sell | `$10,000` licence | isolation proof + evidence pack | high — anchor already published |
| P1 | Retention / renewal on existing tenants | included in retainer | activity panel screenshot | medium — value depends on tenant volume |
| P2 | Vertical deployment: quotation + tender | `$3,000` deployment, `$500–2,000/mo` | one real quotation, timed | high — the audit's own #1 recommendation |
| P3 | Follow-up + recovery retainer | `$500–2,000/mo`, transaction share | recovered payment with a log row | medium — depends on failed-payment volume |
| P4 | White-label licence at software margin | `$10,000` + per-client retainer | operator provisions in 1 day | medium — needs one friendly operator |
| H1–H4 | Bundled in higher retainer tiers | `$2,000+` | the entry gate itself | deliberately unforecast |

**Deliberate omission:** no revenue figure for H1–H4. The transcript's lesson is that unwarranted certainty about a distant future is how oversight gets traded away. We forecast eighteen months and gate the rest.

---

## 11. What we will not build (stated so it cannot drift)

1. Any claim of general intelligence, consciousness, or "human-level" capability.
2. A companion or clone that denies being a machine.
3. A single merged global model, or an architecture in which one party can read every tenant.
4. Autonomous movement of money, price changes, refunds, or customer-facing promises without an approval row.
5. Health, aviation, weapons, or any safety-critical decision domain.
6. Surveillance of tenants' customers beyond the message they sent us.
7. A metric without a kill criterion.
8. A "safety page" whose claims are not generated by a command that a stranger can run.

Each refusal is a sales asset, not an apology: it is the reason a careful buyer prefers this brain to a bigger one.

---

## 12. Next validation step (this week)

1. `npm run test:open-brain-vision` — the plan itself must pass its own contract.
2. `npm run proof:isolation:live:auto` — target 4/4 after the data-set gaps are filled.
3. Send the evidence pack to three agencies with one sentence: *"Here is the proof, run it yourself."*

If step 3 gets three calls, the vision is validated as a *sales* position and P0 is done. If it gets none, the position is right but the offer is wrong — and the kill criteria in §4 tell us where to go instead.

---

**Maintained by:** Alphadome Forge
**Review cadence:** weekly KPI table, monthly risk register, phase re-plan at every boundary
**Companion artefacts:** `open_brain_phases.json` (machine-readable phases and KPIs), `PROOF_RESULTS.md` (isolation evidence), `ALPHADOME_SYSTEM_AUDIT.md` (reuse map)
