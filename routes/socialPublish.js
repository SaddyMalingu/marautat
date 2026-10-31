/**
 * Social publishing routes (2026-10-31)
 *
 * Two endpoints, one rule each:
 *
 *   GET  /tenant/blogger/posts/:slug/prefill      compose, never send
 *   POST /tenant/blogger/posts/:slug/publish/x    send to X, only if configured
 *
 * The rule that shapes this file: **X is automated, LinkedIn is assisted.** X
 * permits programmatic posting through API v2; LinkedIn does not permit automated
 * activity on a member profile, so the agent prepares the copy and a human presses
 * Post. `prefill` therefore returns a LinkedIn body marked `assisted: true` and no
 * endpoint exists that would post it — the absence is deliberate.
 *
 * A factory rather than a mounted router, because the auth chain
 * (tenantSessionAuth -> tenantSiteFromSession -> tenantOwnsPost) lives in
 * server.js scope. Injecting it keeps this file testable without booting the
 * monolith, and keeps the server.js change to a single `app.use`.
 */
import { Router } from 'express';
import { composeXPost, composeLinkedInPost, weightedLength, X_LIMIT } from '../utils/social/postText.js';
import { createXPublisher, SocialError, redactSecret } from '../utils/social/xPublisher.js';

function sendError(res, error) {
  if (error instanceof SocialError) {
    if (error.status >= 500) console.error('[social]', error.code, error.message);
    return res.status(error.status).json({
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details || null,
      retryAt: error.retryAt || null
    });
  }
  console.error('[social] unexpected', redactSecret(error?.message || error));
  return res.status(500).json({ ok: false, error: 'internal_error', message: 'Social publishing failed' });
}

export function createSocialPublishRouter(deps = {}) {
  const { tenantSessionAuth, tenantSiteFromSession, tenantOwnsPost, supabase, getShareCard, publisher } = deps;

  if (typeof tenantSessionAuth !== 'function' || typeof tenantSiteFromSession !== 'function') {
    throw new Error('createSocialPublishRouter needs tenantSessionAuth and tenantSiteFromSession');
  }

  const router = Router();
  const xPublisher = publisher || createXPublisher();

  async function loadCard(slug) {
    if (typeof getShareCard === 'function') return getShareCard(slug);
    const { getPostShareCard } = await import('../scripts/blogManager.js');
    return getPostShareCard(slug);
  }

  /** Resolve the tenant and prove it owns the post before doing anything else. */
  async function ownedPost(req) {
    const ctx = await tenantSiteFromSession(req);
    if (!ctx) return { error: { status: 404, body: { ok: false, error: 'tenant_not_found', message: 'Tenant not found' } } };

    const slug = String(req.params.slug || '').replace(/\.html$/i, '');
    if (!slug) return { error: { status: 400, body: { ok: false, error: 'invalid_request', message: 'Slug is required' } } };

    const { data: post } = await supabase.from('blog_posts')
      .select('slug, tenant_id, opportunity_id').eq('slug', slug).maybeSingle();
    if (!post) return { error: { status: 404, body: { ok: false, error: 'post_not_found', message: 'Post not found' } } };

    if (typeof tenantOwnsPost === 'function' && !(await tenantOwnsPost(post, ctx.site.id))) {
      return { error: { status: 403, body: { ok: false, error: 'not_owner', message: 'Post belongs to another tenant' } } };
    }
    return { post, ctx, slug };
  }

  function absoluteUrl(req, slug) {
    const base = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    return `${base}/blog/${slug}.html`;
  }

  /** Compose both destinations from one card and report what had to be dropped. */
  function composeAll({ card, url }) {
    const x = composeXPost({ hook: card.hook, excerpt: card.excerpt, url, hashtags: card.hashtags });
    const linkedin = composeLinkedInPost({ hook: card.hook, excerpt: card.excerpt, url, hashtags: card.hashtags });
    const warnings = [];
    if (card.mode === 'template') {
      warnings.push('The share card was composed from the page text, not written by a model (mode: template).');
    }
    if (x.dropped.excerpt) warnings.push('The excerpt did not fit in 280 weighted characters and was dropped.');
    if (x.dropped.hashtags) warnings.push('Hashtags were dropped to keep the link.');
    if (linkedin.foldRisk) warnings.push('The LinkedIn hook exceeds the visible area before "see more".');
    return { x, linkedin, warnings };
  }


  router.get('/tenant/blogger/posts/:slug/prefill', tenantSessionAuth, async (req, res) => {
    try {
      const owned = await ownedPost(req);
      if (owned.error) return res.status(owned.error.status).json(owned.error.body);

      const url = absoluteUrl(req, owned.slug);
      const card = await loadCard(owned.slug);
      if (!card || card.error) {
        return res.status(502).json({ ok: false, error: 'card_unavailable', message: card?.error || 'Could not build the share card' });
      }

      const { x, linkedin, warnings } = composeAll({ card, url });
      res.json({
        ok: true,
        slug: owned.slug,
        absolute_url: url,
        card: {
          hook: card.hook,
          summary: card.summary || null,
          excerpt: card.excerpt,
          hashtags: card.hashtags || [],
          mode: card.mode || 'template',
          // Carried through so the portal renders exactly what /share rendered.
          title: card.title || null,
          angle: card.angle || null,
          bullets: card.bullets || [],
          cached: !!card.cached
        },
        x: { text: x.text, weighted: x.weighted, remaining: x.remaining, dropped: x.dropped, automated: true },
        linkedin: { text: linkedin.text, length: linkedin.length, foldRisk: linkedin.foldRisk, assisted: true },
        warnings
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/tenant/blogger/posts/:slug/publish/x', tenantSessionAuth, async (req, res) => {
    try {
      const owned = await ownedPost(req);
      if (owned.error) return res.status(owned.error.status).json(owned.error.body);

      const url = absoluteUrl(req, owned.slug);
      let text = String(req.body?.text || '').trim();
      let composed = null;

      if (!text) {
        const card = await loadCard(owned.slug);
        if (!card || card.error) {
          return res.status(502).json({ ok: false, error: 'card_unavailable', message: card?.error || 'Could not build the share card' });
        }
        composed = composeAll({ card, url }).x;
        text = composed.text;
      }

      const measured = weightedLength(text);
      if (measured > X_LIMIT) {
        return res.status(400).json({
          ok: false,
          error: 'too_long',
          message: `Post is ${measured} weighted characters; X allows ${X_LIMIT}`,
          details: { measured, limit: X_LIMIT }
        });
      }

      // A dry run returns exactly what would be sent, so a tenant (or a test) can
      // see the post without touching the API or spending a rate-limit slot.
      if (req.body?.dry === true || String(req.query.dry || '') === '1') {
        return res.json({ ok: true, dry: true, text, weighted: measured, remaining: X_LIMIT - measured });
      }

      const tenantSlug = owned.ctx.site.slug || owned.ctx.site.tenant_slug || '';
      const result = await xPublisher.publish({ tenant: tenantSlug, text });
      res.json({
        ok: true,
        platform: 'x',
        tweet: { id: result.id, url: result.url, text: result.text, publishedAt: result.publishedAt },
        weighted: measured,
        source: composed ? 'share_card' : 'override'
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
