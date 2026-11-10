/**
 * Digital Drops routes — the storefront, the M-Pesa lane and the paywall.
 *
 * Mounted at `/` from `server.js` (one line), so the surface is:
 *
 *   GET  /drops                         storefront page (public/drops.html)
 *   GET  /drops/:slug                   the same page, deep-linked to one product
 *   GET  /drops/access/:token           delivery page (public/drops-access.html)
 *   GET  /api/drops                     published catalogue
 *   GET  /api/drops/:slug               one product
 *   POST /api/drops/:slug/checkout      M-Pesa prompt; amount computed here
 *   POST /drops/mpesa/callback          Safaricom callback for this lane only
 *   GET  /api/drops/order/:ref          buyer polls their own order with a secret
 *   GET  /api/drops/access/:token       what the buyer paid for
 *   GET  /api/drops/access/:token/file  the pack itself, behind the token
 *   GET  /api/drops/stats               revenue, admin key only
 *
 * Three invariants worth stating because breaking any one is a refund:
 *
 *   1. `amount` is never read from the request. `quoteCheckout()` prices the order
 *      from the database row, and the bump is a real product, not a discount flag.
 *   2. Neither `/drops/mpesa/callback` nor `/api/drops/access/*` takes a tenant
 *      session: they are the buyer's, not the tenant's. Everything that writes is
 *      keyed on the order that Safaricom's checkout id resolves to.
 *   3. Tables missing is a 503 that names the migration file, never a 500.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  TABLES,
  MIGRATION_FILE,
  ASSET_DIR,
  CHECKOUT_REPLAY_MS,
  DEFAULT_ACCESS_DAYS,
  dropsSecret,
  signEntitlement,
  verifyEntitlement,
  accessExpiry,
  accessState,
  validateProduct,
  isPublished,
  publicProduct,
  sortCatalog,
  quoteCheckout,
  normalizeSlug,
  newOrderRef,
  newLookupSecret,
  hashLookup,
  lookupMatches,
  orderTransition,
  deliveryMessage,
  supportWhatsAppLink,
  revenueSummary,
  parseMpesaCallback,
  isMissingTable,
  validateCheckout,
  MAX_ACCESS_DOWNLOADS,
  lanesFor,
  preferredLane,
  normalizeCountry,
  validateEmail,
  cardCheckoutUrl,
  verifyCardWebhook,
  parseCardWebhook,
  deliveryEmail,
  validateServiceRequest,
} from '../utils/digitalDrops.js';
import { sendDropsEmail, notifyServiceRequest, mailerConfigured } from '../utils/dropsMailer.js';

export const CATALOG_FILE = path.join(process.cwd(), 'data', 'drops_catalog.json');

/**
 * The seed catalogue, read from disk. The storefront uses this only when the
 * tables have not been migrated yet (a demo before the SQL runs); every write
 * path requires the database.
 */
export function readCatalogFile(file = CATALOG_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(raw) ? raw : (raw && raw.products) || [];
    return rows
      .map((r) => validateProduct(r))
      .filter((r) => r.ok)
      .map((r) => r.value);
  } catch {
    return [];
  }
}

