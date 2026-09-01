# CharacterQuilt Demo Spec

## Objective
Show a failure replay and evaluation loop that turns real agent-runtime incidents into durable reliability and quality improvements.

## 7-Day Build Map
- Day 1: Failure capture schema (context, tools, side effects).
- Day 2: Replay manifest and deterministic rerun contract.
- Day 3: Failure taxonomy and severity model.
- Day 4: Eval testcase generation from replay artifacts.
- Day 5: Runtime + quality dashboard cards.
- Day 6: Approval checkpoints before external side effects.
- Day 7: One complete incident replay demonstration.

## API Contract Stubs
- POST /api/prospect/characterquilt/incidents
  - Body: { run_id, stage, failure_type, context, side_effects }
  - Response: { incident_id }
- POST /api/prospect/characterquilt/incidents/:id/replay
  - Body: { mode: "deterministic"|"diagnostic" }
  - Response: { replay_id, status }
- POST /api/prospect/characterquilt/incidents/:id/eval
  - Response: { test_case_id, expected_outcome }
- GET /api/prospect/characterquilt/quality/summary
  - Response: { mttd, mttr, repeat_failure_rate, top_classes[] }

## UI State Map
- incident_open -> replaying -> classified -> testcase_created -> resolved
- incident_open -> replay_failed -> manual_review

Operator cards:
- New incidents by class
- Replay success rate
- Repeat-failure trend
- Approval checkpoint breaches prevented

## Eval Metrics
- Replayability rate for captured incidents: >=85%.
- Incident-to-testcase conversion: >=90%.
- Repeat-failure reduction in simulation window: >=25%.
- Manual escalation precision: >=90% for non-replayable incidents.

## Demo Script (3 minutes)
1. Load a failed agent run with context snapshot.
2. Replay incident deterministically.
3. Classify root cause and auto-create testcase.
4. Rerun with patch and show improved outcome.
5. Show quality dashboard trend shift.
