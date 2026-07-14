# Alphadome Website Upgrade Implementation Roadmap

**Status:** Ready to Deploy  
**Date:** July 14, 2026  
**Owner:** [Your Name]  
**Timeline:** 2 weeks to full launch

---

## PHASE 1: IMMEDIATE (THIS WEEK)

### 1.1 Homepage Swap
- [ ] Back up current `index.html` to `index.html.backup`
- [ ] Deploy `homepage-updated.html` → replace or link from main site
- [ ] Test all buttons + forms on mobile and desktop
- [ ] Set up form submission handling (webhook to Slack + email notification)
- [ ] Verify all external links work (portfolio, demo, contact)

**Owner:** [Dev]  
**Effort:** 4 hours

---

### 1.2 Discovery Form Setup
- [ ] Deploy `client-discovery-form.html` to `/discovery` or `/questionnaire`
- [ ] Integrate form submission API to save responses (Supabase or email)
- [ ] Set up auto-reply email confirmation (Email 1: Thank You)
- [ ] Create internal Slack webhook to alert team of new submissions
- [ ] Test form end-to-end (fill it out, verify email arrives, check database)

**Owner:** [Dev]  
**Effort:** 6 hours

---

### 1.3 Email Automation Setup
- [ ] Connect email provider (Gmail, SendGrid, or Mailchimp)
- [ ] Create email templates for 7-email onboarding sequence
- [ ] Set up automation triggers:
  - Day 0: Send form confirmation email (Email 1)
  - Day 1: Send pre-call prep email (Email 2)
  - Day 3 (if no response): Send check-in email
  - Post-call: Send proposal email (Email 3) [manual for now]
- [ ] Test each email template (preview + send to test account)

**Owner:** [Growth/Email]  
**Effort:** 8 hours

---

### 1.4 Documentation Deployment
- [ ] Upload all copy documents to `/public/docs/` or knowledge base:
  - `WEBSITE_POSITIONING_GUIDE.md`
  - `WEBSITE_COPY_LIBRARY.md`
  - `CLIENT_ONBOARDING_EMAIL_SEQUENCE.md`
- [ ] Create internal wiki/Notion page linking all resources
- [ ] Share with sales + marketing team
- [ ] Schedule 1-hour training on new messaging framework

**Owner:** [Marketing]  
**Effort:** 3 hours

---

### 1.5 Sales Call Prep
- [ ] Share discovery call script with team
- [ ] Brief [Project Lead] on new onboarding flow
- [ ] Set up Calendly for scheduling discovery calls (limit to 30-min slots)
- [ ] Create Slack reminder for 24-hour pre-call check-in

**Owner:** [Sales Lead]  
**Effort:** 2 hours

---

## PHASE 2: THIS WEEK (PARALLEL)

### 2.1 Website Navigation Updates
- [ ] Add "Discover Your 3.0" CTA button to existing pages (main nav or top banner)
- [ ] Update footer with links to:
  - New discovery form
  - How Co-Ownership Works (create explainer doc)
  - Pricing page (update existing with new tiers)
  - Client Case Studies (when available)
- [ ] Ensure all CTAs point to correct URLs

**Owner:** [Dev]  
**Effort:** 3 hours

---

### 2.2 Create Supporting Landing Pages
- [ ] **For Business Owners:** `/for-business-owners.html` (pain-focused, quick win)
- [ ] **For Agencies:** `/for-agencies.html` (recurring revenue focus, multi-tenant)
- [ ] **For Investors:** `/for-investors.html` (ownership + upside focus)
- [ ] **Pricing Page Update:** `/pricing.html` (new tiers + ownership model explanation)
- [ ] **How Co-Ownership Works:** `/how-ownership-works.html` (visual explainer + mechanics)

**Owner:** [Dev + Marketing]  
**Effort:** 12 hours

---

### 2.3 Portfolio Update
- [ ] Update `/portfolio.html` and `/portfolio-viewer.html` to frame each agent as a custom "3.0 System"
- [ ] Add 1-paragraph description for each deployed system explaining:
  - What client pain it solved
  - How AI agents automate their workflows
  - Ownership structure (if public-safe)
