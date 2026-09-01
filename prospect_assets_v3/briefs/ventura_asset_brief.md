# Brand Asset Brief

## Brand
- Name: Ventura
- Role link: https://www.workatastartup.com/jobs/93338
- Primary contact surface (from page): Swen (CEO), Jack (CTO), WAAS apply endpoint

## Target Buyer
- Founders and first GTM/ops leader responsible for quote-to-order turnaround in industrial distribution.

## Workflow Being Solved
- Current pain: AI capabilities exist, but deployment into legacy ERP + SOP-heavy quoting operations is slow and brittle.
- Desired outcome: Same-day quote handling and order-entry acceleration with customer-safe approvals and reliable fallbacks.

## Reusable Alphadome Components
- Lead qualification and follow-up engine (writers_flow)
- Multi-tenant control settings and routing patterns
- Payment fallback and exception-handling playbooks
- Ops dashboard patterns for status + queue visibility

## Minimal Implementation Slice (7 days)
- Day 1: Define distributor quote schema and ingestion adapter contract (CSV/API mock).
- Day 2: Build quote triage agent prompt + deterministic validation checks.
- Day 3: Add approval gate and exception queue for uncertain quote lines.
- Day 4: Add WhatsApp follow-up template for missing quote metadata.
- Day 5: Add reliability checks (timeout, retry, duplicate suppression).
- Day 6: Build simple operator dashboard for quote state transitions.
- Day 7: Record demo, package architecture note, and publish evaluation results.

## Success Metric
- Reduce simulated quote cycle time by at least 40% while maintaining >=95% field-completion accuracy.

## Risks
- Technical risk: Legacy ERP schema variability and mapping ambiguity.
- Product risk: Operators may distrust autonomous quote actions.
- Delivery risk: Mock integrations may not reflect real customer edge cases.

## Next Validation Step
- Send a founder-targeted outreach note with 3-minute demo and ask for a 20-minute technical calibration call.

## Deliverables
- Demo artifact: Quote-to-order flow walkthrough with exception queue.
- Architecture note: Adapter + agent + approval-state model.
- Eval/failure note: Error taxonomy, retry outcomes, and unresolved edge cases.
