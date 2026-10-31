/**
 * The marketplaces a Writer's Flow tenant actually earns on (2026-10-31).
 *
 * These are not referral funnels. The tenant already has an account, and the
 * portal already sends them to it:
 *
 *   Micro1  -> https://refer.micro1.ai/opportunities
 *   Turing  -> https://work.turing.com/jobs
 *
 * So the agent's job is to *read the tenant's own account* and surface what
 * matches, which is why these are `sourceType: 'account'` and why no referral
 * URL is invented. The portal URLs are duplicated here on purpose: a test asserts
 * they still equal the anchors in admin/tenant_dashboard.html, so the registry
 * cannot silently drift from the link a tenant actually clicks.
 *
 * `accountUrl` is the URL an adapter should open once the tenant is signed in.
 * Where that URL is not yet confirmed against a live session it is `null` rather
 * than a guess — see VERIFY notes.
 */
export const PLATFORM_SOURCE_TYPE = Object.freeze({
  REFERRAL: 'referral',
  ACCOUNT: 'account'
});

export const PLATFORMS = Object.freeze({
  mercor: Object.freeze({
    slug: 'mercor',
    name: 'Mercor',
    sourceType: PLATFORM_SOURCE_TYPE.REFERRAL,
    portalUrl: 'https://mercor.com',
    accountUrl: null,
    authRequired: true,
    verify: 'Confirm the signed-in opportunities URL before writing the adapter.'
  }),
  micro1: Object.freeze({
    slug: 'micro1',
    name: 'Micro1',
    sourceType: PLATFORM_SOURCE_TYPE.ACCOUNT,
    portalUrl: 'https://refer.micro1.ai/opportunities',
    accountUrl: 'https://refer.micro1.ai/opportunities',
    authRequired: true,
    verify: 'Signed-in listing may differ from the public page; confirm after login.'
  }),
  turing: Object.freeze({
    slug: 'turing',
    name: 'Turing',
    sourceType: PLATFORM_SOURCE_TYPE.ACCOUNT,
    portalUrl: 'https://work.turing.com/jobs',
    accountUrl: 'https://work.turing.com/jobs',
    authRequired: true,
    verify: 'Signed-in listing may differ from the public page; confirm after login.'
  })
});

export const PLATFORM_SLUGS = Object.freeze(Object.keys(PLATFORMS));

export function getPlatform(slug) {
  return PLATFORMS[String(slug || '').trim().toLowerCase()] || null;
}

export function listPlatforms() {
  return PLATFORM_SLUGS.map((slug) => PLATFORMS[slug]);
}

/** Public shape for a tenant-facing surface: no adapter internals leak out. */
export function describePlatform(slug) {
  const platform = getPlatform(slug);
  if (!platform) return null;
  return {
    slug: platform.slug,
    name: platform.name,
    portalUrl: platform.portalUrl,
    readsOwnAccount: platform.sourceType === PLATFORM_SOURCE_TYPE.ACCOUNT
  };
}
