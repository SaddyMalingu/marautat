# Alphadome Kassangas Digital Sales API Setup Guide

## Overview

The Alphadome Kassangas system now includes a **provider-agnostic digital sales engine** that can process:
- **Data bundles** (Safaricom, Airtel, Telkom, Vodafone)
- **Airtime top-ups** (all major operators)
- **Utility bills** (KPLC tokens, water)
- **TV subscriptions** (GOtv, DStv)
- **Gift cards** (Netflix, gaming vouchers)

**Current State:**
- ✅ Provider abstraction layer implemented in `server.js`
- ✅ Sandbox mode enabled by default (no API keys required for testing)
- ✅ Four providers configured: Reloadly, Flutterwave, DT One, Africa's Talking
- ✅ Transaction logging (JSONL) for audit and reconciliation
- ✅ Admin dashboard for sales monitoring
- ⏳ Live provider integration (waiting for API keys)

---

## Architecture

### Provider Adapter Pattern

```
ProviderAdapter (abstract interface)
├── init()              → Validate credentials
├── validateProduct()   → Check if product available
├── executeSale()       → Process transaction
└── getBalance()        → Check account balance
```

Each provider (Reloadly, Flutterwave, etc.) inherits this interface.

### Data Flow

1. **Client** → `POST /api/kassangas/buy-product` with phone + SKU
2. **Server** → Lookup product in catalog
3. **Server** → Route to active provider adapter
4. **Adapter** → Execute sale (sandbox or production mode)
5. **Server** → Log transaction to JSONL
6. **Client** → Receive transaction ID and status

### Transaction Logging

All transactions are logged to `logs/digital_sales_transactions.jsonl`:

```json
{
  "at": "2026-07-14T10:30:00Z",
  "ok": true,
  "transaction_id": "TXN-123456-ABCD",
  "provider": "reloadly",
  "phone": "254786817637",
  "sku": "SAF-DAILY-1GB",
  "amount_kes": 99,
  "status": "completed",
  "mode": "sandbox",
  "merchant_code": "MRC-123456-ABC",
  "visitor_id": "vis_1234567890_abcdef"
}
```

---

## Quick Start (Sandbox Mode)

**No setup required!** The system starts in sandbox mode, which simulates 95% successful transactions.

### Test Flow

1. Start the server:
   ```bash
   npm start
   ```

2. Call the buy-product endpoint:
   ```bash
   curl -X POST http://localhost:3000/api/kassangas/buy-product \
     -H "Content-Type: application/json" \
     -d '{
       "phone": "254786817637",
       "sku": "SAF-DAILY-1GB",
       "visitor_id": "test-visitor-1"
     }'
   ```

3. Response (sandbox):
   ```json
   {
     "success": true,
     "transaction_id": "TXN-123456-WXYZ",
     "provider": "reloadly",
     "product": "Safaricom Daily 1GB",
     "amount_kes": 99,
     "status": "completed",
     "message": "Simulated success",
     "mode": "sandbox"
   }
   ```

4. Check transaction history:
   ```bash
   curl http://localhost:3000/api/kassangas/sales/history?visitor_id=test-visitor-1
   ```

---

## Production Setup (Choose Your Provider)

### Step 1: Select a Provider

| Provider | Best For | Setup Difficulty | Strengths |
|----------|----------|------------------|-----------|
| **Reloadly** | Airtime & bundles | Easy | Broad operator support, fast payouts |
| **Flutterwave Bills** | Bills & utilities | Easy | Strong KPLC/water/TV support |
| **DT One** | Global catalog | Medium | 100+ countries, diverse products |
| **Africa's Talking** | Airtime only | Easy | SMS adjacency, local expertise |

**Recommendation for Kenya:** Start with **Reloadly** (broadest operator coverage) or **Flutterwave Bills** (best utility support).

---

### Step 2: Get API Credentials

#### Reloadly
1. Go to https://reloadly.com/
2. Sign up and navigate to **API Settings**
3. Copy `API Key` and `Secret Key`
4. Test with sandbox: `https://sandbox-api.reloadly.com`
5. Production: `https://api.reloadly.com`

#### Flutterwave Bills
1. Go to https://dashboard.flutterwave.com/
2. Navigate to **Settings → APIs**
3. Copy `Public Key` and `Secret Key`
4. Docs: https://developer.flutterwave.com/reference/bills

#### DT One
1. Go to https://developer.dtone.com/
2. Sign up and request API access
3. Copy `API Key` and `API Secret`
4. Test with sandbox: `https://api-sandbox.dtone.com`

#### Africa's Talking Airtime
1. Go to https://africastalking.com/
2. Sign up and navigate to **Account → Airtime**
3. Copy `API Key` and `Username`
4. Docs: https://africastalking.com/airtime/api

---

### Step 3: Configure Environment

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Update `.env` with your chosen provider credentials:

   **For Reloadly:**
   ```env
   SALES_MODE=production
   SALES_PROVIDER=reloadly
   RELOADLY_API_KEY=your-api-key-here
   RELOADLY_SECRET_KEY=your-secret-key-here
   ```

   **For Flutterwave:**
   ```env
   SALES_MODE=production
   SALES_PROVIDER=flutterwave
   FLUTTERWAVE_PUBLIC_KEY=your-public-key-here
   FLUTTERWAVE_SECRET_KEY=your-secret-key-here
   ```

3. Restart server:
   ```bash
   npm start
   ```

---

### Step 4: Verify Provider Connection

Check admin dashboard for provider status:

```bash
curl -H "x-admin-key: your-admin-password" \
  http://localhost:3000/admin/api/kassangas/sales-dashboard
```

