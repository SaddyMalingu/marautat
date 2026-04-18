# Fallback Payment Options - Quick Testing Guide

## How to Test (Without Waiting for Real M-Pesa Failures)

### Option 1: Manual Database Manipulation (Fastest)
You can manually trigger the fallback flow by setting a subscription status to `failed` in Supabase, then the next webhook event will recognize it.

```sql
-- 1. Create a test subscription in 'failed' status
INSERT INTO subscriptions (
  user_id,
  phone,
  amount,
  plan_type,
  level,
  status,
  mpesa_checkout_request_id,
  metadata
) VALUES (
  '{user_uuid}',
  '254712345678',
  500,
  'monthly',
  1,
  'failed',
  'TEST_CHECKOUT_ID_12345',
  '{"failed_at": "2026-04-18T..."}'
);

-- 2. Extract the subscription ID
SELECT id FROM subscriptions WHERE mpesa_checkout_request_id = 'TEST_CHECKOUT_ID_12345';

-- 3. Update user session context to simulate failed payment
UPDATE user_sessions 
SET context = jsonb_set(
  context,
  '{}',
  jsonb_build_object(
    'failed_subscription_id', '{subscription_id}',
    'failed_checkout_id', 'TEST_CHECKOUT_ID_12345',
    'failed_plan_type', 'monthly',
    'failed_level', 1,
    'failed_amount', 500,
    'failed_at', NOW()::text
  )
)
WHERE phone = '254712345678';
```

### Option 2: Webhook Simulator (Realistic)
Use the webhook simulator to trigger a failed M-Pesa callback:

```bash
# Edit webhook_simulator.js to create a callback with ResultCode != 0
# Then run:
node webhook_simulator.js --type=mpesa_callback --result_code=1
```

### Option 3: Manual Payment Failure
1. **Start the server**: `npm start`
2. **Send "JOIN ALPHADOME"** to the bot WhatsApp number
3. **Provide your M-Pesa number** when prompted
4. **In Supabase**, find the subscription that was just created and set `status = 'failed'`
5. **In the user_sessions context**, manually add the failed payment details (see Session Context section in FALLBACK_PAYMENT_OPTIONS.md)
6. **Send a test message** from that phone number with "RETRY", "BANK", "COD", or "SUPPORT"

---

## Testing Each Fallback Option

### Test: Retry M-Pesa
1. Trigger failed payment (use options above)
2. **Send message**: `RETRY` or `Retry M-Pesa`
3. **Expect**: 
   - ✅ Message: "Retrying M-Pesa payment for KES 500..."
   - ✅ New STK push initiated
   - ✅ Session updated with `retry_checkout_id`
4. **Verify logs**: `grep "STK push initiated" request.log`

### Test: Bank Transfer
1. Trigger failed payment
2. **Send message**: `BANK` or `Bank Transfer`
3. **Expect**:
   - ✅ KCB Bank details displayed
   - ✅ Reference format shown: `monthly-ABC123XY`
   - ✅ Message asking for receipt: "reply with: BANK RECEIPT K2P4A5B6C7"
4. **Then send**: `BANK RECEIPT K2P4A5B6C7`
5. **Expect**:
   - ✅ Confirmation: "Bank Transfer Payment Received"
   - ✅ Subscription status → `manual_pending_verification`
   - ✅ Logs show: `ALTERNATIVE_PAYMENT_CONFIRMED`

### Test: Cash on Delivery
1. Trigger failed payment
2. **Send message**: `COD` or `Cash On Delivery`
3. **Expect**:
   - ✅ COD terms explained (2-3 business days, pay on delivery)
   - ✅ Message asking for address: "Reply with your delivery address"
4. **Then send**: `Nairobi CBD, Tom Mboya Street, Building A, Floor 3`
5. **Expect**:
   - ✅ Confirmation: "COD Order Confirmed"
   - ✅ Order Reference: `COD-8F6E3P2Q` format
   - ✅ Subscription status → `cod_pending_delivery`
   - ✅ Logs show: `COD order confirmed`

### Test: Contact Support
1. Trigger failed payment
2. **Send message**: `SUPPORT` or `Contact Support`
3. **Expect**:
   - ✅ Support contact details displayed
   - ✅ Phone numbers: +254117604817, +254743780542
   - ✅ Hours: Mon-Fri, 8AM-6PM EAT

---

## Verification Checklist

