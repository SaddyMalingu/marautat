# 🚀 7-Day Revenue Implementation Plan

**Goal:** Launch first paying tenant (Kassangas Music Shop) and process real transactions within 7 days.  
**Current Status:** System is 85% ready. M-Pesa integration exists. Need: tenant onboarding, products, testing, go-live.

---

## 📊 Daily Breakdown

### **DAY 1: Tenant Onboarding & Verification** (2-3 hours)

#### Task 1: Configure Telegram Kassangas as Active Tenant
```bash
# 1. Log into Supabase → SQL Editor
# 2. Run this query to verify tenant exists:
SELECT id, client_name, client_phone, status FROM alphadome.bot_tenants 
WHERE client_phone LIKE '%702245555%' OR client_name LIKE '%Kassangas%';

# 3. If not found, create tenant record:
INSERT INTO alphadome.bot_tenants 
(client_name, client_phone, client_email, status, is_active, created_at) 
VALUES 
('Kassangas Music Shop', '0702245555', 'gideon@kassangas.ke', 'active', true, NOW());
```

#### Task 2: Verify M-Pesa Credentials
- [ ] Verify `MPESA_CONSUMER_KEY` is valid (check in .env)
- [ ] Verify `MPESA_CONSUMER_SECRET` is valid (check in .env)
- [ ] Test with sandbox shortcode: 174379
- [ ] Create test account on Safaricom Daraja: https://developer.safaricom.co.ke
- [ ] Confirm `MPESA_CALLBACK_URL` points to correct server (currently `https://alphadome.onrender.com/mpesa/callback`)

#### Task 3: Test M-Pesa Integration
```bash
# Run this test script:
node -e "
const axios = require('axios');
const fetch = require('node-fetch');

// Step 1: Get OAuth token
const auth = Buffer.from(
  process.env.MPESA_CONSUMER_KEY + ':' + process.env.MPESA_CONSUMER_SECRET
).toString('base64');

fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
  method: 'GET',
  headers: { Authorization: 'Basic ' + auth }
})
.then(r => r.json())
.then(d => console.log('OAuth Token Valid:', !!d.access_token))
.catch(e => console.error('M-Pesa Auth Failed:', e.message));
"
```

#### Task 4: Update WhatsApp Phone Number ID
```sql
-- Add Kassangas WhatsApp details if not present:
UPDATE alphadome.bot_tenants 
SET whatsapp_phone_number_id = 'YOUR_KASSANGAS_PHONE_ID',  -- Get from Meta Business Manager
    whatsapp_access_token = 'YOUR_WA_TOKEN',  -- Get from Meta Business Manager
    whatsapp_business_account_id = 'YOUR_BA_ID'
WHERE client_phone LIKE '%702245555%';
```

**Completion Checklist:**
- [ ] Tenant record exists in database
- [ ] Status = 'active' and is_active = true
- [ ] M-Pesa credentials verified
- [ ] WhatsApp phone IDs configured
- [ ] Callback URL is reachable

---

### **DAY 2: Product Catalog Setup** (2-3 hours)

#### Task 1: Add Kassangas Sample Products
```sql
-- Insert 5 test products
INSERT INTO alphadome.bot_products 
(bot_tenant_id, sku, name, description, price, currency, stock_count, is_active, created_at) 
VALUES 
(
  (SELECT id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%'),
  'KASS-GTR-001',
  'Acoustic Guitar - Yamaha',
  'Professional Yamaha acoustic guitar, perfect for beginners and professionals',
  8500,
  'KES',
  10,
  true,
  NOW()
),
(
  (SELECT id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%'),
  'KASS-MIC-001',
  'Studio Microphone - Condenser',
  'High-quality condenser microphone for recording',
  15000,
  'KES',
  5,
  true,
  NOW()
),
(
  (SELECT id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%'),
  'KASS-AMP-001',
  'Guitar Amplifier - 50W',  
  'Portable 50W guitar amplifier with effects',
  12000,
  'KES',
  8,
  true,
  NOW()
),
(
  (SELECT id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%'),
  'KASS-DRUM-001',
  'Drum Kit - 5-Piece',
  'Complete 5-piece drumkit with stands and hardware',
  25000,
  'KES',
  3,
  true,
  NOW()
),
(
  (SELECT id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%'),
  'KASS-CABLE-001',
  'Audio Cable Bundle',
  '6-pack of XLR and 1/4 inch cables',
  2500,
  'KES',
  20,
  true,
  NOW()
);
```

