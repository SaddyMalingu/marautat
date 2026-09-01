# Sitefire Demo Spec

## Objective
Demonstrate a GEO action loop that converts visibility signals into prioritized, controllable actions with measurable quality feedback.

## 7-Day Build Map
- Day 1: GEO action object model and scoring dimensions.
- Day 2: Priority queue generator from signal inputs.
- Day 3: Control states (auto/review/blocked).
- Day 4: Connector stubs (CMS, analytics export, task system).
- Day 5: Feedback ingestion for accepted/rejected actions.
- Day 6: Action quality and drift dashboard.
- Day 7: Demo and evaluator notes.

## API Contract Stubs
- POST /api/prospect/sitefire/signals/ingest
  - Body: { brand, source, signal_type, confidence, metadata }
  - Response: { ingested: true, actions_created }
- GET /api/prospect/sitefire/actions/queue
  - Response: { actions: [{ id, score, reason, control_state }] }
- POST /api/prospect/sitefire/actions/:id/decision
  - Body: { decision: "accept"|"reject"|"defer", note }
  - Response: { status: "recorded" }
- POST /api/prospect/sitefire/actions/:id/execute
  - Response: { status: "executed"|"blocked" }

## UI State Map
- queued -> review -> accepted -> executed -> evaluated
- queued -> review -> rejected -> tuned
- queued -> blocked

Operator cards:
- Top 10 recommended GEO actions
- Acceptance rate by action category
- Action impact confidence trend
- Drift alerts for low-quality action clusters

## Eval Metrics
- Reviewer acceptance for top-10 queue: >=80%.
- Rejection-reason capture completeness: 100%.
- Action execution success: >=95% on mock connectors.
- Quality drift alert precision: >=85% in labeled test cases.

## Demo Script (3 minutes)
1. Ingest new visibility/sentiment signals.
2. Open ranked action queue and inspect rationale.
3. Accept top action, reject one, defer another.
4. Execute accepted action through connector stub.
5. Show feedback loop updating quality trend.
