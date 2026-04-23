# ✅ 7-Day Revenue Checklist

Keep this file open and check off items as you complete them. Run daily!

---

## 🟢 DAY 1: Tenant Onboarding & Verification

**Target: 2-3 hours | Deadline: End of Day 1**

### Tenant Configuration
- [ ] Access Supabase SQL Editor
- [ ] Verify Kassangas tenant exists in bot_tenants table
- [ ] Check tenant status = "active" and is_active = true
- [ ] Update client_email if needed
- [ ] Record tenant ID for future use

### M-Pesa Verification  
- [ ] Confirm MPESA_CONSUMER_KEY in .env
- [ ] Confirm MPESA_CONSUMER_SECRET in .env
- [ ] Verify MPESA_SHORTCODE = 174379 (sandbox) or your actual code
- [ ] Run OAuth test: `node check_revenue_readiness.js`
- [ ] Create/verify Daraja account at https://developer.safaricom.co.ke

### WhatsApp Setup
- [ ] Get Kassangas WhatsApp phone number ID from Meta Business Manager
- [ ] Update bot_tenants.whatsapp_phone_number_id
- [ ] Update bot_tenants.whatsapp_access_token
- [ ] Test WhatsApp API with a test message

### Verify Callback URL
- [ ] Check MPESA_CALLBACK_URL in .env points to your server
- [ ] Test URL is publicly accessible: curl -I $MPESA_CALLBACK_URL
- [ ] Server is running and listening on port 3000

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 2: Product Catalog Setup

**Target: 2-3 hours | Deadline: End of Day 2**

### Add Products
- [ ] Open Supabase SQL Editor
- [ ] Insert 5 test products (Guitar, Microphone, Amp, Drums, Cables)
- [ ] Verify each product has:
  - [ ] SKU (e.g., KASS-GTR-001)
  - [ ] Name
  - [ ] Description
  - [ ] Price in KES
  - [ ] Stock count > 0
  - [ ] is_active = true
- [ ] Query: `SELECT sku, name, price FROM bot_products WHERE bot_tenant_id = 'XXX'`

### Upload Images (Optional)
- [ ] Visit: http://localhost:3000/admin/simple?key=alphadome-admin-2026
- [ ] Upload images for each product
- [ ] Match filenames to SKUs (KASS-GTR-001.jpg)

### Test API Access
- [ ] Run: `node check_revenue_readiness.js`
- [ ] Verify "Product Catalog" check passes
- [ ] Catalog endpoint returns items

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 3: Payment Flow Testing (Sandbox)

**Target: 3-4 hours | Deadline: End of Day 3**

### Set Up Test Account
- [ ] Register test M-Pesa account with Safaricom
- [ ] Use phone: 254712345678
- [ ] Ensure it has test funds available
- [ ] Note passkey: bfb279f9aa9bdbcf158e97dd71a467cd2e0ff47d43249d1c

### Run End-to-End Test
- [ ] Start server: `npm start`
- [ ] Send message from test phone: "JOIN ALPHADOME"
- [ ] Bot asks for payment phone
- [ ] Reply: "254712345678"
- [ ] STK prompt appears on phone
- [ ] Check Daraja logs for STK push
- [ ] Complete payment flow

### Verify Payment Processing
- [ ] Check subscriptions table: payment recorded
- [ ] Status shows as "paid" or "subscribed"
- [ ] User received confirmation message
- [ ] Receipt number captured

### Test Product Purchase Flow
- [ ] Send message: "BUY KASS-GTR-001"
- [ ] Bot asks for payment phone
- [ ] Complete payment same as above
- [ ] Verify order recorded

### Test Different Scenarios
- [ ] Test payment with "same" (use WhatsApp number)
- [ ] Test with different phone formats (0712, 254712, +254712)
- [ ] Test failed payment scenario
- [ ] Test cancelled payment scenario

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 4: Production M-Pesa Setup

**Target: 2-3 hours | Deadline: End of Day 4**

### Switch to Production
- [ ] Change `MPESA_ENV=sandbox` → `MPESA_ENV=production`
- [ ] Update `MPESA_SHORTCODE` to actual code (not 174379)
- [ ] Get production shortcode from Safaricom
- [ ] Update `MPESA_PASSKEY` if different
- [ ] Restart server: `npm stop && npm start`

### Register Callback URL
- [ ] Log into Daraja dashboard
- [ ] Switch app to "Production" mode
- [ ] Register callback URL (whitelist)
- [ ] Test callback endpoint is reachable

### Test with Real Money
- [ ] Do NOT use real customer money
- [ ] Use test account with real cash funded
- [ ] Send payment: 100-500 KES
- [ ] Verify:
  - [ ] STK prompt appears
  - [ ] User completes payment
  - [ ] Callback received
  - [ ] Subscription marked as paid
  - [ ] Money arrives in business account within 1 hour

### Verify No Errors
- [ ] Check logs: `tail -f logs/bot.log | grep -i error`
- [ ] Run: `node check_revenue_readiness.js`
- [ ] All checks should pass ✅

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 5: Tenant Dashboard & Analytics

**Target: 2-3 hours | Deadline: End of Day 5**

### Access Dashboard
- [ ] URL: http://localhost:3000/tenant-dashboard?key=254702245555
- [ ] Verify dashboard loads without errors
- [ ] Can see products listed
- [ ] Can see customers section