#### Task 2: Upload Product Images (Optional but Recommended)
Use dashboard: `http://localhost:3000/admin/simple?key=alphadome-admin-2026`

**Product images needed:**
- Guitar photo → KASS-GTR-001.jpg
- Microphone photo → KASS-MIC-001.jpg  
- Amplifier photo → KASS-AMP-001.jpg
- Drums photo → KASS-DRUM-001.jpg
- Cables photo → KASS-CABLE-001.jpg

#### Task 3: Verify Catalog is Reachable via API
```bash
curl -X GET "http://localhost:3000/tenant/catalog" \
  -H "x-tenant-key: 254702245555" \
  -H "Content-Type: application/json"
```

**Completion Checklist:**
- [ ] 5+ products uploaded to Kassangas
- [ ] Each product has valid SKU, name, price, stock
- [ ] Prices are in KES
- [ ] Catalog API returns items via `/tenant/catalog`

---

### **DAY 3: Payment Flow Testing (Sandbox)** (3-4 hours)

#### Task 1: Set Up Test Credentials
```
M-Pesa Test Account:
- Phone: 254712345678 (or 0712345678)
- Test funds: Available in Safaricom Daraja sandbox
- Shortcode: 174379
- Passkey: bfb279f9aa9bdbcf158e97dd71a467cd2e0ff47d43249d1c
```

#### Task 2: End-to-End Payment Test
```bash
# 1. Start your server
npm start

# 2. Send test message to your bot
# From phone 254712345678 → Bot phone (WhatsApp)
# Message: "JOIN ALPHADOME" or "BUY KASS-GTR-001"

# 3. Bot should respond asking for payment phone number

# 4. From test phone, reply: "254712345678" (or "same")

# 5. Check Safaricom Daraja logs for STK push attempt
# 6. Verify /mpesa/callback processed the response
# 7. Check subscriptions table for payment record
```

#### Task 3: Monitor Callback Processing
```sql
-- Check if payment was recorded:
SELECT id, phone, amount, status, mpesa_receipt_no 
FROM subscriptions 
WHERE phone LIKE '%712345678%' 
ORDER BY created_at DESC LIMIT 5;

-- Check conversation logs:
SELECT direction, message_text, created_at 
FROM conversations 
WHERE user_id = (SELECT id FROM users WHERE phone LIKE '%712345678%')
ORDER BY created_at DESC LIMIT 20;
```

#### Task 4: Test Different Scenarios
- [ ] User types "JOIN ALPHADOME" → Gets subscription flow
- [ ] User types "BUY KASS-GTR-001" → Gets product checkout  
- [ ] Payment success → Subscription marked as "subscribed"
- [ ] Payment failure → User notified to retry
- [ ] User gets confirmation message with receipt

**Completion Checklist:**
- [ ] 3+ successful sandbox payments processed
- [ ] M-Pesa callback updates subscriptions table
- [ ] User receives confirmation messages
- [ ] No errors in logs during payment flow

---

### **DAY 4: Production M-Pesa Setup** (2-3 hours)

#### Task 1: Switch M-Pesa to Production
```bash
# In .env, change:
MPESA_ENV=production  # Was: sandbox
MPESA_SHORTCODE=your_actual_shortcode  # Get from Safaricom (not 174379)
```

#### Task 2: Update Callback URL to Production
```bash
# .env should have:
MPESA_CALLBACK_URL=https://your-production-domain.com/mpesa/callback
# OR
MPESA_CALLBACK_URL=https://alphadome.onrender.com/mpesa/callback  # If hosted here
```

#### Task 3: Register Business with Safaricom
- [ ] Log into Safaricom Daraja dashboard
- [ ] Switch app to "Production"
- [ ] Whitelist callback URL
- [ ] Test with actual M-Pesa number (not sandbox)
- [ ] Verify response is 200 OK

