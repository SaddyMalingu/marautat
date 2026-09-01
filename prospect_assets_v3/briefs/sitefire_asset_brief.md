# Brand Asset Brief

## Brand
- Name: Sitefire
- Role link: https://www.workatastartup.com/jobs/98761
- Primary contact surface (from page): Jochen (CEO), Vincent (CTO), WAAS apply endpoint

## Target Buyer
- Founders and first product/agent operators scaling GEO actions from analytics to execution.

## Workflow Being Solved
- Current pain: Teams can see visibility signals but struggle to operationalize daily GEO actions with reliable quality loops.
- Desired outcome: Actionable GEO queue with confidence, feedback loops, and clear impact tracking.

## Reusable Alphadome Components
- Qualification/scoring pipeline for prioritization logic
- Multi-step workflow orchestration patterns
- Monitoring and exception handling surfaces

## Minimal Implementation Slice (7 days)
- Day 1: Define GEO action object model (signal, confidence, action type, owner).
- Day 2: Build prioritization scorer for action queue.
- Day 3: Add customer-control approval state (auto, review, blocked).
- Day 4: Add connector stubs (CMS, analytics export, tasking endpoint).
- Day 5: Add eval loop: action accepted/rejected and quality feedback capture.
- Day 6: Add dashboard view for action throughput and quality drift.
- Day 7: Package demo + product note mapped to first-90-day role outcomes.

## Success Metric
- Produce a ranked GEO action queue where >=80% of top-10 actions are accepted by reviewer in simulation.

## Risks
- Technical risk: Sparse context can mis-rank high-impact actions.
- Product risk: Quality controls may slow team velocity.
- Delivery risk: Real connector behavior differs from mocks.

## Next Validation Step
- Share demo and request CTO-level feedback on evaluation loop shape and connector priority.

## Deliverables
- Demo artifact: GEO action loop from signal -> action -> feedback.
- Architecture note: Scoring model + control states + connector boundaries.
- Eval/failure note: False-positive action classes and mitigation plan.