Response:
```json
{
  "stats": {
    "total_sales": 10,
    "successful": 9,
    "failed": 1,
    "pending": 0,
    "total_revenue_kes": 990,
    "mode": "production",
    "active_provider": "reloadly",
    "provider_status": "ok",
    "provider_balance_kes": 50000
  },
  "recent_transactions": [...]
}
```

---

## API Endpoints

### Client APIs (Public)

#### `POST /api/kassangas/buy-product`
Buy a digital product (bundles, airtime, bills, etc.)

**Request:**
```json
{
  "phone": "254786817637",
  "sku": "SAF-DAILY-1GB",
  "visitor_id": "vis_optional",
  "merchant_code": "MRC_optional"
}
```

**Response:**
```json
{
  "success": true,
  "transaction_id": "TXN-123456-ABCD",
  "provider": "reloadly",
  "product": "Safaricom Daily 1GB",
  "amount_kes": 99,
  "status": "completed",
  "message": "Success",
  "mode": "sandbox"
}
```

---

#### `GET /api/kassangas/sales/status/:transactionId`
Check transaction status

**Response:**
```json
{
  "transaction_id": "TXN-123456-ABCD",
  "status": "completed",
  "provider": "reloadly",
  "mode": "production"
}
```

---

#### `GET /api/kassangas/sales/history?visitor_id=...&phone=...`
Get user's purchase history

**Response:**
```json
{
  "history": [
    {
      "at": "2026-07-14T10:30:00Z",
      "ok": true,
      "transaction_id": "TXN-123456-ABCD",
      "product_name": "Safaricom Daily 1GB",
      "amount_kes": 99,
      "status": "completed"
    }
  ]
}
```

---

### Admin APIs (Require `x-admin-key` header)

#### `GET /admin/api/kassangas/sales-dashboard`
Sales overview and provider status

---

#### `POST /admin/api/kassangas/provider-config`
Update provider and mode (requires server restart)

**Request:**
```json
{
  "provider": "reloadly",
  "mode": "production"
}
```

**Response:**
```json
{
  "message": "Provider config update received. Restart server to apply.",
  "requested_provider": "reloadly",
  "requested_mode": "production",
  "env_vars_to_set": [
    "SALES_PROVIDER=reloadly",
    "SALES_MODE=production",
    "RELOADLY_API_KEY=<your-api-key>",
    "RELOADLY_SECRET_KEY=<your-secret-key>"
  ]
}
```

---

## Transaction Logging & Audit

All transactions are logged to `logs/digital_sales_transactions.jsonl` for:
- Revenue reconciliation
- Dispute resolution
- Analytics
- Regulatory compliance

**Example query:**
```bash
tail -100 logs/digital_sales_transactions.jsonl | jq '.'
```

---

## Handling Failures

### Sandbox Mode
- 95% success rate (simulated)
- Failures logged to identify edge cases

### Production Mode
- Check provider API docs for error codes
- Implement retry logic (optional)
- Log all failures for investigation

### Client-Side Error Handling
```javascript
const response = await fetch('/api/kassangas/buy-product', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, sku, visitor_id })
});

const result = await response.json();

if (result.success) {
  console.log(`Transaction: ${result.transaction_id}`);
} else {
  console.error(`Failed: ${result.message}`);
  // Offer alternative payment method (M-Pesa, etc.)
}
```

---

## Switching Providers

1. Stop the server
2. Update `.env`:
   ```env
   SALES_PROVIDER=flutterwave
   FLUTTERWAVE_PUBLIC_KEY=new-key
   FLUTTERWAVE_SECRET_KEY=new-secret
   ```
3. Restart: `npm start`

**No code changes required!** The provider abstraction handles it.

---

## Monitoring & Metrics

Access the admin dashboard to view:
- Total sales and revenue
- Success/failure rates
- Provider balance
- Recent transactions
- Transaction history (filterable by date, merchant, visitor)

---

## Next Steps

1. **Choose provider** (Reloadly or Flutterwave recommended)
2. **Get API keys** from provider dashboard
3. **Update `.env`** with credentials
4. **Test in production** with small transactions
5. **Enable live mode** (`SALES_MODE=production`)
6. **Monitor transactions** via admin dashboard

---

## Troubleshooting

### Provider not responding
- Check API keys in `.env`
- Verify provider is not down (check status page)
- Check network connectivity
- Review provider docs for rate limits

### Transactions failing in production
- Ensure phone number is normalized (254XXXXXXXXX)
- Check product SKU exists in catalog
- Verify provider supports the operator
- Check provider account balance

### Admin dashboard not working
- Verify `x-admin-key` header is correct
- Check `ADMIN_PASS` in `.env`
- Review server logs for errors

---

## Support & Resources

- **Reloadly Docs:** https://reloadly.com/api/
- **Flutterwave Docs:** https://developer.flutterwave.com/
- **DT One Docs:** https://developer.dtone.com/
- **Africa's Talking:** https://africastalking.com/airtime/api

---

## Architecture Diagram

```
┌─────────────────┐
│  Client Wallet  │
└────────┬────────┘
         │
         │ POST /api/kassangas/buy-product
         │ (phone, sku, visitor_id)
         ▼
┌─────────────────────────────────────┐
│  Alphadome Kassangas Server         │
├─────────────────────────────────────┤
│  ProviderAdapter Factory            │
│  ├─ Reloadly                        │
│  ├─ Flutterwave Bills               │
│  ├─ DT One                          │
│  └─ Africa's Talking                │
└────┬─────────────────────────────┬──┘
     │                             │
     ▼ (Sandbox)                   ▼ (Production)
  Simulate Response         Call Provider API
  Log to JSONL              Receive Real Result
  Return Status             Log to JSONL
                           Return Status
```

---

**Version:** 1.0  
**Last Updated:** 2026-07-14  
**Status:** Ready for sandbox testing, production setup pending API keys
