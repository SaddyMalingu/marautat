# First Transaction Test - Live Revenue Generation

**Status**: 🟢 READY (7/7 Systems Healthy)  
**Date**: April 18, 2026  
**Objective**: Process first real test transaction with fallback payment tracking

---

## Test Flow (5-10 minutes)

### Step 1: Send Initial Message to Bot ✅
**Time**: Now  
**Action**: Send WhatsApp message to Kassangas Music Shop bot number

```
Type: JOIN ALPHADOME
Expected Response: Bot asks you to select plan
```

**What happens**:
- Bot creates user record if new
- Asks which plan: "monthly" or "one" (one-time)
- Captures plan preference in session context

---

### Step 2: Select Plan Level
**Time**: Seconds after Step 1  
**Action**: Reply to bot

```
Type: JOIN ALPHADOME MONTHLY LEVEL 1
Expected Response: Bot shows plan summary + amount
Example: "Plan: MONTHLY L1, Amount: KES 500"
```

**Behind the scenes**:
- Bot calculates payment amount from plan + level
- Stores in session: `plan=monthly, level=1, amount=500`
- Awaits M-Pesa number

---

### Step 3: Provide M-Pesa Number
**Time**: Next message  
**Action**: Send M-Pesa number or tap "same"

```
Type: 0712345678
OR
Type: same
```

**Expected Response**: 
```
💳 Processing payment for MONTHLY Plan Level 1 (KES 500). 
Please wait...
```

**Behind the scenes**:
- Normalizes phone: `0712345678` → `254712345678`
- Creates subscription record in DB with status=`pending`
- Initiates M-Pesa STK push to that number
- Stores: `mpesa_checkout_request_id=ABC123...`

---

### Step 4a: SUCCESS SCENARIO (M-Pesa Works)
**If payment succeeds immediately**:

Customer's phone gets STK prompt → Customer enters PIN → Payment processes → M-Pesa callback returns ResultCode=0

**Bot sends**:
```
🎉 Payment Successful!

Thank you for joining Alphadome.
Your MONTHLY Plan - Level 1 has been activated.

🧾 Receipt: ABC123XYZ
💰 Amount: KES 500
```

Subscription marked as: `subscribed` ✅

---

### Step 4b: FALLBACK SCENARIO (M-Pesa Refunds)
**If payment refunds after ~5 minutes** (expected while waiting for EPI approval):

M-Pesa callback returns ResultCode ≠ 0

**Bot automatically sends**:
```
⚠️ MONTHLY PLAN PAYMENT - Alternative Options

Your M-Pesa payment (KES 500) wasn't completed. 
M-Pesa's payment gateway is temporarily unavailable.

✅ No worries! We have alternative payment methods.

[🔄 Retry M-Pesa]
[🏦 Bank Transfer]
[🚚 Cash on Delivery]
[📞 Contact Support]
```

Subscription marked as: `failed` with fallback options offered

**What to do next**:
- Tap one of the buttons to complete payment via alternative method
- OR reply with: RETRY, BANK, COD, or SUPPORT

---

## Monitoring During Test

### Terminal Window 1: Live Logs
```bash
tail -f logs/bot.log | grep -E "PAYMENT|STK|FALLBACK"
```

**Expected log entries**:
```
[PAYMENT] 🛍️ PRODUCT_PURCHASE_INITIATED: SKU=..., Amount=KES 500
[PAYMENT] ✅ STK push initiated - CheckoutRequestID: ABC123...
[PAYMENT] STK_PUSH_RECORDED: CheckoutID=ABC123..., Customer=254712345678

# When payment succeeds:
[SYSTEM] ✅ Subscription ABC marked paid (receipt XYZ123)

# When payment fails:
[PAYMENT] ✅ FALLBACK_OPTIONS_SENT: Phone=254712345678, Amount=500
```

### Terminal Window 2: Dashboard
```bash
node revenue_dashboard.js
```

**Metrics to watch**:
- Total Orders: should increment to 1
- Successful Payments or Pending: count increases
- Message Activity: shows incoming + outgoing messages

### Web Dashboard
```
http://localhost:3000/tenant-dashboard?key=254702245555
```

Real-time analytics:
- Customer count: +1
- Messages today: +2 to +4 (depending on fallback flow)
- Payment attempts: +1
- Revenue: pending or confirmed (if immediate success)

---

## Test Scenarios

### Scenario A: Success Path (Fastest)
1. Send `JOIN ALPHADOME MONTHLY LEVEL 1`
2. Reply with `0712345678`
3. **Immediately check your phone** - STK should prompt within 3 seconds
4. Enter M-Pesa PIN and complete
5. **30 seconds later**: Bot confirms payment (status: subscribed)
6. ✅ Check logs: Look for "Subscription marked paid"
7. ✅ Check dashboard: Revenue +KES 500

**Duration**: ~2 minutes (you control the completion)

---

### Scenario B: Fallback Path (M-Pesa Refund)
1. Send `JOIN ALPHADOME MONTHLY LEVEL 1`
2. Reply with `0712345678`
3. STK prompts on phone but **don't enter PIN** (or let it timeout)
4. **After 5 minutes**: M-Pesa refunds
5. **Post-refund**: Bot auto-sends 4 fallback options
6. **Select one**:
   - `RETRY` → New STK push immediately
   - `BANK` → KCB bank details sent
   - `COD` → Address capture flow starts
   - `SUPPORT` → Contact info displayed

**Duration**: 5-10 minutes (tests full recovery flow)

---

### Scenario C: Bank Transfer Path
1. Go through Scenario B until fallback options appear
2. Tap `🏦 Bank Transfer`
3. Bot sends:
   ```
   🏦 Bank Transfer Instructions
   
   Amount: KES 500
   Bank: KCB Bank Kenya
   Account: Alphadome Limited
   Account Number: 1234567890
   Reference: monthly-ABC123DE
   ```
