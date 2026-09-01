# Wave 1 Outreach Execution Board

**Start Date:** 2026-07-17  
**Target:** Convert 126 extracted contacts into measurable sales pipeline  
**Goal:** 20 strategy calls booked, 6 proposals ready by end of Week 2

---

## Current Dataset: contacts_outreach_wave1.csv

**Total contacts:** 126 normalized phone numbers  
**Status fields:**
- `phone`: Normalized 254XXX format
- `status`: new | attempted | contacted | qualified | proposal | closed | declined | unreachable
- `priority`: unscored | high | medium | low (to be scored)
- `segment`: empty (to be populated by vertical)
- `outreach_attempt`: counter (increments each touch)
- `last_contact`: ISO timestamp of last touch
- `response`: brief reaction
- `outcome`: qualified | not_interested | wrong_person | need_followup | etc
- `notes`: open field for context

---

## Wave 1 Segmentation Strategy

Based on your system's strongest verticals (ICT, solar, logistics, construction, medical/equipment):

### Segment A: High-Ticket ($5K-$25K pilots)
- Construction suppliers
- ICT system integrators
- Medical equipment suppliers
- Expected conversion: 15-20% → ~3-4 pilots in Wave 1

### Segment B: Mid-Ticket ($2K-$7.5K pilots)
- Solar EPC companies
- Logistics operators
- Equipment distributors
- Expected conversion: 20-25% → ~5-6 pilots in Wave 1

### Segment C: Lower-ticket or exploration
- General SMEs
- Unknown verticals
- Expected conversion: 5-10% → 1-2 exploratory opportunities

---

## Daily Execution Template (Update contacts_outreach_wave1.csv)

### Morning standup (15 min)
- Count new → attempted
- Flag any responses from yesterday
- Pick next 10 contacts for today's outreach batch

### Midday execution (1-2 hours)
- Send WhatsApp discovery message to batch
- Log phone in `last_contact` with timestamp
- Set status = "attempted"
- Record initial response (if immediate) or keep status as "attempted"

### Evening review (15 min)
- Capture any inbound responses
- Move qualified to "contacted" → priority = "high"
- Schedule followup for non-responders (24-48 hour retry)
- Update `notes` with discovery signals

### Weekly summary (Friday EOD)
- Count: new → attempted → contacted → qualified
- Identify top 10 hottest prospects
- Prepare week 2 strategy calls and proposals

---

## Sample Outreach Message (Customize Per Segment)

### For ICT/Security:
> Hi [Name], I'm David at Alphadome. We help ICT integrators automate quotation, tendering, and operations via AI agents. I noticed [Company] handles [Service]. Would you be open to a 20-min call to explore AI-driven tender acceleration for [Your niche]? [Link to strategy call booking]

### For Solar EPC:
> Hi [Name], Alphadome automates BOQ generation, compliance checklists, and proposal workflows for solar companies. This cuts quotation time from 4h to 30min. Interested in a quick demo for [Your company]? [Link]

### For Logistics:
> Hi [Name], AI shipment tracking, exception alerts, and customer notifications—all in WhatsApp. Cuts manual ops by 60%. Sound useful for [Your company]? [Link]

---

## Week 1 KPI Checklist

- [ ] 30 contacts moved from "new" to "attempted"
- [ ] 5+ responses or callbacks received
- [ ] 2+ "qualified" status contacts with next steps scheduled
- [ ] 0 contacts marked as "unreachable" (retry before escalating)

## Week 2 KPI Checklist

- [ ] 80 total contacts attempted (cumulative)
- [ ] 15+ qualified conversations completed
- [ ] 5+ scheduled strategy calls
- [ ] 2+ prospects moved to proposal stage

---

## Escalation: Non-Response or Wrong Person

If no response after 2 attempts (separated by 24-48 hours):
- Mark as "unreachable" temporarily
- Move to Wave 2 (days 15-21) for retry
- Do not discard; retry in context of other outreach signals

If "wrong person" identified:
- Ask for right contact name/number
- Log in notes
- Create new row if number is provided
- Thank them for the referral

---

## Success Signal Examples

**High Intent:**
- Asks about pricing
- Requests demo or call
- Describes specific pain point matching your system

**Medium Intent:**
- Asks "Tell me more"
- Provides company details
- Schedules call but with hesitation

**Low Intent / Defer:**
- "Send info via email" (lower conversion; log but deprioritize)
- "Call back next month" (log and calendar for Week 3 retry)
- "Not relevant right now" (note and close, unless strong fit signal)

---

## Next Actions

1. **Today:** Review the current 126 contacts and manually segment into A/B/C by company type if identifiable from phone patterns or DOCX notes
2. **Tomorrow:** Start outreach batch 1 (contacts 1-10) using your strongest vertical pitch
3. **Daily:** Update CSV status as responses come in
4. **Weekly:** Review pipeline conversion and adjust messaging

---

Contact list updated daily via:
```bash
powershell -ExecutionPolicy Bypass -File scripts/contacts/check_contact_docx_progress.ps1
```

Current count: 126 contacts  
Target growth: 126 → 250+ by end of Month 1
