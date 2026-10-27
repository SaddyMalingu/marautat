# Tenant Scan to Pay — merchant wallet + client wallet

**Surface:** `admin/tenant_dashboard.html` → **Store → Scan to Pay**
**Backend:** `utils/scanPay.js` (rules) + `server.js` (routes)
**Customer page:** `public/pay.html` served at `/pay/t/<templateId>`
**Status:** built 2026-10-25 on the QR + STK stack already live for Kassangas.

## What a tenant can do

| Direction | Action | Endpoint |
|---|---|---|
| Collect | Create a reusable payment link (item + amount) | `POST /tenant/scan-pay/links` |
| Collect | Show the QR / copy the link / download the QR as a PNG | client-side (`/vendor/qrcode.min.js` + `/vendor/qr-poster.js`) |
| Collect | Prompt a named customer's phone for a link's amount | `POST /tenant/scan-pay/charge` |
| Collect | See links, per-link totals, collections, merchant code | `GET /tenant/scan-pay` |
| Pay | Pay any Alphadome pay link (paste, upload a poster, or live camera) | `POST /tenant/scan-pay/pay` |
| Pay (customer) | Open the link and prompt their own phone | `POST /pay/t/:tokenId/intent` |
| Resell | Sell an airtime/data bundle to a customer's number | `POST /api/kassangas/buy-product` |
| Resell | This tenant's own bundle sales + the catalogue + provider readiness | `GET /tenant/scan-pay/bundles` |

## The tools around the wallet

**QR, both directions.** `Create QR + link` draws the poster code (`public/vendor/qrcode.min.js`
through `public/vendor/qr-poster.js`) and `Download QR` saves that same PNG for
printing. On the pay side the same `jsQR` decoder serves an uploaded screenshot and
a live camera (`getUserMedia`, rear camera). The camera is released on decode, on
"Stop camera", and before the section re-renders, so the light never stays on. With
no camera or no permission the section says which of those happened and the paste
field still works.

Both libraries live in `public/vendor/` and are served from `/vendor/...` by the
same Express app. The first build pointed the generator at
`https://cdnjs.cloudflare.com/ajax/libs/qrcode.js/1.5.3/qrcode.min.js`, which
answers **404**, so `QRCode` was undefined on every load and the panel said
"QR library unavailable — share the link instead". Self-hosting removes that
failure mode; a CDN copy only loads if the vendored file is missing.

**Why `qr-poster.js` exists.** A QR that draws is not a QR that scans. qrcodejs
fills its canvas with a fractional tile — a 33-module link asked for at 190px gets
190/33 = 5.76px per module — so every module edge lands on a half pixel and the
browser anti-aliases it grey. It also draws edge to edge: **no quiet zone**, on a
panel that is dark. A phone camera will not lock onto that, which is what "the QR
is missing" actually looked like on 2026-10-27. `qr-poster.js` takes the module
matrix from qrcodejs and redraws it with

- a whole number of pixels per module (17px at the default 720px side),
- four modules of white margin on every side, filled as the canvas ground,
- the same bitmap handed to the screen and to `Download QR`.

Verified in the suite by decoding the poster against a near-black surround, the way
the panel presents it; a margin-less code fails that test. The merchant portal uses
the same helper, with `api.qrserver.com` still as the last-resort image.


**Money tools.** Two calculators on the same screen:

| Calculator | Inputs | Outputs | Carried over from |
|---|---|---|---|
| Sales | monthly target, already collected (prefilled with this tenant's Scan to Pay collections) | remaining gap, per day (30-day month), per week, already in | `public/kassangas-merchant-portal.html` |
| Cash flow | monthly income, monthly expenses | net cash flow, savings rate, suggested 10% reserve, daily spend at that rate | `public/kassangas-client-wallet.html` |

The gap for the day/week is rounded up, so "KES 0 left" never ships while a
shilling is still outstanding.

**Airtime and data bundles.** The bundle desk lists the same catalogue the
Kassangas wallet sells from (data bundles, airtime, KPLC, water, GOtv/DStv, gift
cards), shows the customer price, Alphadome's fee and what the tenant keeps
*before* confirming, and sells through `POST /api/kassangas/buy-product` with
`merchant_code` set to the tenant's own `SP<digits>`. Reads come from
`GET /tenant/scan-pay/bundles`, which filters `logs/digital_sales_transactions.jsonl`
by that same code, so one tenant never sees another's sales. The response also
carries `salesMode` (`sandbox` / `production`) and each provider's readiness, so a
"setup needed" provider is visible instead of being silently chosen.

## The customer page (`/pay/t/...`)

The customer page carries no session: it resolves the link through
`GET /api/kassangas/template/:tokenId`, then posts to the intent endpoint. It is
marked `noindex,nofollow` and is not in `sitemap.xml`.

## Reused, not rebuilt

- `kassangas_templates` — the payment link (created by the live Kassangas portal).
- `subscriptions` — the prompt, with `plan_type = 'tenant_scan_pay'`.
- `initiateStkPush()` — the single STK implementation in `server.js`.
- `qrcodejs 1.0.0` and `jsQR 1.4.0` — vendored in `public/vendor/` (provenance and
  licences in `public/vendor/README.md`), served at `/vendor/...`.
- `qr-poster.js` — our own 60-line renderer over qrcodejs' matrix: whole-pixel
  modules and a quiet zone, so the code scans off a screen and off paper.

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
- `GET /tenant/scan-pay/bundles` filters the sales log by the tenant's own merchant
  code and returns masked recipients only, so the bundle desk cannot read another
  tenant's sales.

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
| Vendored QR files missing from a deploy | A CDN copy loads and the section redraws itself |
| `qr-poster.js` missing | `showQr` falls back to qrcodejs' own 640px canvas on the white card; the QR still draws, one quiet zone thinner |

## Demo script (5 minutes)

1. Tenant portal → **Scan to Pay** → create "Guitar setup, KES 1,500".
2. **Show QR** → **Download QR** (a printable poster) → open `/pay/t/TMPL-…` on a phone → enter an M-Pesa number.
3. Prompt arrives → enter the PIN (sandbox) → refresh the portal → the collection
   appears with the masked payer and the merchant code.
4. Paste the same link into **Client wallet → Pay now**, or point **Scan with camera**
   at the poster, to show the other direction.
5. **Money tools** → target 120,000, already in (prefilled) → the gap and the daily
   number; then cash flow → net flow and savings rate.
6. **Airtime & data bundles** → pick "Safaricom Daily 1GB" → see the fee and what the
   tenant keeps → sell to a test number → the sale appears below with its TXN id.

## Verification

```bash
npm run test:scan-pay      # 153 checks: rules, routes, bundles, portal wiring, customer page, QR round trip, poster geometry
```

Live checks after deploy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://alphadome.onrender.com/pay/t/PROBE   # 200
curl -s -o /dev/null -w "%{http_code}\n" https://alphadome.onrender.com/tenant/scan-pay # 401
curl -s -o /dev/null -w "%{http_code}\n" https://alphadome.onrender.com/vendor/qr-poster.js # 200
```

The `401` on the API is the isolation proof: the portal section needs a tenant
session, and only the customer page is public.