#### Task 4: Verify Payment Flow in Production
```bash
# Test with real M-Pesa:
# 1. Send actual payment from real phone
# 2. Confirm STK prompt appears
# 3. Enter M-Pesa PIN and complete
# 4. Verify subscription status changes to "paid"
```

**Completion Checklist:**
- [ ] M-Pesa switched to production mode
- [ ] Callback URL updated and verified
- [ ] 1-2 real test payments processed successfully
- [ ] No errors in /mpesa/callback processing

---

### **DAY 5: Tenant Dashboard & Analytics** (2-3 hours)

#### Task 1: Access Tenant Dashboard
```
URL: http://localhost:3000/tenant-dashboard?key=254702245555
Password: 254702245555 (from TENANT_DASHBOARD_PASS)
```

#### Task 2: Review Available Metrics
- [ ] Process `/tenant/analytics` → See conversation stats
- [ ] Process `/tenant/revenue` → See payment trends
- [ ] Process `/tenant/products/performance` → See product views & conversions
- [ ] Process `/tenant/customers` → See customer list & behavior
- [ ] Process `/tenant/orders` → See transaction history

#### Task 3: Set Up Auto-Responses (Optional)
```sql
-- Add quick replies for common questions:
UPDATE alphadome.bot_tenants
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{auto_responses}',
  '[
    {"trigger": "hello", "response": "👋 Welcome to Kassangas! What would you like to know about our instruments?", "enabled": true},
    {"trigger": "hours", "response": "⏰ We are open Mon-Sat, 9 AM - 6 PM", "enabled": true},
    {"trigger": "warranty", "response": "✅ All instruments come with 1-year warranty", "enabled": true}
  ]'::jsonb
)
WHERE client_phone LIKE '%702245555%';
```

#### Task 4: Monitor Payment Processing
```bash
# These endpoints show real-time data:
GET /tenant/payments - All payment attempts
GET /tenant/revenue - Daily revenue trend
GET /tenant/orders - Order status
```

**Completion Checklist:**
- [ ] Dashboard loads without errors
- [ ] Can see products in catalog
- [ ] Can see payment transactions
- [ ] Auto-responses configured for common queries
- [ ] Revenue report shows sales data

---

### **DAY 6: Go-Live Preparation & Marketing** (3-4 hours)

#### Task 1: Final Security Audit
```bash
# Check critical configs:
echo "WHATSAPP_TOKEN length: ${#WHATSAPP_TOKEN}"  # Should be >100
echo "MPESA_CONSUMER_KEY set: $([ -z $MPESA_CONSUMER_KEY ] && echo NO || echo YES)"
echo "MPESA_CONSUMER_SECRET set: $([ -z $MPESA_CONSUMER_SECRET ] && echo NO || echo YES)"
echo "ADMIN_PASS set: $([ -z $ADMIN_PASS ] && echo NO || echo YES)"
```

#### Task 2: Enable Chat Logging & Monitoring
```sql
-- Create monitoring dashboard:
SELECT 
  DATE(created_at) AS date,
  COUNT(*) AS messages,
  SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS inbound,
  SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) AS outbound
FROM conversations
WHERE brand_id = (SELECT brand_id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%')
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

#### Task 3: Announce to Customers
**Message Template for Kassangas:**
```
🎉 Hi! This is Kassangas Music Shop.

We now have a WhatsApp bot that lets you:
✅ Browse our full instrument catalog
✅ Check prices & availability
✅ Buy directly via M-Pesa
✅ Get instant support

Just message us here to get started! 🎸

