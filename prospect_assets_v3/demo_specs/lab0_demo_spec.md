# Lab0 Demo Spec

## Objective
Prove enterprise connector safety using dry-run, approval, audit trail, and rollback guidance for agent-initiated actions.

## 7-Day Build Map
- Day 1: Connector readiness schema and risk classes.
- Day 2: Dry-run planner with side-effect preview.
- Day 3: Immutable audit event timeline.
- Day 4: Rollback/compensation template system.
- Day 5: Prompt-injection and allowlist checks.
- Day 6: Operator approve/deny/escalate UI.
- Day 7: End-to-end failure recovery demo.

## API Contract Stubs
- POST /api/prospect/lab0/actions/plan
  - Body: { connector, intent, payload }
  - Response: { plan_id, risk_score, dry_run_preview[] }
- POST /api/prospect/lab0/actions/:plan_id/approve
  - Body: { approver, rationale }
  - Response: { approved: true }
- POST /api/prospect/lab0/actions/:plan_id/execute
  - Response: { execution_id, status }
- POST /api/prospect/lab0/actions/:execution_id/rollback
  - Body: { reason }
  - Response: { rollback_status, compensation_steps[] }

## UI State Map
- planned -> dry_run_ready -> approved -> executed -> audited
- planned -> denied
- executed -> rollback_required -> compensated

Operator cards:
- High-risk actions awaiting approval
- Prompt-injection flagged attempts
- Rollback readiness score
- Audit completeness by connector

## Eval Metrics
- Audit coverage: 100% of actions produce immutable timeline.
- High-risk gate compliance: 100% require approval.
- Rollback guidance availability: >=90% for side-effect actions.
- Allowlist violation catch rate: >=95% on adversarial prompts.

## Demo Script (3 minutes)
1. Submit connector intent that appears valid but high-risk.
2. Show dry-run side effects and flagged injection signals.
3. Approve with operator context and execute.
4. Trigger controlled failure and run rollback flow.
5. Show immutable audit trail and postmortem summary.