### Check Analytics Endpoints
- [ ] `/tenant/analytics` - See conversation volume
- [ ] `/tenant/revenue` - See payment trends
- [ ] `/tenant/products/performance` - See product popularity
- [ ] `/tenant/customers` - See customer list
- [ ] `/tenant/orders` - See transaction history

### Set Up Auto-Responses
- [ ] Configure common replies (hi, hours, warranty, etc.)
- [ ] Test auto-response triggers
- [ ] Verify instant replies work

### Test Real-Time Monitoring
- [ ] Send test message as customer
- [ ] Verify appears in /tenant/customers
- [ ] Check /tenant/analytics updates in real-time

### Monitor Payment Logs
- [ ] Query: `SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 10;`
- [ ] Verify all fields populated correctly
- [ ] Check metadata contains M-Pesa details

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 6: Go-Live Preparation & Marketing

**Target: 3-4 hours | Deadline: End of Day 6**

### Security Audit
- [ ] Verify no credentials logged in .log files
- [ ] Check ADMIN_PASS is strong and changed
- [ ] Verify TENANT_DASHBOARD_PASS set correctly
- [ ] Run: `node check_revenue_readiness.js` (should all pass)

### Set Up Monitoring
- [ ] Create dashboard query for daily revenue
- [ ] Set up error alerts (check logs hourly)
- [ ] Configure escalation keywords
- [ ] Test with "/help" command

### Prepare Customer Announcement
- [ ] Draft WhatsApp message for existing customers
- [ ] Include commands (CATALOG, BUY SKU, JOIN ALPHADOME)
- [ ] Include support contact numbers
- [ ] Proofread for grammar/clarity

### Create Support Documentation
- [ ] Create FAQ for common issues
- [ ] Document escalation process
- [ ] Train team on dashboard access
- [ ] Document daily monitoring checklist

### Test Full Flow One More Time
- [ ] Send: "CATALOG"
- [ ] Bot shows products ✅
- [ ] Send: "BUY KASS-GTR-001"
- [ ] Complete payment ✅
- [ ] Verify order in dashboard ✅
- [ ] Check revenue appears ✅

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 🟢 DAY 7: Go-Live & First Sales

**Target: 2-3 hours | Deadline: End of Day 7**

### Deploy Latest Code
- [ ] `git add -A`
- [ ] `git commit -m "feat: activate revenue stream"`
- [ ] `git push origin main`
- [ ] Verify deployed successfully
- [ ] `npm restart` if self-hosted

### Send Customer Announcements
- [ ] Send WhatsApp broadcast to existing customers
- [ ] Include "BUY", "CATALOG", "JOIN ALPHADOME" commands
- [ ] Include support numbers for help
- [ ] Post on social media if applicable

### Monitor Live Activity
- [ ] Check conversation count every 30 minutes
- [ ] Monitor incoming messages
- [ ] Check for payment attempts
- [ ] Respond to issues immediately

### Process First Payments
- [ ] Wait for first real customer message ✅
- [ ] First customer initiates payment ✅
- [ ] First payment completed successfully ✅
- [ ] Send thank you message ✅
- [ ] Record in /tenant/orders ✅

### Track Revenue
- [ ] Query daily sales: 
  ```sql
  SELECT SUM(amount) as total_revenue 
  FROM subscriptions 
  WHERE status IN ('completed', 'active', 'paid')
    AND created_at > NOW() - INTERVAL '24 hours';
  ```
- [ ] Expected: KES 0 - 50,000 on Day 7 (first day)
- [ ] Take screenshot of first sale ✅

### Fix Any Issues
- [ ] Check logs for errors: `grep ERROR logs/bot.log | tail -20`
- [ ] Fix payment failures if any
- [ ] Escalate technical issues to support

**Status:** ⭕ Not Started | 🟡 In Progress | 🟢 Complete
Current: _____

---

## 📊 Daily Checklist Runner

Use this command to verify checkout status each morning:

```bash
# Day 1
node check_revenue_readiness.js

# Day 2
curl http://localhost:3000/tenant/catalog -H "x-tenant-key: 254702245555"

# Day 3
tail -100 logs/bot.log | grep -i "payment\|stk\|error"

# Day 4
curl http://localhost:3000/tenant/revenue -H "x-tenant-session-token: YOUR_TOKEN"

# Day 5
psql -h $DB_HOST -c "SELECT COUNT(*) as sales, SUM(amount) as revenue FROM subscriptions WHERE created_at > NOW() - INTERVAL '24 hours';"

# Day 6-7
curl http://localhost:3000/tenant/customers -H "x-tenant-session-token: YOUR_TOKEN"
```

---

## 🎯 Success Criteria

### End of Day 3
- ✅ Payment system tested in sandbox
- ✅ 3+ test transactions completed
- ✅ No errors in logs

### End of Day 6
- ✅ Production M-Pesa active
- ✅ Dashboard accessible
- ✅ Team trained on operations

### End of Day 7
- ✅ First real customer message received
- ✅ First payment initiated and completed
- ✅ Revenue visible in dashboard
- ✅ All systems stable (no critical errors)

---

**Updated:** $(date)
**Status:** 🟡 IN PROGRESS
**Blockers:** None
**Next Action:** Complete Day 1 checklist ⬇️

Notes:
_______________________________________________
_______________________________________________
_______________________________________________
