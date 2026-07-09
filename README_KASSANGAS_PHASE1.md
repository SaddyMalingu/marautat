# Kassangas Phase 1: QR-Based Payment Template System

## Overview

Kassangas Music Shop has a reusable, QR-based payment system where:

1. **Merchants** generate payment templates (e.g., "Trip No. 1 Town→Kayole, KES 500")
2. **Customers** scan the QR code or manually enter their phone
3. **M-Pesa STK prompt** appears without customers re-entering details
4. **Payment confirmation** and history tracked

---

## Features

### ✅ Phase 1 (MVP) - Now Live
- **Merchant Portal** (`/kassangas-merchant-portal`)
  - Create reusable payment templates
  - Generate scannable QR codes
  - Copy/share links via WhatsApp, Telegram, etc.

- **Client Wallet** (`/kassangas-client-wallet`)
  - Scanner tab: Scan merchant QR codes
  - Manual tab: Enter phone number for templated payments
  - History tab: View recent transaction records
  - Fallback to manual entry if camera unavailable

### 📋 Phase 2 (Planned)
- WhatsApp delivery of payment links
- Bulk customer contact import
- Campaign management dashboard
- Advanced security (OTP verification, rate limiting)

---

## API Reference

### 1. Create Payment Template
**POST** `/api/kassangas/create-template`
```json
Request:
{
  "itemName": "Trip No. 1 Town→Kayole",
  "amount": 500,
  "reusable": true,
  "merchantName": "Kassangas Music Shop"
}

Response:
{
  "success": true,
  "templateId": "TMPL-ABC123"
}
```

### 2. Resolve Template (from QR scan)
**GET** `/api/kassangas/template/{templateId}`
```json
Response:
{
  "templateId": "TMPL-ABC123",
  "itemName": "Trip No. 1 Town→Kayole",
  "amount": 500,
  "merchantName": "Kassangas Music Shop",
  "reusable": true
}
```

### 3. Create Payment Intent (trigger STK)
**POST** `/api/kassangas/payment-intent`
```json
Request:
{
  "templateId": "TMPL-ABC123",
  "phone": "2547XXXXXXXX"
}

Response:
{
  "success": true,
  "message": "Enter your M-Pesa PIN",
  "checkoutId": "ws_CO_DMZ_123456789"
}
```

### 4. Get Transaction History
**GET** `/api/kassangas/payment-intents`
```json
Response:
{
  "intents": [
    {
      "id": "uuid",
      "amount": 500,
      "status": "paid",
      "item_name": "Trip No. 1 Town→Kayole",
      "created_at": "2024-01-15T10:30:00Z"
    },
    ...
  ]
}
```

---

## Database Schema

### Tables Used

#### `kassangas_templates`
- Stores merchant payment templates
- Fields: `template_id`, `item_name`, `amount`, `reusable`, `merchant_name`, `metadata`

#### `subscriptions` (existing)
- Stores payment intents with `plan_type='kassangas_template'`
- Fields: `amount`, `status`, `mpesa_checkout_request_id`, `metadata` (contains `template_id`, `item_name`)

---

## Deployment Checklist

- [ ] Run SQL migration: `SQL_MIGRATION_KASSANGAS_PHASE1.sql` in Supabase SQL editor
- [ ] Deploy server.js with new routes
- [ ] Test merchant portal: Create template, generate QR
- [ ] Test client wallet: Scan QR, verify M-Pesa STK
- [ ] Test manual entry: Skip scanner, enter phone directly
- [ ] Verify transaction history: Check subscriptions table records

---

## Testing Guide

### End-to-End Flow

#### Step 1: Merchant Creates Template
1. Visit `http://localhost:3000/kassangas-merchant-portal`
2. Enter item name: "Test Item"
3. Enter amount: "100"
4. Click "Generate QR"
5. Copy link (contains templateId)

#### Step 2: Customer Scans QR
1. Visit `http://localhost:3000/kassangas-client-wallet`
2. Click "Scan QR" tab
3. Click "Start Camera"
4. Scan QR code from Step 1
5. Verify template shows: "Test Item, KES 100"
6. Enter phone: "2547XXXXXXXX"
7. Click "Confirm & Pay"
8. Verify M-Pesa STK prompt appears on device

#### Step 3: Verify Payment Intent Created
1. Open Supabase SQL editor
2. Run: `SELECT * FROM subscriptions WHERE plan_type='kassangas_template' ORDER BY created_at DESC LIMIT 1;`
3. Verify row shows: amount=100, status='pending', metadata.template_id=TMPL-*

#### Step 4: Check History
1. Go to client wallet "History" tab
2. Verify transaction appears with status (pending/paid/failed)

---

## Troubleshooting

### Issue: "Template not found" error
**Cause**: Database table `kassangas_templates` doesn't exist  
**Solution**: Run SQL migration in Supabase

### Issue: Camera permission denied
**Cause**: Browser permission not granted  
**Solution**: Allow camera access in browser settings; click "Allow" when prompted

### Issue: M-Pesa STK not appearing
**Cause**: M-Pesa credentials or phone format invalid  
**Solution**: Check MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET in `.env`; verify phone is 2547XXXXXXXX format

### Issue: QR code won't scan
**Cause**: Poor lighting or QR code too small  
**Solution**: Position QR clearly in camera frame; ensure good lighting

---

## File Structure

```
whatsapp-bot/
├── public/
│   ├── kassangas-merchant-portal.html    (Merchant QR generation)
│   ├── kassangas-client-wallet.html      (Customer payment + scanner)
│   └── kassangas-music-shop.html         (Legacy direct STK portal)
├── server.js                              (API routes)
├── SQL_MIGRATION_KASSANGAS_PHASE1.sql   (Database setup)
└── README_KASSANGAS_PHASE1.md            (This file)
```

---

## Security Notes

1. **QR Encodes ID Only**: QR code contains only templateId, not payment data
   - Prevents man-in-the-middle QR modification
   - Server verifies template integrity

2. **Phone Normalization**: Input normalized to 2547XXXXXXXX format
   - Handles input variations (0702123456, 702123456, +2547...)
   - Consistent format for M-Pesa API

3. **Template Validation**: Server-side verification before STK push
   - Prevents direct API manipulation
   - Ensures amount consistency

---

## Next Steps (Phase 2)

- [ ] WhatsApp link delivery (merchant bulk-sends payment links)
- [ ] Webhook for successful M-Pesa callback processing
- [ ] Customer onboarding flow (first-time verification)
- [ ] Rate limiting (prevent spam/abuse)
- [ ] Analytics dashboard (transaction volume, success rate)

---

**Last Updated**: 2024  
**Status**: Phase 1 MVP - Production Ready
