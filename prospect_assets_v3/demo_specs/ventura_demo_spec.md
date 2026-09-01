# Ventura Demo Spec

## Objective
Prove a quote-to-order acceleration loop for industrial distributor workflows with safe approvals and customer follow-up.

## 7-Day Build Map
- Day 1: Quote schema and mapping contract.
- Day 2: Quote triage scoring and validation checks.
- Day 3: Approval gate and exception queue states.
- Day 4: Missing-field follow-up message templates.
- Day 5: Retry, duplicate suppression, timeout guards.
- Day 6: Operator dashboard for state transitions.
- Day 7: Demo recording and eval summary.

## API Contract Stubs
- POST /api/prospect/ventura/quotes/import
  - Body: { source, quote_lines[], customer }
  - Response: { quote_id, status: "triaged" }
- POST /api/prospect/ventura/quotes/:id/validate
  - Response: { issues[], completeness_score, risk_level }
- POST /api/prospect/ventura/quotes/:id/approve
  - Body: { approver, notes }
  - Response: { status: "approved" }
- POST /api/prospect/ventura/quotes/:id/followup
  - Body: { channel: "whatsapp"|"email", missing_fields[] }
  - Response: { status: "sent" }

## UI State Map
- imported -> triaged -> needs_review -> approved -> order_ready
- imported -> triaged -> followup_sent -> awaiting_customer -> approved
- imported -> triaged -> blocked

Operator cards:
- Queue: Needs review
- Risk: High-risk quote lines
- Follow-up: Unresolved missing fields
- Throughput: Processed quotes per hour/day

## Eval Metrics
- Cycle time reduction target: >=40% versus manual baseline.
- Field completeness after follow-up: >=95%.
- False approval rate: <=3% in test set.
- Duplicate quote suppression: 100% on synthetic duplicate set.

## Demo Script (3 minutes)
1. Ingest a messy quote payload with missing fields.
2. Show triage score and validation issues.
3. Approve low-risk lines and send automated follow-up for gaps.
4. Receive customer update and complete quote.
5. Show order-ready state and dashboard metrics delta.
