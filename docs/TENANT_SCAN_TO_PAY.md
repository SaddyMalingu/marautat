# Tenant Scan to Pay — merchant wallet + client wallet

**Surface:** `admin/tenant_dashboard.html` → **Store → Scan to Pay**
**Backend:** `utils/scanPay.js` (rules) + `server.js` (routes)
**Customer page:** `public/pay.html` served at `/pay/t/<templateId>`
**Status:** built 2026-10-25 on the QR + STK stack already live for Kassangas.

## What a tenant can do

| Direction | Action | Endpoint |
|---|---|---|
| Collect | Create a reusable payment link (item + amount) | `POST /tenant/scan-pay/links` |
| Collect | Show the QR / copy the link / open the customer page | client-side (`qrcode.js`) |
| Collect | Prompt a named customer's phone for a link's amount | `POST /tenant/scan-pay/charge` |
| Collect | See links, per-link totals, collections, merchant code | `GET /tenant/scan-pay` |
| Pay | Pay any Alphadome pay link (paste or scan a poster) | `POST /tenant/scan-pay/pay` |
| Pay (customer) | Open the link and prompt their own phone | `POST /pay/t/:tokenId/intent` |

The customer page (`/pay/t/...`) carries no session: it resolves the link through
`GET /api/kassangas/template/:tokenId`, then posts to the intent endpoint. It is
marked `noindex,nofollow` and is not in `sitemap.xml`.

## Reused, not rebuilt

- `kassangas_templates` — the payment link (created by the live Kassangas portal).
- `subscriptions` — the prompt, with `plan_type = 'tenant_scan_pay'`.
- `initiateStkPush()` — the single STK implementation in `server.js`.
- `qrcode.js 1.5.3` and `jsQR 1.4.0` — the same CDN builds the wallet pages use.

No migration is required to collect: both tables already exist wherever the
Kassangas QR checkout runs. If `kassangas_templates` is missing, the routes answer
**503** naming `SQL_MIGRATION_KASSANGAS_PHASE1.sql` instead of pretending to work.

## Tenant isolation

- Every link row carries `metadata.tenant_id` (the tenant's `site_tenants.id`) and
  `metadata.tenant_code`.
- `GET /tenant/scan-pay` lists links with a jsonb containment filter on that id and
  collections with `account_ref ILIKE '<merchantCode>%'`.
- `POST /tenant/scan-pay/charge` refuses a link that is not this tenant's.
- `POST /tenant/scan-pay/pay` may pay **any** link (that is the point) and records
  `metadata.payer_tenant_id`.
- Payer phones are masked in the portal (`2547***78`).

## Merchant code and reconciliation

`tenantMerchantCode({ phone, slug })` = `SP` + last six digits of the tenant's
phone (`SP245555`). Each prompt's M-Pesa `AccountReference` starts with that code,
so a paybill statement line can be matched to the tenant that requested it.

## Failure modes the UI shows instead of hiding

| Condition | What the tenant sees |
|---|---|
| `MPESA_*` incomplete | Red banner listing the missing variables; links and QR codes still work |
| `kassangas_templates` missing | Red banner naming the SQL file to run |
| Template id not theirs | `404 That payment link is not one of yours.` |
| Link closed / expired | `410` on the pay page, with "ask the business for a new link" |
| Double tap inside 90 s | The existing prompt is replayed, no second STK |

## Demo script (5 minutes)

1. Tenant portal → **Scan to Pay** → create "Guitar setup, KES 1,500".
2. **Show QR** → open `/pay/t/TMPL-…` on a phone → enter an M-Pesa number.
3. Prompt arrives → enter the PIN (sandbox) → refresh the portal → the collection
   appears with the masked payer and the merchant code.
4. Paste the same link into **Client wallet → Pay now** to show the other direction.

## Verification

```bash
npm run test:scan-pay      # 114 checks: rules, routes, portal wiring, customer page
```

Live checks after deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://alphadome.onrender.com/pay/t/PROBE   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://alphadome.onrender.com/tenant/scan-pay # 401
```

The `401` on the API is the isolation proof: the portal section needs a tenant
session, and only the customer page is public.