- [ ] Add "This could be your 3.0" CTA at bottom of each portfolio card

**Owner:** [Dev + Marketing]  
**Effort:** 4 hours

---

## PHASE 3: NEXT WEEK (VALIDATION)

### 3.1 A/B Testing Setup
- [ ] Deploy A/B test: Current hero vs. new hero (50/50 traffic split)
- [ ] Track KPIs:
  - Click-through rate to discovery form
  - Form completion rate
  - Time on page
  - Bounce rate
- [ ] Run test for 5-7 days
- [ ] Analyze results; keep winning variant

**Owner:** [Analytics]  
**Effort:** 4 hours setup + 10 min/day monitoring

---

### 3.2 Sales Enablement
- [ ] Create 1-page PDF "Elevator Pitch" (3.0 model overview)
- [ ] Record 5-min video demo: "What is a 3.0 System?"
- [ ] Prepare 3-5 client case study templates (fill them as you close deals)
- [ ] Create Slack sales channel for deal tracking + playbook

**Owner:** [Sales + Marketing]  
**Effort:** 6 hours

---

### 3.3 Customer Success Playbook
- [ ] Document post-sale onboarding checklist (Week 1-4 templates)
- [ ] Create 30-day review template (metrics, wins, next steps)
- [ ] Prepare handoff process from sales → project lead → success manager
- [ ] Set calendar reminders for monthly success calls

**Owner:** [Project Delivery]  
**Effort:** 5 hours

---

## PHASE 4: WEEK 2 (OPTIMIZATION)

### 4.1 Metrics Dashboard
- [ ] Set up Mixpanel or Segment to track:
  - Discovery form submissions (by source)
  - Discovery call scheduling rate
  - Proposal close rate (proposals sent → deals signed)
  - Time-to-value (days from kickoff to live)
- [ ] Create weekly dashboard for leadership review

**Owner:** [Analytics]  
**Effort:** 6 hours

---

### 4.2 Feedback Loop
- [ ] After first 5 discovery calls, review notes for common objections/confusion
- [ ] Iterate copy if needed (especially FAQ section)
- [ ] Collect qualitative feedback: What's resonating? What's confusing?
- [ ] Update messaging library based on learnings

**Owner:** [Sales Lead + Marketing]  
**Effort:** 3 hours

---

### 4.3 Public Relations
- [ ] Prepare press release: "Alphadome Introduces Co-Ownership Model for AI Operating Systems"
- [ ] Identify 10-15 target publications / newsletters to pitch
- [ ] Reach out to industry contacts about new positioning
- [ ] Prepare LinkedIn/Twitter thread about 3.0 model launch

**Owner:** [Marketing]  
**Effort:** 8 hours

---

## PHASE 5: ONGOING (WEEKLY)

### 5.1 Content Production
- [ ] Blog post: "How Co-Ownership Changes the Game" (target: 1000 words)
- [ ] Blog post: "3.0 Systems vs. Traditional Automation" (comparison)
- [ ] Video series: 5-10 min client testimonials (as you close deals)
- [ ] Case studies: Document each new client's journey (with permission)

**Owner:** [Content]  
**Effort:** 4-5 hours/week

---

### 5.2 Sales Playbook Refinement
- [ ] Track discovery call outcome rates (% that lead to proposals)
- [ ] Track proposal close rates
- [ ] Identify what's working vs. what needs adjustment
- [ ] Update discovery call script based on data
- [ ] Share wins (closed deals, ROI results) in team Slack

**Owner:** [Sales Lead]  
**Effort:** 3 hours/week

---

### 5.3 Customer Success Reviews
- [ ] Monthly check-in calls with new customers (first 90 days)
- [ ] Collect NPS + feedback
- [ ] Document ROI achieved vs. blueprint
- [ ] Get permission for testimonials / case study

**Owner:** [Project Lead]  
**Effort:** 2-3 hours/week

---

## DEPLOYMENT CHECKLIST

### Pre-Launch (Before Going Public)
- [ ] Test all forms on Chrome, Safari, Firefox, mobile
- [ ] Verify all links work (no 404s)
- [ ] Check email deliverability (test spam filters)
- [ ] Confirm domain/SSL is set up
- [ ] Back up current website
- [ ] Prepare rollback plan if issues arise

