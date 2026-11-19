# Brokered-data targets — the 15-firm pass

**Written:** 2026-11-19 · **Companion to:** `docs/BROKERED_DATA_SHORTLIST.md` (targets, the
ask, expectations) · **Goal:** 15 firms that own engineering records, in the six sectors
Hashlist's form actually buys

## The qualifying test (one question, ~30 seconds)

> *"Do you keep records of equipment failing — commissioning sheets, warranty claims,
> service reports, calibration logs, or the control logic you install?"*

Yes → candidate. No → done, and we spent a minute. Never pitch the licence on a first
contact; the ask is a 20-minute call about what records exist.

## Six sectors, fifteen queries

| # | Sector | What they hold | Search queries (do each once, note the firms) |
|---|---|---|---|
| 1 | Solar / energy EPC | commissioning sheets, inverter faults, string test reports, calibration | `solar EPC Kenya commissioning report`, `solar installer Nairobi O&M contract`, `solar minigrid Kenya commissioning` |
| 2 | Water utilities / boreholes | pump failure logs, flow calibration, commissioning punch lists | `water utility Kenya SCADA`, `borehole drilling company Kenya pump maintenance`, `water treatment plant Kenya automation` |
| 3 | Food & beverage manufacturing | line stoppages, 8D reports, PLC programs, calibration | `food processing plant Nairobi automation`, `dairy processor Kenya packaging line`, `bakery plant Kenya PLC` |
| 4 | Plastics / packaging | mould changeovers, rejects, machine faults, PLC | `plastics manufacturer Kenya injection moulding`, `packaging plant Nairobi maintenance` |
| 5 | Cold chain / cold rooms | temperature logs, spoilage incidents, cold-room commissioning | `cold room installation Kenya`, `cold chain logistics Nairobi temperature monitoring` |
| 6 | Automotive / fleet workshops | job cards, warranty claims, diagnostics, service bulletins | `fleet maintenance company Kenya diagnostics`, `vehicle assembly Kenya quality`, `equipment dealer Kenya service reports` |

For each result record: **firm, sector, the record type they likely hold, and the role to
ask for** (maintenance manager, quality manager, engineering manager, operations director).
Those four fields are what make the approach specific instead of a mailshot.

## Import shape (your existing pipeline, no new tooling)

Rows go into `ABOSS_RESEARCH_QUEUE.csv` (same header as `ABOSS_READY_TO_CONTACT.csv`):

```
organization,industry,priority_score,urgency_bucket,target_role,contact_name,email,phone,ready_channel,status,approach_subject,approach_opening,research_query_1,research_query_2,research_query_3,research_query_4,website,source_url,next_action
```

| Column | What to put |
|---|---|
| `organization` | the firm |
| `industry` | one of: `energy_epc`, `water_utility`, `food_manufacturing`, `plastics`, `cold_chain`, `automotive_service` |
| `priority_score` | 1–10; score by *evidence of records*, not by size |
| `target_role` | maintenance / quality / engineering manager |
| `status` | `research` until the qualifying answer is known |
| `approach_subject` | `Question about your equipment failure records` |
| `approach_opening` | the qualifying test, verbatim |
| `research_query_1..4` | the queries above that found them |
| `next_action` | `ask the qualifying question` |

## Three rows ready to import today

These come from the existing pipeline (`docs/DATA_BROKER_SHORTLIST.md`), not from new
research — they are the only present candidates whose records plausibly match:

```csv
organization,industry,priority_score,urgency_bucket,target_role,contact_name,email,phone,ready_channel,status,approach_subject,approach_opening,research_query_1,research_query_2,research_query_3,research_query_4,website,source_url,next_action
Twiga / Sokowatch, cold_chain,7,medium,Operations Manager,,,,whatsapp,research,Question about your equipment failure records,"Do you keep records of equipment failing - cold store commissioning, temperature calibration, spoilage incidents?",cold room installation Kenya,cold chain logistics Nairobi temperature monitoring,,,,"ask the qualifying question"
M-Gas, energy_epc,7,medium,Partnerships Lead,,,,whatsapp,research,Question about your equipment failure records,"Do you keep records of equipment failing - cylinder safety incidents, calibration, regulator inspections?",LPG distribution Kenya safety,LPG cylinder tracking Kenya,,,,"ask the qualifying question"
Siginon Group, automotive_service,6,low,Operations Manager,,,,whatsapp,research,Question about your equipment failure records,"Do you keep records of equipment failing - warehouse automation faults, maintenance job cards, incident logs?",warehouse automation Kenya,logistics fleet maintenance Kenya,,,,"ask the qualifying question"
```

## What not to do

- **Do not submit a firm's data without written consent.** The introduction option exists,
  but the owner signs.
- **Do not quote the $100,000 ceiling.** The sample fee ($500–$5,000) is the real number;
  the ceiling is marketing, and promising it to a Kenyan SME destroys the relationship when
  it does not land.
- **Do not run this through the tenant WhatsApp broadcast.** These are business-development
  conversations, not marketing — one message, one firm, a named person.

## Scoreboard

| Step | State |
|---|---|
| Sectors and queries written | ✓ this file |
| 3 existing candidates ready to contact | ✓ above |
| 15 firms named with contacts | ✗ next 90 minutes, using the queries |
| Qualifying question asked of 5 firms | ✗ |
| First call held | ✗ |
