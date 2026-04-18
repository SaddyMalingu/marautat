# Fallback Payment Options Feature

## Overview
When M-Pesa STK push payments fail or refund (while waiting for EPI connection approval from Safaricom), customers are automatically presented with alternative payment methods. This ensures revenue doesn't get blocked due to temporary M-Pesa gateway unavailability.

**Current Status**: Production-ready, enabled by default when M-Pesa ResultCode ≠ 0

---

## Payment Flow Architecture

### Standard M-Pesa Flow
```
Customer → POST /webhook "JOIN ALPHADOME" → initateStkPush() →
   STK prompt on phone → Customer enters PIN →
   M-Pesa processes → POST /mpesa/callback (ResultCode = 0) →
   Payment marked "subscribed" ✅
```

### Fallback M-Pesa Flow (EPI Pending)
```
Customer → POST /webhook "JOIN ALPHADOME" → initiateStkPush() →
   STK prompt on phone → Refund after ~5 minutes (ResultCode ≠ 0) →
   POST /mpesa/callback → sendFallbackPaymentOptions() →
   WhatsApp Interactive List with 4 options → Customer selects
```

---

## Fallback Payment Methods

### 1. 🔄 Retry M-Pesa
**Trigger**: Customer replies with "RETRY" or taps "Retry M-Pesa" button

**Flow**:
1. System retrieves failed amount from session context
2. Initiates new STK push with same amount/reference
3. Updates user session with `retry_checkout_id`
4. Sends confirmation message
5. Waits for new callback on `/mpesa/callback`

**User Message**:
```
💳 Retrying M-Pesa payment for KES 500. Please enter your M-Pesa PIN on your phone...
```

**Code**:
- Triggers: `text.toUpperCase().includes("RETRY")` or `text.match(/retry.*mpesa/i)`
- Calls: `initiateStkPush()` again with saved context

---

### 2. 🏦 Bank Transfer
**Trigger**: Customer replies with "BANK" or taps "Bank Transfer" button

**Flow**:
1. System sends bank transfer instructions with:
   - KCB Bank details (Account: Alphadome Limited)
   - Amount to send
   - Reference format: `{plan_type}-{checkoutId.slice(-8)}`
2. Prompts customer to reply with receipt
3. Customer replies: `BANK RECEIPT K2P4A5B6C7`
4. System confirms receipt and marks subscription as `manual_pending_verification`

**Bank Details Sent**:
```
🏦 Bank Transfer Instructions

Amount to send: KES 500

Bank: KCB Bank Kenya
Account Name: Alphadome Limited
Account Number: 1234567890
Branch Code: 63000
Swift Code: KCBLKENX

📌 Important:
• Use Reference: monthly-ABC123DE
• Reply with the bank deposit receipt number
• Allow 2-5 minutes for confirmation
```

**Code**:
- Triggers: `text.toUpperCase().includes("BANK")`
- Receipt validation: `/^BANK\s+RECEIPT\s+([A-Z0-9]+)$/i`
- Updates subscription to `manual_pending_verification` status

---

### 3. 🚚 Cash on Delivery
**Trigger**: Customer replies with "COD" or taps "Cash on Delivery" button

**Flow**:
1. System explains COD terms (2-3 business days, pay on delivery)
2. Requests delivery address from customer
3. Customer replies with address (e.g., "Nairobi CBD, Tom Mboya Street...")
4. System confirms order with COD reference number
5. Marks subscription as `cod_pending_delivery`
6. Operations team notifies customer within 24 hours

**User Messages**:
```
🚚 Cash on Delivery Selected

Plan: MONTHLY
Amount: KES 500

📍 Estimated Delivery: 2-3 business days
💰 Payment due on delivery

Please confirm your delivery address:
<Your address here>

---

✅ COD Order Confirmed

📍 Delivery Address:
Nairobi CBD, Tom Mboya Street, Building X

Plan: MONTHLY
Amount: KES 500
Payment Due: On Delivery

Your order has been registered. Our team will contact you within 24 hours to arrange delivery.

Order Reference: COD-8F6E3P2Q
```

**Code**:
- Triggers: `text.toUpperCase().includes("COD")` or `text.match(/cash.*delivery/i)`
- Address capture: any long text (>10 chars) when `selected_fallback_method === "cod"`
- Updates subscription to `cod_pending_delivery` status

---

### 4. 📞 Contact Support
**Trigger**: Customer replies with "SUPPORT" or taps "Contact Support" button

**Flow**:
1. Display support contact information
2. Wait for customer issue description

**Support Message**:
```
📞 Alphadome Support Team

We're here to help!

☎️ Call: +254117604817 or +254743780542
📧 Email: support@alphadome.com
⏰ Hours: Mon-Fri, 8AM-6PM EAT

💬 Or continue here - what's your issue?
```

**Code**:
- Triggers: `text.toUpperCase().includes("SUPPORT")`
- Simple informational response, no state change

---

## Session Context Tracking

### Failed Payment Context (Set in POST /mpesa/callback)
When payment fails, the system saves to user session:

```javascript
await mergeUserSessionContext(phone, {
  failed_subscription_id: subs.id,           // UUID for recovery
  failed_checkout_id: checkoutId,            // M-Pesa CheckoutRequestID
  failed_plan_type: subs.plan_type,          // "monthly" | "one" | "product_checkout"
  failed_level: subs.level,                  // 1, 2, 3, etc.
  failed_amount: subs.amount,                // KES amount
  failed_at: new Date().toISOString(),       // ISO timestamp
  failure_result_code: resultCode,           // Non-zero M-Pesa code
});
```