Commands:
- Type "CATALOG" to see all items
- Type "BUY [product name]" to purchase
- Type "JOIN ALPHADOME" for membership plans
```

#### Task 4: Set Up Support & Escalation
```sql
-- Configure escalation keywords:
UPDATE alphadome.bot_tenants
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{workflows}',
  '{
    "escalation_keywords": ["help", "human", "manager", "complaint", "urgent"],
    "auto_assign_enabled": true,
    "default_agent": "gideon"
  }'::jsonb
)
WHERE client_phone LIKE '%702245555%';
```

**Completion Checklist:**
- [ ] All credentials verified and secure
- [ ] Payment flow tested with real money
- [ ] Customer announcement message ready
- [ ] Support escalation configured
- [ ] Monitoring queries set up
- [ ] Team trained on how to use dashboard

---

### **DAY 7: Go-Live & First Sales** (2-3 hours)

#### Task 1: Deploy to Production
```bash
# If not already deployed:
git add -A
git commit -m "feat: activate kassangas revenue stream"
git push origin main

# Or restart if self-hosted:
npm stop
npm start
```

#### Task 2: Send Customer Announcement
- [ ] Send WhatsApp broadcast to existing Kassangas customers
- [ ] Post on social media channels
- [ ] Email announcement (if you have list)
- [ ] Update website with WhatsApp link

#### Task 3: Monitor Live Transactions
```bash
# Every 30 minutes, check:
SELECT 
  DATE_TRUNC('hour', created_at) AS hour,
  COUNT(*) AS messages,
  SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) AS incoming
FROM conversations
WHERE brand_id = (SELECT brand_id FROM alphadome.bot_tenants WHERE client_phone LIKE '%702245555%')
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- Check revenue:
SELECT 
  DATE(created_at) AS date,
  COUNT(*) AS sales,
  SUM(amount) AS revenue,
  AVG(amount) AS avg_order_value
FROM subscriptions
WHERE status IN ('paid', 'subscribed', 'completed', 'active')
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE(created_at);
```

#### Task 4: Respond to Issues in Real-Time
- [ ] Monitor `/tenant/customers` for incoming messages
- [ ] Respond to questions within 1 hour
- [ ] Mark failed payments to retry
- [ ] Escalate technical issues immediately

**Completion Checklist:**
- [ ] System deployed and running
- [ ] First customer message received ✓
- [ ] First payment initiated ✓
- [ ] First payment completed ✓
- [ ] Revenue flowing to Kassangas ✓

---

## 💰 Revenue Model

### Pricing Tiers
```
Payment Flow Options:
1. Product Sales (User-controlled)
   - SKU: KASS-GTR-001 → KES 8,500
   - Each sale: KES 8,500 - M-Pesa fee (0.99%)
   
2. Membership Subscriptions  
   - Monthly Level 1: KES 900
   - Monthly Level 2: KES 1,800
   - Monthly Level 3: KES 3,600
   - One-time variants available

3. Premium Services (Extensible)
   - VIP Support: KES 500/month
   - Product Training: KES 2,000/session
   - Custom orchestration: KES by negotiation
```

### M-Pesa Fees
- Safaricom charges **0.99% per transaction** (Daraja pricing)
- Example: KES 10,000 sale → KES 9,901 to Kassangas
- All fees already built into callback processing

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| STK not pushing | Check M-Pesa credentials + Daraja account status |
| Callback not received | Verify MPESA_CALLBACK_URL is publicly reachable |
| Payment shows "pending" forever | Check `/mpesa/callback` logs for errors |
| Customer says "no prompt" | Verify phone number format (2547XXXXXXXX) |
| Catalog not showing SKU | Verify product exists in bot_products table + is_active=true |

---

## 📞 Support Contacts

**Safaricom Daraja:**
- Daraja Portal: https://developer.safaricom.co.ke
- Email: apisupport@safaricom.co.ke
- FAQ: https://daraja.readme.io

**Your Team:**
- Gideon (Kassangas): +254702245555
- Support: +254117604817 or +254743780542

---

## 🎯 Success Metrics

By end of Day 7:
- ✅ **10+ messages** received from customers
- ✅ **3+ payment attempts** made
- ✅ **1+ successful transaction** completed
- ✅ **Revenue flowing** to Kassangas account
- ✅ **Zero critical errors** in logs

By end of Week 2:
- Revenue: KES 5,000 - 15,000
- Active customers: 10-20
- Repeat purchase rate: 10%+

---

**Let's make this happen! 🚀**
