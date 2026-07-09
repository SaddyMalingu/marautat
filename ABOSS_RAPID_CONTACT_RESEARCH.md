# A Boss Rapid Contact Research Queries

Use this to source high-relevance contacts quickly from web search, directories, and LinkedIn.

## Query Set (Kenya Focus)

1. `site:ke "retail" "Nairobi" "contact"`
2. `site:ke "retail" "Nairobi" "about us"`
3. `"retail" "Nairobi" "info@"`
4. `"retail" "Nairobi" "+254"`
5. `site:ke "hospitality" "Nairobi" "contact"`
6. `site:ke "hotel" "Nairobi" "management"`
7. `"hospitality" "Nairobi" "reservations" "email"`
8. `"hotel" "Nairobi" "+254"`
9. `site:ke "professional services" "Nairobi" "contact"`
10. `"consulting" "Nairobi" "partners" "email"`
11. `"law firm" "Nairobi" "contact us"`
12. `"accounting firm" "Kenya" "email"`
13. `site:ke "logistics" "Kenya" "contact"`
14. `"courier" "Nairobi" "customer care" "email"`
15. `"transport" "Kenya" "+254" "operations"`
16. `site:linkedin.com "Nairobi" "Head of Operations" "retail"`
17. `site:linkedin.com "Kenya" "Business Development Manager" "hospitality"`
18. `site:linkedin.com "Nairobi" "CEO" "SME"`
19. `"Kenya" "small business" "contact us" "email"`
20. `"Nairobi" "automation" "business" "contact"`

## Capture Template (CSV Columns)

- `organization`
- `website`
- `contact_name`
- `role`
- `email`
- `phone`
- `source_url`
- `industry`
- `intent_signal`
- `priority_score` (1-100)

## Priority Scoring Rule

- +40 if decision-maker title found (CEO/Founder/Operations/BD)
- +25 if direct email present (not generic form)
- +20 if phone present
- +15 if recent activity signal (news/post/update)

## Outreach Quality Rule

- Do not send to contacts without role context unless volume is needed.
- Prefer role + direct email + phone triad.
- Cap first-touch to one message per channel per contact today.