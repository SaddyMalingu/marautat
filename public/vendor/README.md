# Vendored browser libraries

Third-party files served straight from this site, so the merchant-facing screens
never depend on a CDN being reachable — or on a CDN path that answers 404.

| File | Package | Version | Licence | Used by |
|---|---|---|---|---|---|
| `qrcode.min.js` | [`qrcodejs`](https://github.com/davidshimjs/qrcodejs) | 1.0.0 | MIT | `public/vendor/qr-poster.js` (the module matrix), `public/kassangas-merchant-portal.html` (last-resort canvas) |
| `jsQR.js` | [`jsqr`](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | `admin/tenant_dashboard.html` (scan a poster, scan with camera), `public/kassangas-client-wallet.html` |
| `qr-poster.js` | ours, not third-party | — | same as the repo | `admin/tenant_dashboard.html` (Scan to Pay → Create QR + link / Download QR), `public/kassangas-merchant-portal.html` |

Both third-party files were taken byte-for-byte, unmodified, from
`https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js` and
`https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js`.

`qr-poster.js` is not vendored code: it is the small renderer that turns a
qrcodejs module matrix into a bitmap a camera can read (whole-pixel modules, four
modules of quiet zone). qrcodejs on its own fills fractional rects at
`width / modules` and draws edge to edge, which is unreadable on a dark panel.

## Why they live here

`admin/tenant_dashboard.html` used to load the generator from
`https://cdnjs.cloudflare.com/ajax/libs/qrcode.js/1.5.3/qrcode.min.js`. That path
returns **404**, so `QRCode` was undefined on every page load and Scan to Pay drew
"QR library unavailable — share the link instead" instead of a QR. Serving the
files from `public/` makes them available whenever the app itself is available.

`express.static(publicDir, { index: false })` in `server.js` serves this folder at
`/vendor/...`. Each page keeps a CDN fallback script that only runs if the global
is still missing, so a deploy without this folder degrades instead of breaking.

## Updating

1. Download the new build from jsDelivr (or the npm tarball).
2. Replace the file, keeping the same name so the `<script src>` paths stay put.
3. `npm run test:scan-pay` — that suite loads both files for real, draws a payment
   link with the generator and decodes it back with the reader.