### Launch Day
- [ ] Deploy all updated assets
- [ ] Monitor for errors (check server logs + user feedback)
- [ ] Send team Slack announcement
- [ ] Prepare "launch day" email to past inquiries with new discovery form

### Post-Launch (First Week)
- [ ] Daily standup to review incoming discovery forms
- [ ] Monitor website metrics (traffic, form submission rate, errors)
- [ ] Get feedback from first 3-5 discovery calls
- [ ] Iterate quickly if something isn't working

---

## SUCCESS METRICS (2-WEEK REVIEW)

### Expected Outcomes
| Metric | Target | Status |
|--------|--------|--------|
| Website traffic to new homepage | +20% | TBD |
| Discovery form submissions | 5-10 per week | TBD |
| Discovery call scheduling rate | 60%+ of submissions | TBD |
| Proposal close rate | 60%+ of calls | TBD |
| Time-to-first-proposal | 3-5 days | TBD |
| Customer NPS (post-launch) | 8+/10 | TBD |

---

## COMMON ISSUES & SOLUTIONS

### Issue: Discovery form not submitting
**Solution:** Check email backend, verify form submission API, test with browser console

### Issue: Low form completion rate (<30%)
**Solution:** Shorten form (remove non-critical questions), add progress bar, simplify language

### Issue: High proposal-to-close ratio but low discovery-to-proposal
**Solution:** People interested but confused by discovery. Simplify discovery process or add explainer video.

### Issue: Sales team confused by new messaging
**Solution:** Run training session, create 1-page cheat sheet, pair experienced rep with new rep

---

## TIMELINE SUMMARY

| Week | Milestone | Owner | Status |
|------|-----------|-------|--------|
| Week 1 | Phase 1 + 2 (homepage, forms, emails, landing pages) | Dev + Marketing | IN PROGRESS |
| Week 2 | Phase 3 + 4 (A/B testing, sales enablement, metrics) | Analytics + Sales | PENDING |
| Ongoing | Phase 5 (content, playbook, success reviews) | Content + Sales | PENDING |

---

## COMMUNICATION PLAN

### Internal
- **Daily:** Slack channel #alphadome-website-launch (issues, wins, questions)
- **Weekly:** Friday standup (metrics, feedback, next priorities)
- **Bi-weekly:** All-hands update (CEO shares progress, celebrates wins)

### External (If Relevant)
- **Day 1:** Email current customers/inquiries about new 3.0 model
- **Day 3:** LinkedIn + Twitter announcement of new positioning
- **Week 1:** First press outreach
- **Ongoing:** Blog + content updates

---

## BUDGET ESTIMATE

| Item | Cost | Notes |
|------|------|-------|
| Development (forms, integrations) | $2,000-3,000 | 20-30 hours @ $100/hr |
| Email automation setup | $500-1,000 | SendGrid or Mailchimp setup + templates |
| Analytics setup | $500 | Mixpanel/Segment integration |
| Design refinement (if needed) | $1,000-2,000 | Minimal; mostly copy-focused |
| Content creation | $1,000-1,500 | Case studies, blog posts, videos |
| **Total** | **$5,500-8,000** | One-time investment |

---

## APPROVAL & SIGN-OFF

- [ ] **CEO/Founder:** Approve messaging positioning
- [ ] **Sales Lead:** Approve discovery process + scripts
- [ ] **Dev Lead:** Approve technical implementation plan
- [ ] **Marketing Lead:** Approve content + rollout

---

## NEXT STEPS (DO THIS TODAY)

1. **Review & Approve:** All stakeholders review this roadmap + documents
2. **Assign Owners:** Confirm who's doing what
3. **Kickoff Meeting:** 30 min with full team to align on timeline + dependencies
4. **Start Phase 1:** Dev + Marketing begin immediate work
5. **Daily Check-ins:** 15-min Slack huddle each morning to unblock

---

**Let's build something great.** This positioning change is a game-changer. Let's execute flawlessly.