4. Reply: `BANK RECEIPT K2P4A5B6C7`
5. Bot confirms: "Bank Transfer Payment Received"
6. ✅ Check DB: Subscription status → `manual_pending_verification`
7. ✅ Manual verification step: Support team verifies receipt manually

**Duration**: ~1 minute interaction time (plus actual bank transfer)

---

### Scenario D: COD Path
1. Fallback options displayed (from Scenario B)
2. Tap `🚚 Cash on Delivery`
3. Bot asks for delivery address
4. Reply: `Main Street, Westlands, Building 5, Apt 201`
5. Bot confirms with generated COD reference: `COD-8F6E3P2Q`
6. ✅ Check DB: Subscription status → `cod_pending_delivery`
7. ✅ Ops team contacts customer within 24 hours
8. ✅ Goods delivered, payment collected

**Duration**: < 1 minute interaction (delivery happens later)

---

## Success Metrics

### What SUCCESS Looks Like:
- ✅ Bot responds within 2-3 seconds
- ✅ Session context saved (user phone + plan + amount)
- ✅ M-Pesa STK fires within 5 seconds
- ✅ Subscription record created in Supabase
- ✅ Within 1-5 minutes: M-Pesa callback arrives
- ✅ Appropriate database update happens
- ✅ User message sent (success OR fallback options)
- ✅ All interactions logged at PAYMENT level
- ✅ Dashboard metrics update in real-time

### Red Flags to Watch:
- ❌ Bot doesn't respond after 5 seconds → Check server logs
- ❌ STK doesn't fire → M-Pesa OAuth might need refresh
- ❌ Callback takes > 10 mins → Network delay or M-Pesa issue
- ❌ Subscription not created → Database connection issue
- ❌ Fallback options don't appear → Check error logs

---

## Data to Collect

After the test, check these locations:

### Database (Supabase)

**Users table**:
```sql
SELECT * FROM users WHERE phone = '254712345678' LIMIT 1;
-- Shows: id, phone, subscribed yes/no, created_at, updated_at
```

**Subscriptions table**:
```sql
SELECT id, phone, amount, plan_type, level, status, mpesa_checkout_request_id, 
       mpesa_receipt_no, created_at, updated_at 
FROM subscriptions 
WHERE phone = '254712345678' 
ORDER BY created_at DESC;
-- Shows: Full transaction record with status (subscribed/failed/manual_pending_verification/cod_pending_delivery)
```

**User sessions table**:
```sql
SELECT phone, context->'plan', context->'amount', context->'failed_checkout_id'
FROM user_sessions 
WHERE phone = '254712345678';
-- Shows: Session state after each step
```

### Logs

**Payment events**:
```bash
grep "PAYMENT" logs/bot.log | tail -20
```

**STK events**:
```bash
grep "STK" logs/bot.log | tail -10
```

**Fallback events**:
```bash
grep "FALLBACK" logs/bot.log | tail -10
```

### Dashboard
- http://localhost:3000/tenant-dashboard?key=254702245555
- Check:
  - Total Revenue (should be > 0 if success path)
  - Total Orders (should be 1)
  - Customer count (should be 1)

---

## If Something Goes Wrong

### Issue: No STK appears on phone
**Check**:
1. M-Pesa number format: Should be 254XXXXXXXXX (11 digits)
2. Logs for: "STK push failed" or "M-Pesa error"
3. M-Pesa OAuth token: `grep "M-Pesa OAuth" logs/bot.log`
4. Action: Run readiness check: `node check_revenue_readiness.js`

### Issue: Fallback options don't appear
**Check**:
1. M-Pesa callback received: `grep "MPESA callback" logs/bot.log`
2. ResultCode in callback: Should be non-zero for failure
3. mergeUserSessionContext call: Was context updated?
4. sendFallbackPaymentOptions call: Did it execute without error?

### Issue: Payment appears "stuck"
**Check**:
1. Subscription status in DB: Is it still "pending"?
2. Time elapsed: > 10 minutes?
3. Action: Commit a retry manually by tapping "RETRY" button

### Issue: Callback takes forever
**Check**:
1. M-Pesa network status: Try `node check_revenue_readiness.js` M-Pesa section
2. Callback URL reachable: Should return 404 on public internet
3. Check Render logs: Is callback being received?

---

## Next Steps After Test

### If Success Path Worked (✅):
1. Congratulations! You've generated first revenue
2. Repeat test with 5 more customers
3. Track conversion: successful_payments / attempts ratio
4. Monitor response times and error rates
5. move to Day 2 expansion

### If Fallback Path Worked (🔄):
1. All 4 fallback methods are operational
2. You now have backup revenue channels
3. Focus on which method customers prefer
4. Can generate revenue even without M-Pesa working
5. Expected recovery rate: 60-80% of failed payments

### If Both Worked (🚀):
1. **Full redundancy achieved** - revenue flows regardless of M-Pesa status
2. You're ready for scale
3. Expand to 10+ customers daily
4. Start tracking profitability metrics

---

## Contact & Support

**During test**:
- Check logs: `tail -50 logs/bot.log`
- Run health check: `node check_revenue_readiness.js`
- Check dashboard: http://localhost:3000/tenant-dashboard?key=254702245555

**If stuck**:
- +254117604817 (Support team)
- +254743780542 (Operations)
- Email: Check dashboard for support link

**Expected test outcome**: Revenue flowing through multiple payment channels ✅

---

## Timing

**Right now**: Start test (server is running)  
**In 2-10 minutes**: First transaction complete (depending on path)  
**Today**: Have 5+ test transactions  
**By tomorrow**: Ready to scale to real customers

**Status**: 🟢 GO LIVE
