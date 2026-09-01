# Brand Asset Brief

## Brand
- Name: AgentPhone
- Role link: https://www.workatastartup.com/jobs/98603
- Primary contact surface (from page): CEO/CTO founders (brothers), WAAS apply endpoint

## Target Buyer
- Founders and first infra engineer responsible for telephony deliverability, compliance, and customer-facing reliability.

## Workflow Being Solved
- Current pain: Agent telephony reliability breaks across carriers/channels with opaque failure signals.
- Desired outcome: Operational reliability assistant that classifies anomalies and routes recovery actions quickly.

## Reusable Alphadome Components
- Payment callback state-machine and fallback handling patterns
- Multi-channel notification/follow-up infrastructure
- Ops dashboard and escalation workflows

## Minimal Implementation Slice (7 days)
- Day 1: Define event schema for call/SMS/iMessage/RCS delivery lifecycle.
- Day 2: Implement anomaly classifier rule set (drop, delay, rejection, compliance block).
- Day 3: Add recovery action map (retry route, channel switch, manual verification).
- Day 4: Add compliance checklist state for A2P/KYC/TCR-related blockers.
- Day 5: Build operator dashboard for issue queue and SLA tracking.
- Day 6: Add customer-facing status summary endpoint.
- Day 7: Demo a failed-delivery scenario through recovery to resolution.

## Success Metric
- Classify >=90% of simulated delivery failures into actionable categories with a recommended next step.

## Risks
- Technical risk: Carrier-specific codes can be inconsistent.
- Product risk: Recovery recommendations may be too generic initially.
- Delivery risk: Real channel-provider payload variability.

## Next Validation Step
- Send demo with ask: validate top 5 failure categories they see most in production.

## Deliverables
- Demo artifact: Delivery anomaly triage and recovery flow.
- Architecture note: Event ingestion + classifier + action routing.
- Eval/failure note: Precision by failure category and ambiguity cases.
