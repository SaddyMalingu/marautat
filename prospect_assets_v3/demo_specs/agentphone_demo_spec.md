# AgentPhone Demo Spec

## Objective
Demonstrate telephony anomaly triage with action routing, compliance context, and fast recovery recommendations.

## 7-Day Build Map
- Day 1: Delivery lifecycle event schema for call/SMS/iMessage/RCS.
- Day 2: Failure classifier (drop, delay, rejection, compliance block).
- Day 3: Recovery action map and route switch logic.
- Day 4: Compliance state checks (A2P, KYC, TCR placeholders).
- Day 5: Operator queue and SLA board.
- Day 6: Customer status summary endpoint.
- Day 7: Failure-to-resolution demo pack.

## API Contract Stubs
- POST /api/prospect/agentphone/events/ingest
  - Body: { channel, provider, event_code, metadata }
  - Response: { ingested: true }
- POST /api/prospect/agentphone/incidents/classify
  - Body: { event_id }
  - Response: { category, confidence, recommended_actions[] }
- POST /api/prospect/agentphone/incidents/:id/recover
  - Body: { action }
  - Response: { recovery_status, next_check_at }
- GET /api/prospect/agentphone/incidents/queue
  - Response: { incidents: [{ id, severity, category, sla_deadline }] }

## UI State Map
- observed -> classified -> routed -> recovering -> resolved
- observed -> classified -> compliance_hold -> manual_verification -> resolved

Operator cards:
- Incidents by failure category
- Mean time to classify
- Mean time to recovery
- Compliance hold backlog

## Eval Metrics
- Classification precision on labeled scenarios: >=90%.
- Actionability rate (has recommended next step): >=95%.
- Mean time to classify target: <60 seconds (simulation).
- Recovery closure rate in first attempt: >=70%.

## Demo Script (3 minutes)
1. Ingest mixed channel delivery events.
2. Auto-classify a carrier rejection and a silent drop.
3. Trigger recovery actions (retry route, channel switch).
4. Show compliance hold flow for blocked event.
5. Close incident and display SLA/ops summary.