### Message Display
- [ ] Fallback options appear as WhatsApp Interactive List (4 buttons)
- [ ] Each button shows title + description
- [ ] All buttons are clickable
- [ ] Text fallback works if list fails (RETRY, BANK, COD, SUPPORT as text)

### Session Context
- [ ] Failed payment details saved: `failed_amount`, `failed_plan_type`, `failed_checkout_id`
- [ ] Recovery flow context saved: `selected_fallback_method`, `bank_receipt_verified`, `cod_address`

### Database Updates
- [ ] Subscription status changes correctly:
  - [ ] `failed` → `manual_pending_verification` (bank transfer)
  - [ ] `failed` → `cod_pending_delivery` (COD)
  - [ ] `failed` → `subscribed` (retry success)
- [ ] Metadata updated with alternative payment method details

### Logging
- [ ] Check logs for:
  - [ ] `FALLBACK_OPTIONS_SENT`
  - [ ] `BANK_TRANSFER_DETAILS_SENT`
  - [ ] `ALTERNATIVE_PAYMENT_CONFIRMED`
  - [ ] `COD order confirmed`
- [ ] All logs at `PAYMENT` level - viewable via: `grep PAYMENT request.log`

---

## End-to-End Test Sequence

**Duration**: ~5 minutes

1. **Setup**: Clear any previous test data from Supabase for phone `254799999999`
2. **Trigger Failure**: Use database/webhook simulator to create failed payment
3. **Option 1 - Retry**:
   - Send: `RETRY`
   - Verify: New STK push logged
   - New realistic callback incoming
4. **Option 2 - Bank Transfer**:
   - Send: `BANK`
   - Verify: Bank details received
   - Send: `BANK RECEIPT TEST12345`
   - Verify: Confirmation received, status changed
5. **Option 3 - COD**:
   - Send: `COD`
   - Verify: COD terms displayed
   - Send: `Main Street, Westlands`
   - Verify: Order confirmed with reference
6. **Option 4 - Support**:
   - Send: `SUPPORT`
   - Verify: Contact numbers displayed

---

## Debugging Common Issues

### Issue: Fallback options not appearing
**Check**:
1. `POST /mpesa/callback` was triggered with `ResultCode ≠ 0`
2. Subscription found in database
3. `sendFailbackPaymentOptions()` executed without error
4. Check logs: `grep -i "fallback" request.log`

### Issue: Session context not saving
**Check**:
1. `mergeUserSessionContext()` function called
2. User phone number normalized (254-prefixed)
3. `user_sessions` table has entry for that phone
4. Metadata field is text/JSON, not encrypted

### Issue: Button selection not recognized
**Check**:
1. WhatsApp button text matches handler (RETRY, BANK, COD, SUPPORT)
2. Text message fallback working (if list UI broken)
3. Phone number formatting consistent across flow
4. Logs show: `Received from {phone}: {button_text}`

### Issue: Subscription status not updating
**Check**:
1. Subscription ID correctly saved in session
2. Database connection working (`grep "subscriptions" request.log`)
3. Supabase RLS policies allow update
4. Check Supabase audit logs for failed updates

---

## Expected Log Output

```
[2026-04-18T14:30:00Z] POST /webhook 200 - 1520ms
Received from 254712345678: RETRY
[2026-04-18T14:30:01Z] ✅ STK push initiated for retry - CheckoutRequestID: NEW_CHECKOUT_ID
[PAYMENT] ✅ FALLBACK_OPTIONS_SENT: Phone=254712345678, Amount=500, CheckoutID=OLD_CHECKOUT_ID

---

[2026-04-18T14:31:00Z] POST /webhook 200 - 1420ms
Received from 254712345678: BANK
[PAYMENT] BANK_TRANSFER_DETAILS_SENT: Phone=254712345678, Amount=500

---

[2026-04-18T14:32:00Z] POST /webhook 200 - 1310ms
Received from 254712345678: BANK RECEIPT K2P4A5B6C7
[PAYMENT] ALTERNATIVE_PAYMENT_CONFIRMED: Phone=254712345678, Method=bank_transfer, Receipt=K2P4A5B6C7
```

---

## Production Rollout

Once testing complete:
1. ✅ All 4 fallback options working
2. ✅ Session context saving/loading correctly
3. ✅ Database updates reflect correct statuses
4. ✅ Logs showing expected flow
5. **Then**: Monitor live M-Pesa failures and conversion to alternative payments
6. **Track**: % of customers choosing each method + recovery rates