export function createDropsRouter(deps = {}) {
  const {
    supabase,
    initiateStkPush,
    sendMessage,
    log = () => {},
    publicDir = path.join(process.cwd(), 'public'),
    env = process.env,
    sendEmail = sendDropsEmail,
  } = deps;

  const router = express.Router();
  const secret = dropsSecret(env);
  const assetRoot = path.join(process.cwd(), ASSET_DIR);

  const baseUrl = (req) => String(
    env.DROPS_BASE_URL || env.SITE_URL || (req.protocol + '://' + (req.get('host') || 'localhost'))
  ).replace(/\/+$/, '');

  const accessPath = (token) => '/drops/access/' + encodeURIComponent(token);

  function say(res, status, payload) {
    return res.status(status).json(payload);
  }

  function notInitialised(res) {
    return say(res, 503, {
      error: 'Digital drops are not initialised yet. Run ' + MIGRATION_FILE + ' against this database.',
      code: 'drops_not_initialised',
    });
  }

  async function recordEvent(event, patch = {}) {
    try {
      await supabase.from(TABLES.events).insert([{
        event,
        product_slug: patch.product_slug || null,
        order_ref: patch.order_ref || null,
        detail: patch.detail || {},
      }]);
    } catch (_) { /* analytics must never break a sale */ }
  }

  async function loadCatalog() {
    if (!supabase) return { products: sortCatalog(readCatalogFile()), source: 'file' };
    const { data, error } = await supabase
      .from(TABLES.products)
      .select('*')
      .eq('status', 'published')
      .order('rank', { ascending: true });
    if (!error && Array.isArray(data)) return { products: sortCatalog(data), source: 'db' };
    if (error && !isMissingTable(error)) {
      log('[drops] catalogue read failed: ' + error.message, 'ERROR');
      return { products: [], source: 'error', error: error.message };
    }
    return { products: sortCatalog(readCatalogFile()), source: 'file' };
  }

  async function loadProduct(slug) {
    const clean = normalizeSlug(slug);
    if (!clean) return null;
    if (!supabase) {
      const fromFile = readCatalogFile().find((p) => p.slug === clean) || null;
      return fromFile && isPublished(fromFile) ? fromFile : null;
    }
    const { data, error } = await supabase
      .from(TABLES.products)
      .select('*')
      .eq('slug', clean)
      .maybeSingle();
    if (error && isMissingTable(error)) {
      const fromFile = readCatalogFile().find((p) => p.slug === clean) || null;
      return fromFile && isPublished(fromFile) ? fromFile : null;
    }
    if (error) throw error;
    return data && isPublished(data) ? data : null;
  }

  /**
   * The one delivery path (2026-11-11). Both lanes pay into it: the M-Pesa callback
   * and the card webhook differ only in how the money was confirmed. Everything
   * after that — the entitlement per line, the WhatsApp message, the email, the
   * events — happens once, here.
   */
  async function deliverOrder({ order, receipt = null, req, lane = 'mpesa', meta = {} }) {
    const paidAt = new Date().toISOString();
    const expiresAt = accessExpiry(paidAt, DEFAULT_ACCESS_DAYS);
    const lines = Array.isArray(order.lines) && order.lines.length
      ? order.lines
      : [{ slug: order.product_slug, label: order.product_title, amount: order.amount }];

    await supabase.from(TABLES.orders).update({
      status: 'delivered',
      mpesa_receipt: lane === 'mpesa' ? (receipt || null) : (order.mpesa_receipt || null),
      paid_at: paidAt,
      delivered_at: paidAt,
      lane,
      metadata: {
        ...(order.metadata && typeof order.metadata === 'object' ? order.metadata : {}),
        ...meta,
      },
    }).eq('id', order.id);

    const slugs = lines.map((l) => String(l.slug || '')).filter(Boolean);
    const { data: productRows } = await supabase
      .from(TABLES.products)
      .select('slug, title, asset_file, delivery_note')
      .in('slug', slugs);
    const bySlug = new Map((productRows || []).map((p) => [p.slug, p]));

    const issued = [];
    for (const line of lines) {
      const slug = String(line.slug || '');
      if (!slug) continue;
      let token;
      try {
        token = signEntitlement({
          orderId: order.id,
          orderRef: order.order_ref,
          productSlug: slug,
          expiresAt,
        }, secret);
      } catch (signErr) {
        log('[drops] cannot sign entitlement for ' + order.order_ref + ': ' + signErr.message, 'ERROR');
        continue;
      }
      const { error: entErr } = await supabase.from(TABLES.entitlements).upsert([{
        order_id: order.id,
        order_ref: order.order_ref,
        product_slug: slug,
        token,
        expires_at: expiresAt,
      }], { onConflict: 'order_id,product_slug' });
      if (entErr) {
        log('[drops] entitlement write failed for ' + order.order_ref + ': ' + entErr.message, 'ERROR');
        continue;
      }
      const product = bySlug.get(slug) || { title: line.label || order.product_title };
      const accessUrl = baseUrl(req) + accessPath(token);
      issued.push({ slug, token, accessUrl, product });

      if (order.phone && typeof sendMessage === 'function') {
        try {
          await sendMessage(order.phone, deliveryMessage({
            product,
            order,
            receipt,
            expiresAt,
            accessUrl,
          }));
        } catch (msgErr) {
          // The link is also on the buyer's page; a WhatsApp outage must not undo
          // a payment that has already landed.
          log('[drops] delivery message failed for ' + order.order_ref + ': ' + msgErr.message, 'WARN');
        }
      }

      if (order.customer_email && typeof sendEmail === 'function') {
        try {
          const mail = deliveryEmail({ product, order, accessUrl, expiresAt, receipt });
          const sent = await sendEmail({
            to: order.customer_email,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            env,
          });
          if (!sent || !sent.ok) {
            log('[drops] delivery email not sent for ' + order.order_ref + ': ' + ((sent && (sent.reason || sent.error)) || 'unknown'), 'WARN');
          }
        } catch (mailErr) {
          log('[drops] delivery email error for ' + order.order_ref + ': ' + mailErr.message, 'WARN');
        }
      }
    }

    await recordEvent('paid', { product_slug: order.product_slug, order_ref: order.order_ref, detail: { amount: order.amount, lane } });
    await recordEvent('delivered', { product_slug: order.product_slug, order_ref: order.order_ref, detail: { lane } });
    log('[drops] ' + order.order_ref + ' paid and delivered via ' + lane + (receipt ? ' (receipt ' + receipt + ')' : ''), 'PAYMENT');

    return { expiresAt, issued };
  }


  // ---- pages ----------------------------------------------------------------
  router.get('/drops', (req, res) => {
    res.sendFile(path.join(publicDir, 'drops.html'));
  });

  // The delivery page is served for any token so the page itself can explain an
  // expired link rather than 404 at the edge.
  router.get('/drops/access/:token', (req, res) => {
    res.sendFile(path.join(publicDir, 'drops-access.html'));
  });

  router.get('/drops/:slug', (req, res) => {
    res.sendFile(path.join(publicDir, 'drops.html'));
  });

  // ---- catalogue ------------------------------------------------------------
  router.get('/api/drops', async (req, res) => {
    try {
      const { products, source } = await loadCatalog();
      return say(res, 200, {
        ok: true,
        source,
        support: supportWhatsAppLink(env),
        lanes: {
          mpesa: true,
          card: Boolean(String(env.DROPS_CARD_LINK || env.DROPS_CARD_LINKS || '').trim()),
        },
        products: products.map(publicProduct),
      });
    } catch (err) {
      log('[drops] catalogue error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'The catalogue could not be loaded.' });
    }
  });

  // Admin-only: what the stream actually earned, net of the M-Pesa fee.
  router.get('/api/drops/stats', async (req, res) => {
    const key = String(req.query.key || req.get('x-admin-key') || '');
    const expected = String(env.DROPS_ADMIN_KEY || env.ADMIN_PASS || '');
    if (!expected || key !== expected) return say(res, 403, { error: 'Unauthorized' });
    try {
      const { data, error } = await supabase
        .from(TABLES.orders)
        .select('status, amount, product_slug, product_title, created_at')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) {
        if (isMissingTable(error)) return notInitialised(res);
        throw error;
      }
      return say(res, 200, { ok: true, ...revenueSummary(data || []) });
    } catch (err) {
      log('[drops] stats error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'Revenue could not be read.' });
    }
  });

  router.get('/api/drops/:slug', async (req, res) => {
    try {
      const product = await loadProduct(req.params.slug);
      if (!product) return say(res, 404, { error: 'That product is not on sale.' });
      let bump = null;
      if (product.bump_slug) bump = await loadProduct(product.bump_slug);
      return say(res, 200, {
        ok: true,
        product: publicProduct(product),
        bump: bump ? publicProduct(bump) : null,
        support: supportWhatsAppLink(env),
      });
    } catch (err) {
      log('[drops] product error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'That product could not be loaded.' });
    }
  });

  // ---- checkout -------------------------------------------------------------
  // The buyer pays from this page. No tenant session, no basket, no card: one
  // product (plus an optional real bump product) and one M-Pesa prompt.
  router.post('/api/drops/:slug/checkout', async (req, res) => {
    const body = req.body || {};
    const check = validateCheckout(body);
    if (!check.ok) return say(res, 400, { error: check.errors[0], errors: check.errors });
    if (!secret) {
      return say(res, 503, {
        error: 'Checkout is not configured yet: set DROPS_TOKEN_SECRET on the service.',
        code: 'drops_secret_missing',
      });
    }
    if (typeof initiateStkPush !== 'function') {
      return say(res, 503, { error: 'The M-Pesa lane is not available in this process.' });
    }

    try {
      const product = await loadProduct(req.params.slug);
      if (!product) return say(res, 404, { error: 'That product is not on sale.' });
      if (!lanesFor(product).includes('mpesa')) {
        return say(res, 400, { error: 'This pack is not sold by M-Pesa. Use the card checkout.' });
      }

      const wantedBump = body.bump === true || body.bump === 'true' || body.bump === 1;
      const bumpProduct = wantedBump && product.bump_slug ? await loadProduct(product.bump_slug) : null;
      const quote = quoteCheckout(product, bumpProduct);
      if (!quote.ok) return say(res, 400, { error: quote.error });

      // A double tap inside 90 s is the same intent twice: reuse the open order
      // instead of pushing a second prompt to a phone that is already ringing.
      const since = new Date(Date.now() - CHECKOUT_REPLAY_MS).toISOString();
      const { data: recent } = await supabase
        .from(TABLES.orders)
        .select('order_ref, status, created_at')
        .eq('phone', check.phone)
        .eq('product_slug', product.slug)
        .in('status', ['pending', 'prompted'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);

      const open = Array.isArray(recent) ? recent[0] : null;
      if (open) {
        await recordEvent('checkout_replayed', { product_slug: product.slug, order_ref: open.order_ref });
        return say(res, 200, {
          ok: true,
          reused: true,
          orderRef: open.order_ref,
          status: open.status,
          message: 'A prompt is already open on that phone. Enter your PIN, or wait for it to arrive.',
        });
      }

      const lookup = newLookupSecret();
      const orderRef = newOrderRef();
      const { data: inserted, error: insertErr } = await supabase
        .from(TABLES.orders)
        .insert([{
          order_ref: orderRef,
          product_slug: product.slug,
          product_title: product.title,
          lines: quote.lines,
          phone: check.phone,
          amount: quote.amount,
          currency: quote.currency,
          status: 'pending',
          lookup_hash: hashLookup(lookup),
          metadata: { source: 'drops', kind: product.kind },
        }])
        .select('id, order_ref')
        .single();

      if (insertErr) {
        if (isMissingTable(insertErr)) return notInitialised(res);
        throw insertErr;
      }

      let stk;
      try {
        stk = await initiateStkPush({
          phone: check.phone,
          amount: quote.amount,
          accountRef: orderRef,
          transactionDesc: String(product.title).slice(0, 40),
          // This lane gets its own callback so a digital sale can never be
          // mistaken for a subscription by /mpesa/callback.
          callbackUrl: baseUrl(req) + '/drops/mpesa/callback',
        });
      } catch (stkErr) {
        await supabase.from(TABLES.orders).update({
          status: orderTransition('pending', 'failed') || 'failed',
          failure_reason: String(stkErr.message || 'stk failed').slice(0, 240),
        }).eq('id', inserted.id);
        await recordEvent('checkout_failed', { product_slug: product.slug, order_ref: orderRef, detail: { reason: 'stk' } });
        log('[drops] STK failed for ' + orderRef + ': ' + stkErr.message, 'WARN');
        return say(res, 502, {
          error: stkErr.message || 'M-Pesa could not send the prompt. Try again in a moment.',
        });
      }

      await supabase.from(TABLES.orders).update({
        status: orderTransition('pending', 'prompted') || 'prompted',
        checkout_request_id: stk && stk.CheckoutRequestID ? stk.CheckoutRequestID : null,
        merchant_request_id: stk && stk.MerchantRequestID ? stk.MerchantRequestID : null,
        prompted_at: new Date().toISOString(),
      }).eq('id', inserted.id);

      await recordEvent('checkout_prompted', { product_slug: product.slug, order_ref: orderRef });
      log('[drops] prompt for ' + orderRef + ' KES ' + quote.amount + ' -> ' + check.phone, 'PAYMENT');

      return say(res, 200, {
        ok: true,
        orderRef,
        lookup,
        status: 'prompted',
        amount: quote.amount,
        currency: quote.currency,
        lines: quote.lines,
        message: 'Check your phone: enter your M-Pesa PIN to finish. Your pack arrives here and on WhatsApp.',
      });
    } catch (err) {
      log('[drops] checkout error: ' + err.message, 'ERROR');
      if (isMissingTable(err)) return notInitialised(res);
      return say(res, 500, { error: 'Checkout could not start. Nothing has been charged.' });
    }
  });

  // ---- the card lane --------------------------------------------------------
  // The buyer pays on the provider's page. This creates the order first, so the
  // webhook has something to match, and hands back the hosted URL with the order
  // reference attached. The amount is priced here, in USD, from the catalogue row.
  router.post('/api/drops/:slug/checkout-card', async (req, res) => {
    const body = req.body || {};
    const emailCheck = validateEmail(body);
    if (!emailCheck.ok) return say(res, 400, { error: emailCheck.error });
    if (!secret) {
      return say(res, 503, {
        error: 'Checkout is not configured yet: set DROPS_TOKEN_SECRET on the service.',
        code: 'drops_secret_missing',
      });
    }

    try {
      const product = await loadProduct(req.params.slug);
      if (!product) return say(res, 404, { error: 'That product is not on sale.' });
      if (!lanesFor(product).includes('card')) {
        return say(res, 400, { error: 'This pack is not on sale by card yet.' });
      }

      const wantedBump = body.bump === true || body.bump === 'true' || body.bump === 1;
      const bumpProduct = wantedBump && product.bump_slug ? await loadProduct(product.bump_slug) : null;
      const quote = quoteCheckout(product, bumpProduct, { lane: 'card' });
      if (!quote.ok) return say(res, 400, { error: quote.error });

      // A double tap inside 90 s reuses the open order and its checkout URL.
      const since = new Date(Date.now() - CHECKOUT_REPLAY_MS).toISOString();
      const { data: recent } = await supabase
        .from(TABLES.orders)
        .select('order_ref, status, checkout_url, amount, currency')
        .eq('customer_email', emailCheck.email)
        .eq('product_slug', product.slug)
        .eq('lane', 'card')
        .in('status', ['pending', 'prompted'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);

      const open = Array.isArray(recent) ? recent[0] : null;
      if (open && open.checkout_url) {
        await recordEvent('checkout_replayed', { product_slug: product.slug, order_ref: open.order_ref, detail: { lane: 'card' } });
        return say(res, 200, {
          ok: true,
          reused: true,
          orderRef: open.order_ref,
          checkoutUrl: open.checkout_url,
          amount: Number(open.amount),
          currency: open.currency || 'USD',
          message: 'That checkout is still open. Finish it on the payment page.',
        });
      }

      const lookup = newLookupSecret();
      const orderRef = newOrderRef();
      const checkoutUrl = cardCheckoutUrl(env, { slug: product.slug, orderRef, email: emailCheck.email });
      if (!checkoutUrl) {
        return say(res, 503, {
          error: 'Card checkout is not configured yet: set DROPS_CARD_LINK (or DROPS_CARD_LINKS) to the provider checkout URL.',
          code: 'drops_card_not_configured',
        });
      }

      const { data: inserted, error: insertErr } = await supabase
        .from(TABLES.orders)
        .insert([{
          order_ref: orderRef,
          product_slug: product.slug,
          product_title: product.title,
          lines: quote.lines,
          phone: null,
          customer_email: emailCheck.email,
          amount: quote.amount,
          currency: quote.currency,
          status: 'pending',
          lane: 'card',
          lookup_hash: hashLookup(lookup),
          checkout_url: checkoutUrl,
          metadata: { source: 'drops', kind: product.kind, provider: 'hosted' },
        }])
        .select('id, order_ref')
        .single();

      if (insertErr) {
        if (isMissingTable(insertErr)) return notInitialised(res);
        throw insertErr;
      }

      await recordEvent('checkout_card_started', { product_slug: product.slug, order_ref: orderRef });
      log('[drops] card checkout ' + orderRef + ' ' + quote.currency + ' ' + quote.amount + ' -> ' + emailCheck.email, 'PAYMENT');

      return say(res, 200, {
        ok: true,
        orderRef,
        lookup,
        status: 'pending',
        checkoutUrl,
        amount: quote.amount,
        currency: quote.currency,
        lines: quote.lines,
        message: 'Opening the secure card page. Your pack is emailed the moment the card is charged.',
      });
    } catch (err) {
      log('[drops] card checkout error: ' + err.message, 'ERROR');
      if (isMissingTable(err)) return notInitialised(res);
      return say(res, 500, { error: 'Card checkout could not start. Nothing has been charged.' });
    }
  });


  // ---- Safaricom callback for this lane only --------------------------------
  // Acknowledge first: Safaricom retries anything that does not answer quickly,
  // and a retry must find the work already done, not do it twice.
  router.post('/drops/mpesa/callback', async (req, res) => {
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    if (!supabase) return;
    try {
      const cb = parseMpesaCallback(req.body || {});
      if (!cb.checkoutId) {
        log('[drops] callback without a CheckoutRequestID', 'WARN');
        return;
      }
      const { data: rows, error } = await supabase
        .from(TABLES.orders)
        .select('*')
        .eq('checkout_request_id', cb.checkoutId)
        .limit(1);
      if (error) {
        log('[drops] callback lookup failed: ' + error.message, isMissingTable(error) ? 'WARN' : 'ERROR');
        return;
      }
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) {
        // Not this lane's order: /mpesa/callback owns subscriptions, this owns drops.
        log('[drops] callback for unknown checkout ' + cb.checkoutId, 'WARN');
        return;
      }

      if (cb.resultCode !== 0) {
        const failed = orderTransition(order.status, 'failed');
        if (!failed) return;
        await supabase.from(TABLES.orders).update({
          status: failed,
          failure_reason: String(cb.resultDesc || 'payment failed').slice(0, 240),
        }).eq('id', order.id);
        await recordEvent('payment_failed', {
          product_slug: order.product_slug,
          order_ref: order.order_ref,
          detail: { resultCode: cb.resultCode, resultDesc: cb.resultDesc },
        });
        log('[drops] ' + order.order_ref + ' failed (ResultCode ' + cb.resultCode + ')', 'WARN');
        return;
      }

      const next = orderTransition(order.status, 'paid');
      if (!next) {
        log('[drops] duplicate paid callback ignored for ' + order.order_ref, 'WARN');
        return;
      }

      await deliverOrder({
        order,
        receipt: cb.receipt,
        req,
        lane: 'mpesa',
        meta: { callback_result: { resultCode: cb.resultCode, resultDesc: cb.resultDesc, amount: cb.amount, phone: cb.phone } },
      });
    } catch (err) {
      log('[drops] callback error: ' + err.message, 'ERROR');
    }
  });

  // ---- the provider's callback for the card lane ----------------------------
  // Signed over the raw body, matched by order reference, then handed to the same
  // deliverOrder() the M-Pesa lane uses. A provider that cannot sign can still be
  // bridged (Zapier/Make), but it must sign with DROPS_CARD_WEBHOOK_SECRET.
  router.post('/drops/card/webhook', async (req, res) => {
    const raw = typeof req.rawBody === 'string' && req.rawBody
      ? req.rawBody
      : JSON.stringify(req.body || {});
    if (!req.rawBody) log('[drops] card webhook without a raw body — the signature must be computed over the provider\'s exact bytes', 'WARN');

    const signature = req.get('x-drops-signature')
      || req.get('x-signature')
      || req.get('x-paystack-signature')
      || req.get('paddle-signature')
      || '';
    const check = verifyCardWebhook(raw, signature, env.DROPS_CARD_WEBHOOK_SECRET);
    if (!check.ok) {
      log('[drops] card webhook rejected: ' + check.reason, 'WARN');
      return say(res, 401, { error: 'Invalid signature', reason: check.reason });
    }

    const cb = parseCardWebhook(req.body || {});
    if (!cb.orderRef) return say(res, 400, { error: 'No order reference in the payload.' });

    try {
      const { data: rows, error } = await supabase
        .from(TABLES.orders)
        .select('*')
        .eq('order_ref', cb.orderRef)
        .limit(1);
      if (error) {
        if (isMissingTable(error)) return notInitialised(res);
        throw error;
      }
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) {
        log('[drops] card webhook for unknown order ' + cb.orderRef, 'WARN');
        return say(res, 404, { error: 'Unknown order reference.' });
      }

      if (cb.status === 'failed') {
        const failed = orderTransition(order.status, 'failed');
        if (!failed) return say(res, 200, { ok: true, ignored: 'already-terminal' });
        await supabase.from(TABLES.orders).update({
          status: failed,
          failure_reason: String('card: ' + (cb.raw || 'failed')).slice(0, 240),
        }).eq('id', order.id);
        await recordEvent('payment_failed', {
          product_slug: order.product_slug,
          order_ref: order.order_ref,
          detail: { lane: 'card', status: cb.raw, provider: cb.provider },
        });
        log('[drops] ' + order.order_ref + ' card payment failed (' + cb.raw + ')', 'WARN');
        return say(res, 200, { ok: true, status: 'failed' });
      }

      if (cb.status !== 'paid') {
        return say(res, 200, { ok: true, ignored: cb.raw || 'unhandled-status' });
      }

      // A provider may add tax or a fee; report a mismatch, do not fail the sale.
      if (cb.amount != null && Math.abs(Number(cb.amount) - Number(order.amount)) > 0.01) {
        log('[drops] ' + order.order_ref + ' provider amount ' + cb.amount + ' differs from order ' + order.amount + ' (' + order.currency + ')', 'WARN');
      }
      if (cb.currency && order.currency && cb.currency !== order.currency) {
        log('[drops] ' + order.order_ref + ' provider currency ' + cb.currency + ' differs from order ' + order.currency, 'WARN');
      }

      const next = orderTransition(order.status, 'paid');
      if (!next) {
        log('[drops] duplicate card webhook ignored for ' + order.order_ref, 'WARN');
        return say(res, 200, { ok: true, duplicate: true });
      }

      await supabase.from(TABLES.orders).update({
        provider: cb.provider,
        provider_ref: cb.providerRef,
      }).eq('id', order.id);

      await deliverOrder({
        order: { ...order, provider: cb.provider, provider_ref: cb.providerRef },
        receipt: cb.providerRef,
        req,
        lane: 'card',
        meta: { card: { status: cb.raw, amount: cb.amount, currency: cb.currency, provider: cb.provider, provider_ref: cb.providerRef } },
      });

      return say(res, 200, { ok: true, status: 'delivered' });
    } catch (err) {
      log('[drops] card webhook error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'Webhook could not be processed.' });
    }
  });

  // ---- rung 3: the funnel-build proposal request ----------------------------
  // A service, not a download. It lands in its own queue with enough detail to
  // price it, and the owner is notified without that notification blocking the
  // response (Render drops outbound SMTP; see docs/ADMIN_CONSOLE_2026-10-25.md).
  router.get('/build', (req, res) => {
    res.sendFile(path.join(publicDir, 'build.html'));
  });

  router.post('/api/service-requests', async (req, res) => {
    const check = validateServiceRequest(req.body || {});
    if (!check.ok) return say(res, 400, { error: check.errors[0], errors: check.errors });

    try {
      const { error } = await supabase.from(TABLES.serviceRequests).insert([{
        ...check.value,
        source: 'build-page',
      }]);
      if (error) {
        if (isMissingTable(error)) {
          return say(res, 503, {
            error: 'The proposal queue is not initialised yet. Run migrations/2026-11-11_digital_drops_card_lane.sql.',
            code: 'drops_not_initialised',
          });
        }
        throw error;
      }
      log('[drops] funnel build request from ' + check.value.email + ' (' + (check.value.country || '??') + ', ' + check.value.budget + ')', 'SYSTEM');

      if (typeof notifyServiceRequest === 'function') {
        notifyServiceRequest({ request: check.value, env }).catch(() => {});
      }
      return say(res, 201, {
        ok: true,
        message: 'Received. You will get a written scope and price, not a calendar link.',
      });
    } catch (err) {
      log('[drops] service request error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'That request could not be saved.' });
    }
  });

  router.get('/api/service-requests', async (req, res) => {
    const key = String(req.query.key || req.get('x-admin-key') || '');
    const expected = String(env.DROPS_ADMIN_KEY || env.ADMIN_PASS || '');
    if (!expected || key !== expected) return say(res, 403, { error: 'Unauthorized' });
    try {
      const { data, error } = await supabase
        .from(TABLES.serviceRequests)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) {
        if (isMissingTable(error)) return notInitialised(res);
        throw error;
      }
      return say(res, 200, { ok: true, requests: data || [] });
    } catch (err) {
      log('[drops] service request read error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'The queue could not be read.' });
    }
  });

  // ---- the buyer's own view of their order ----------------------------------
  // The browser holds `lookup`; the database holds only its hash. So the order
  // reference alone (printed on a receipt, visible in a WhatsApp thread) is not
  // enough to collect someone else's download link.
  router.get('/api/drops/order/:ref', async (req, res) => {
    try {
      const ref = String(req.params.ref || '').trim().toUpperCase();
      const lookup = String(req.query.lookup || '');
      if (!ref || !lookup) return say(res, 400, { error: 'Order reference and lookup are required.' });
      const { data, error } = await supabase
        .from(TABLES.orders)
        .select('id, order_ref, product_slug, product_title, amount, status, lookup_hash, phone, created_at, paid_at')
        .eq('order_ref', ref)
        .limit(1);
      if (error) {
        if (isMissingTable(error)) return notInitialised(res);
        throw error;
      }
      const order = Array.isArray(data) ? data[0] : null;
      if (!order || !lookupMatches(lookup, order.lookup_hash)) {
        return say(res, 404, { error: 'That order could not be found.' });
      }
      const payload = {
        ok: true,
        orderRef: order.order_ref,
        status: order.status,
        product: order.product_title,
        amount: Number(order.amount || 0),
        paidAt: order.paid_at || null,
      };
      if (order.status === 'paid' || order.status === 'delivered') {
        const { data: ents } = await supabase
          .from(TABLES.entitlements)
          .select('token, product_slug, expires_at')
          .eq('order_id', order.id);
        payload.access = (ents || []).map((e) => ({
          path: accessPath(e.token),
          product: e.product_slug,
          expiresAt: e.expires_at,
        }));
      }
      if (order.status === 'failed') payload.message = 'That payment did not complete. Nothing was charged twice — try again.';
      return say(res, 200, payload);
    } catch (err) {
      log('[drops] order lookup error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'That order could not be read.' });
    }
  });

  // ---- the paywall ----------------------------------------------------------
  async function loadEntitlement(token) {
    const check = verifyEntitlement(token, secret);
    if (!check.ok) return { ok: false, reason: check.reason };
    const { data, error } = await supabase
      .from(TABLES.entitlements)
      .select('*')
      .eq('token', String(token))
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) return { ok: false, reason: 'not-initialised' };
      throw error;
    }
    if (!data) return { ok: false, reason: 'not-found' };
    if (data.revoked_at) return { ok: false, reason: 'revoked' };
    if (accessState(data.expires_at) === 'expired') return { ok: false, reason: 'expired' };
    return { ok: true, entitlement: data, payload: check.payload };
  }

  const ACCESS_ERRORS = {
    expired: 'This access link has expired. Reply on WhatsApp and a human will extend it.',
    revoked: 'This access link was withdrawn. Reply on WhatsApp for help.',
    'not-found': 'This access link is not recognised.',
    'bad-signature': 'This access link is not valid.',
    malformed: 'This access link is not valid.',
    incomplete: 'This access link is not valid.',
    unconfigured: 'Access links are not configured on this service yet.',
  };

  router.get('/api/drops/access/:token', async (req, res) => {
    try {
      const loaded = await loadEntitlement(req.params.token);
      if (!loaded.ok) {
        if (loaded.reason === 'not-initialised') return notInitialised(res);
        return say(res, 403, {
          error: ACCESS_ERRORS[loaded.reason] || 'This access link cannot be used.',
          reason: loaded.reason,
        });
      }
      const { entitlement } = loaded;
      const { data: product, error: pErr } = await supabase
        .from(TABLES.products)
        .select('*')
        .eq('slug', entitlement.product_slug)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!product) return say(res, 404, { error: 'The product behind this link is no longer available.' });

      return say(res, 200, {
        ok: true,
        product: publicProduct(product),
        orderRef: entitlement.order_ref,
        expiresAt: entitlement.expires_at,
        downloads: entitlement.downloads || 0,
        downloadsLeft: Math.max(0, MAX_ACCESS_DOWNLOADS - Number(entitlement.downloads || 0)),
        file: product.asset_file ? '/api/drops/access/' + encodeURIComponent(entitlement.token) + '/file' : null,
        deliveryNote: product.delivery_note || '',
        support: supportWhatsAppLink(env),
      });
    } catch (err) {
      log('[drops] access error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'This pack could not be opened.' });
    }
  });

  router.get('/api/drops/access/:token/file', async (req, res) => {
    try {
      const loaded = await loadEntitlement(req.params.token);
      if (!loaded.ok) {
        if (loaded.reason === 'not-initialised') return notInitialised(res);
        return say(res, 403, { error: 'This access link cannot download files.', reason: loaded.reason });
      }
      const { entitlement } = loaded;
      const { data: product, error } = await supabase
        .from(TABLES.products)
        .select('slug, title, asset_file')
        .eq('slug', entitlement.product_slug)
        .maybeSingle();
      if (error) throw error;
      const file = product && product.asset_file ? path.basename(String(product.asset_file)) : '';
      if (!file) return say(res, 404, { error: 'This pack has no downloadable file yet.' });

      // basename() plus a resolved-prefix check: a catalogue row can never be
      // edited into ../../server.js and served as a download.
      const absolute = path.resolve(assetRoot, file);
      if (!absolute.startsWith(path.resolve(assetRoot) + path.sep)) {
        return say(res, 400, { error: 'Invalid pack path.' });
      }
      if (!fs.existsSync(absolute)) {
        log('[drops] missing asset ' + file + ' for ' + entitlement.order_ref, 'ERROR');
        return say(res, 503, { error: 'This pack is being rebuilt. Try again in a few minutes.' });
      }
      if (Number(entitlement.downloads || 0) >= MAX_ACCESS_DOWNLOADS) {
        return say(res, 429, { error: 'Download limit reached. Reply on WhatsApp and we will reset it.' });
      }

      // The counter is best effort: a failed increment must not cost a buyer a file.
      try {
        await supabase.from(TABLES.entitlements).update({
          downloads: Number(entitlement.downloads || 0) + 1,
          last_access_at: new Date().toISOString(),
        }).eq('id', entitlement.id);
      } catch (_) {}

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="' + file.replace(/"/g, '') + '"');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.sendFile(absolute);
    } catch (err) {
      log('[drops] file error: ' + err.message, 'ERROR');
      return say(res, 500, { error: 'This pack could not be downloaded.' });
    }
  });

  return router;
}

export default createDropsRouter;