### Fallback Selection Context (Set when customer selects option)
```javascript
await mergeUserSessionContext(phone, {
  selected_fallback_method: "bank_transfer" | "cod" | "retry",
  fallback_method_selected_at: new Date().toISOString(),
  
  // For bank transfer:
  bank_receipt_verified: "K2P4A5B6C7",
  bank_receipt_verified_at: new Date().toISOString(),
  
  // For COD:
  cod_address: "Nairobi CBD, Tom Mboya Street...",
  cod_address_confirmed: true,
  cod_confirmed_at: new Date().toISOString(),
});
```

---

## Database Updates

### Subscriptions Table Status Updates

**When payment fails initially**:
```sql
UPDATE subscriptions 
SET status = 'failed',
    metadata = { 
      callback: {...}, 
      fallback_offered: true, 
      failed_at: '2026-04-18T...' 
    }
WHERE id = $1;
```

**When customer confirms bank transfer**:
```sql
UPDATE subscriptions 
SET status = 'manual_pending_verification',
    metadata = { 
      alternative_payment_method: 'bank_transfer',
      bank_receipt: 'K2P4A5B6C7',
      verified_at: '2026-04-18T...' 
    }
WHERE id = $1;
```

**When customer confirms COD**:
```sql
UPDATE subscriptions 
SET status = 'cod_pending_delivery',
    metadata = { 
      alternative_payment_method: 'cod',
      delivery_address: 'Nairobi CBD...',
      confirmed_at: '2026-04-18T...' 
    }
WHERE id = $1;
```

**When customer successfully retries M-Pesa**:
```sql
-- Handled by existing POST /mpesa/callback logic
UPDATE subscriptions
SET status = 'subscribed'  -- when ResultCode = 0 on retry
WHERE id = $1;
```

---

## Testing Scenarios

### Scenario 1: M-Pesa Fails → Retry → Success
1. User types: `JOIN ALPHADOME`
2. Bot asks for M-Pesa number
3. User provides: `0712345678`
4. STK push triggered, customer cancels or timeout occurs
5. M-Pesa callback returns ResultCode = 1 (user cancelled) or 1032 (timeout)
6. Fallback options displayed
7. User taps: `🔄 Retry M-Pesa`
8. New STK push sent
9. Customer completes payment this time
10. M-Pesa callback returns ResultCode = 0
11. Subscription activated ✅

### Scenario 2: M-Pesa Fails → Bank Transfer
1. User types: `JOIN ALPHADOME`
2. Bot asks for M-Pesa number
3. User provides: `0712345678`
4. STK push triggered, refunds after 5 minutes
5. Fallback options displayed
6. User taps: `🏦 Bank Transfer`
7. Bank details sent
8. User goes to KCB and makes deposit
9. User replies: `BANK RECEIPT K2P4A5B6C7`
10. System confirms receipt
11. Operations verifies and marks as subscribed manually ✅

### Scenario 3: M-Pesa Fails → COD
1. User types: `JOIN ALPHADOME`
2. Bot asks for M-Pesa number
3. User provides: `0712345678`
4. STK push triggered, refunds after 5 minutes
5. Fallback options displayed
6. User taps: `🚚 Cash on Delivery`
7. Bot asks for delivery address
8. User replies: `Nairobi, Ngara Estate, Hse 42, Apt 3B`
9. Order confirmed with reference: `COD-8F6E3P2Q`
10. Operations team contacts customer within 24 hours
11. Goods delivered, payment collected ✅

---

## Production Readiness Checklist

- ✅ Fallback options triggered on M-Pesa callback failure (ResultCode ≠ 0)
- ✅ Failed payment context saved to user session
- ✅ Interactive list UI with 4 payment options
- ✅ Retry M-Pesa flow with new STK push
- ✅ Bank transfer instructions with KCB details
- ✅ Receipt confirmation flow with validation
- ✅ COD address capture and order registration
- ✅ Support contact display
- ✅ Subscription status updates (`failed` → `manual_pending_verification` or `cod_pending_delivery`)
- ✅ Session context tracking for recovery flows
- ✅ Error handling for all scenarios
- ✅ Logging for audit trail (PAYMENT log level)

---

## Monitoring & Alerts

### Key Metrics
- Total failed payments (M-Pesa ResultCode ≠ 0)
- % Recovered via alternative methods
- Bank transfer receipts pending verification
- COD orders pending delivery
- Retry success rate

### Logs to Monitor
```
FALLBACK_OPTIONS_SENT: Phone=254712345678, Amount=500, CheckoutID=...
BANK_TRANSFER_DETAILS_SENT: Phone=254712345678, Amount=500
ALTERNATIVE_PAYMENT_CONFIRMED: Phone=254712345678, Method=bank_transfer
COD order confirmed with address: ... for 254712345678
Subscription {id} payment failed (ResultCode {code}) - Fallback options sent
```

---

## Future Enhancements

1. **Payment Reminder**: Auto-send reminder if bank transfer not received within 6 hours
2. **Analytics Dashboard**: Track fallback adoption by method + conversion rates
3. **SMS Fallback**: If WhatsApp Interactive List fails, send options via SMS
4. **Mobile Wallet**: Add options for Airtel Money, Equity Bank USSD
5. **Invoice Generation**: Generate and send PDF invoice for bank transfer
6. **Auto-Verification**: Integrate with KCB API to auto-verify bank receipts
7. **Dynamic Support**: Route COD to logistics partner API for auto-delivery scheduling

---

## Contact
For issues, enhancements, or support: +254117604817
