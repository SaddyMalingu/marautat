#!/usr/bin/env node

/**
 * Distribution layer, verified without X, LinkedIn or a tenant session
 * (2026-10-31).
 *
 * The four things that break silently here:
 *
 *   1. X counts a URL as 23 characters. Truncate by `text.length` and you either
 *      waste room or publish a 282-character post that gets rejected after the
 *      round trip.
 *   2. A cut URL is a 404 a tenant sends to a customer. The link is never cut.
 *   3. The token is a bearer credential. It must never appear in an error body,
 *      a detail object or a log line.
 *   4. LinkedIn must not be automated. `prefill` marks it `assisted: true` and
 *      there is deliberately no publish endpoint for it.
 *
 * Usage: npm run test:social-publish
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import {
  X_LIMIT,
  LINKEDIN_LIMIT,
  X_URL_WEIGHT,
  weightedLength,
  trimToWeight,
  normalizeHashtags,
  composeXPost,
  composeLinkedInPost
} from '../utils/social/postText.js';
import { createXPublisher, resolveXToken, redactSecret, SocialError } from '../utils/social/xPublisher.js';
import {
  parseGeoProof,
  assertCountry,
  isUsableProof,
  maskIp,
  geoSummary,
  GEO_PROOF_URL
} from '../utils/browserActor/geo.js';
import { createSocialPublishRouter } from '../routes/socialPublish.js';
import { PLATFORMS, getPlatform, listPlatforms, describePlatform } from '../utils/browserActor/platforms.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

/** Assert a thrown error carries a specific `.code`, for either error family. */
async function expectCode(name, fn, code) {
  try {
    await fn();
    ok(name, false, `expected ${code}, resolved instead`);
  } catch (error) {
    ok(name, error?.code === code, `got ${error?.code || error?.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Composition rules
// ---------------------------------------------------------------------------
console.log('\n-- post text --');

const longUrl = 'https://alphadome.onrender.com/blog/a-very-long-writer-s-flow-slug-here.html';
ok('a long url costs 23 characters, not its real length',
  weightedLength(longUrl) === X_URL_WEIGHT, String(weightedLength(longUrl)));
eq('plain text is counted per character', weightedLength('hello'), 5);
eq('an emoji costs two', weightedLength('🚀'), 2);
eq('a CJK character costs two', weightedLength('漢'), 2);
ok('a url in the middle is weighted too',
  weightedLength(`read ${longUrl} now`) === 5 + X_URL_WEIGHT + 4, String(weightedLength(`read ${longUrl} now`)));

eq('trim keeps short text intact', trimToWeight('hello world', 50), 'hello world');
eq('trim cuts at a word boundary and marks the cut', trimToWeight('hello world again', 12), 'hello…');
eq('trim returns empty at zero budget', trimToWeight('hello', 0), '');

const tags = normalizeHashtags(['#Kenya', 'kenya', '  ##WritersFlow ', 'x', 'y']);
eq('hashtags get one hash and dedupe case-insensitively', tags.join(' '), '#Kenya #WritersFlow #x');
eq('hashtag cap is honoured', normalizeHashtags(['a', 'b', 'c', 'd'], 2).length, 2);

const short = composeXPost({
  hook: 'Kenyan SMEs lose tenders on paperwork.',
  excerpt: 'A short excerpt that fits comfortably.',
  url: longUrl,
  hashtags: ['Kenya', 'Tenders']
});
ok('a post that fits keeps everything', short.text.includes('Tenders') && short.text.includes(longUrl));
ok('a post that fits is under the limit', short.weighted <= X_LIMIT, String(short.weighted));
ok('a post that fits drops nothing', !short.dropped.hashtags && !short.dropped.excerpt && !short.dropped.hookTrimmed);

const longBody = composeXPost({
  hook: 'Kenyan SMEs lose tenders on paperwork.',
  excerpt: 'word '.repeat(120).trim(),
  url: longUrl,
  hashtags: ['Kenya', 'Tenders']
});
ok('hashtags go first when the post overflows', longBody.dropped.hashtags === true);
ok('the excerpt goes next', longBody.dropped.excerpt === true);
ok('the link survives both', longBody.text.includes(longUrl));
ok('the overflow post still fits', longBody.weighted <= X_LIMIT, String(longBody.weighted));

const longHook = composeXPost({ hook: 'word '.repeat(120).trim(), url: longUrl });
ok('a long hook is trimmed, not dropped', longHook.dropped.hookTrimmed === true);
ok('a trimmed hook keeps the link intact', longHook.text.includes(longUrl));
ok('a trimmed hook still fits', longHook.weighted <= X_LIMIT, String(longHook.weighted));

// ---------------------------------------------------------------------------
// 2. LinkedIn: composed, never automated
// ---------------------------------------------------------------------------
console.log('\n-- linkedin --');

const li = composeLinkedInPost({
  hook: 'Kenyan SMEs lose tenders on paperwork.',
  excerpt: 'A short excerpt.',
  url: longUrl,
  hashtags: ['Kenya']
});
eq('LinkedIn copy is always marked assisted', li.assisted, true);
ok('LinkedIn copy carries the link', li.text.includes(longUrl));
ok('a short hook does not break the fold', li.foldRisk === false);

const liFold = composeLinkedInPost({ hook: 'word '.repeat(60).trim(), url: longUrl });
eq('a hook past the fold is flagged', liFold.foldRisk, true);

const liLong = composeLinkedInPost({
  hook: 'Short hook.',
  excerpt: 'word '.repeat(900).trim(),
  url: longUrl
});
ok('LinkedIn body respects the 3000 limit', liLong.length <= LINKEDIN_LIMIT, String(liLong.length));


// ---------------------------------------------------------------------------
// 3. X publisher: measured before the call, token never leaked
// ---------------------------------------------------------------------------
console.log('\n-- x publisher --');

const TOKEN = 'x-user-token-SECRET-123';

function stubResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function publisherWith(response, options = {}) {
  const calls = [];
  const publisher = createXPublisher({
    env: {},
    baseUrl: 'https://api.x.test',
    tokenFor: () => TOKEN,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response; },
    ...options
  });
  return { publisher, calls };
}

{
  const { publisher, calls } = publisherWith(stubResponse(201, { data: { id: '1899', text: 'hello' } }));
  const out = await publisher.publish({ tenant: 'acme', text: 'hello world' });
  eq('a published post returns its id', out.id, '1899');
  ok('the post url is built from the id', out.url.includes('/status/1899'), out.url);
  eq('the call goes to API v2 tweets', calls[0].url, 'https://api.x.test/2/tweets');
  eq('the token travels as a bearer header', calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  eq('the body is the composed text', JSON.parse(calls[0].init.body).text, 'hello world');
}
{
  const { publisher, calls } = publisherWith(stubResponse(201, { data: { id: '1' } }));
  await expectCode(
    'an over-length post is rejected before the call',
    () => publisher.publish({ tenant: 'acme', text: 'a'.repeat(400) }),
    'social_invalid_request'
  );
  eq('a rejected post never reaches the network', calls.length, 0);
}
{
  await expectCode('a rejected token is typed',
    () => publisherWith(stubResponse(401, { detail: 'Unauthorized' })).publisher.publish({ tenant: 'acme', text: 'hi' }),
    'social_unauthorized');
  await expectCode('a forbidden scope is typed',
    () => publisherWith(stubResponse(403, { detail: 'Forbidden' })).publisher.publish({ tenant: 'acme', text: 'hi' }),
    'social_unauthorized');
}
{
  const reset = String(Math.floor(Date.now() / 1000) + 900);
  const { publisher } = publisherWith(stubResponse(429, '{}', { 'x-rate-limit-reset': reset }));
  try {
    await publisher.publish({ tenant: 'acme', text: 'hi' });
    ok('a rate limit is surfaced', false, 'resolved');
  } catch (error) {
    eq('a rate limit is typed', error.code, 'social_rate_limited');
    ok('a rate limit says when to retry', typeof error.retryAt === 'string' && error.retryAt.includes('T'), error.retryAt);
  }
}
{
  const { publisher } = publisherWith(null, {
    fetchImpl: async () => { const e = new Error('offline'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
  });
  await expectCode('an unreachable API is typed', () => publisher.publish({ tenant: 'acme', text: 'hi' }), 'social_network');
}
{
  const { publisher } = publisherWith(stubResponse(400, { detail: `Bearer ${TOKEN} is bad` }));
  try {
    await publisher.publish({ tenant: 'acme', text: 'hi' });
    ok('a 400 is surfaced', false, 'resolved');
  } catch (error) {
    ok('a token echoed by the API is redacted', !JSON.stringify(error.details || {}).includes(TOKEN), JSON.stringify(error.details));
  }
}
{
  const bare = createXPublisher({ env: {}, tokenFor: () => '' });
  await expectCode('publishing without a token is refused', () => bare.publish({ tenant: 'acme', text: 'hi' }), 'social_not_configured');
  eq('a token map resolves per tenant', resolveXToken('acme', { SOCIAL_X_TOKENS: JSON.stringify({ acme: 'tok-acme' }) }), 'tok-acme');
  eq('a single-tenant fallback resolves', resolveXToken('acme', { X_USER_ACCESS_TOKEN: 'tok-solo' }), 'tok-solo');
  await expectCode('an unknown tenant is not given someone else\u2019s token',
    () => Promise.resolve(resolveXToken('other', { SOCIAL_X_TOKENS: JSON.stringify({ acme: 'tok-acme' }) })),
    'social_not_configured');
  await expectCode('a malformed token map fails loudly',
    () => Promise.resolve(resolveXToken('acme', { SOCIAL_X_TOKENS: '{acme:' })),
    'social_not_configured');
  ok('redaction strips a bearer header', !redactSecret(`Bearer ${TOKEN}`).includes(TOKEN));
}

// ---------------------------------------------------------------------------
// 4. Geo proof: the proxy has to be where the work says it is
// ---------------------------------------------------------------------------
console.log('\n-- geo proof --');

const usExit = parseGeoProof({
  ip: '68.161.82.67',
  city: 'Lindenhurst',
  region: 'New York',
  country: 'US',
  loc: '40.6,-73.3',
  org: 'AS6128 Cablevision'
});
eq('ipinfo country is read', usExit.country, 'US');
eq('ipinfo city is read', usExit.city, 'Lindenhurst');
ok('ipinfo coordinates are parsed', usExit.loc && usExit.loc.lat === 40.6, JSON.stringify(usExit.loc));

const keExit = parseGeoProof({ ip: '41.90.64.2', city: 'Nairobi', country: 'KE', org: 'Safaricom' });
eq('a Kenyan exit passes a Kenyan assertion', assertCountry(keExit, 'ke').country, 'KE');

const ipApi = parseGeoProof({ query: '41.90.64.2', countryCode: 'KE', regionName: 'Nairobi', isp: 'Safaricom' });
eq('the ip-api shape is tolerated', ipApi.country, 'KE');
eq('the ip-api ip field is read', ipApi.ip, '41.90.64.2');

await expectCode('a US exit fails a Kenyan assertion',
  () => Promise.resolve(assertCountry(usExit, 'KE')),
  'geo_mismatch');
await expectCode('a private exit is not usable proof',
  () => Promise.resolve(assertCountry(parseGeoProof({ bogon: true, country: '' }), 'KE')),
  'geo_mismatch');
await expectCode('a malformed expected country is rejected',
  () => Promise.resolve(assertCountry(keExit, 'Kenya')),
  'invalid_request');

ok('a bogon proof is flagged unusable', isUsableProof(parseGeoProof({ bogon: true })) === false);
eq('an ipv4 address is masked before storage', maskIp('68.161.82.67'), '68.161.x.x');
eq('an ipv6 address is masked before storage', maskIp('2001:db8:85a3::8a2e'), '2001:db8:****');
eq('a bad address masks to null', maskIp('not-an-ip'), null);

const summary = geoSummary(usExit);
eq('the stored proof keeps the country', summary.country, 'US');
eq('the stored proof does not keep the raw address', summary.ip, '68.161.x.x');
ok('the geo proof url is the ipinfo endpoint', GEO_PROOF_URL.includes('ipinfo.io'), GEO_PROOF_URL);

// ---------------------------------------------------------------------------
// 5. Routes: tenant-scoped, dry-run safe, and LinkedIn has no publish path
// ---------------------------------------------------------------------------
console.log('\n-- routes --');

process.env.SITE_URL = 'https://example.test';

const POSTS = { 'post-1': { slug: 'post-1', tenant_id: 't1', opportunity_id: null } };
const stubSupabase = {
  from: () => ({
    select: () => ({
      eq: (column, value) => ({ maybeSingle: async () => ({ data: POSTS[value] || null, error: null }) })
    })
  })
};

let sessionSite = { id: 't1', slug: 'acme' };
const published = [];

const baseDeps = {
  tenantSessionAuth: (req, res, next) => next(),
  tenantSiteFromSession: async () => (sessionSite ? { site: sessionSite } : null),
  tenantOwnsPost: async (post, siteId) => post.tenant_id === siteId,
  supabase: stubSupabase,
  getShareCard: async (slug) => ({
    slug,
    title: 'Tender paperwork is not a writing problem',
    angle: 'angle-label',
    hook: 'Kenyan SMEs lose tenders on paperwork.',
    excerpt: 'A short excerpt that fits.',
    summary: 's',
    hashtags: ['Kenya'],
    bullets: [{ heading: 'H', text: 'T' }],
    mode: 'ai'
  }),
  publisher: {
    publish: async ({ tenant, text }) => {
      published.push({ tenant, text });
      return { id: '999', url: 'https://x.com/i/web/status/999', text, publishedAt: '2026-10-31T00:00:00.000Z' };
    }
  }
};

async function serve(deps) {
  const app = express();
  app.use(express.json());
  app.use('/', createSocialPublishRouter(deps));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const main = await serve(baseDeps);

async function call(base, path, { method = 'GET', body = null } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

{
  const prefill = await call(main.base, '/tenant/blogger/posts/post-1/prefill');
  eq('prefill answers', prefill.status, 200);
  eq('prefill marks LinkedIn as assisted', prefill.body.linkedin.assisted, true);
  eq('prefill carries the title the portal already shows', prefill.body.card.title, 'Tender paperwork is not a writing problem');
  eq('prefill carries the bullets the portal already shows', prefill.body.card.bullets.length, 1);
  eq('prefill marks X as automated', prefill.body.x.automated, true);
  ok('prefill uses an absolute url', prefill.body.absolute_url === 'https://example.test/blog/post-1.html', prefill.body.absolute_url);
  ok('the X body carries the link', prefill.body.x.text.includes(prefill.body.absolute_url));
  ok('the X body fits in 280 weighted characters', prefill.body.x.weighted <= X_LIMIT, String(prefill.body.x.weighted));
  eq('a model-written card raises no warnings', prefill.body.warnings.length, 0);
  ok('prefill never posts anything', published.length === 0);
}
{
  const templateDeps = { ...baseDeps, getShareCard: async (slug) => ({ slug, hook: 'H', excerpt: 'E', hashtags: [], mode: 'template' }) };
  const app2 = await serve(templateDeps);
  const res = await call(app2.base, '/tenant/blogger/posts/post-1/prefill');
  ok('a template card is disclosed to the tenant', res.body.warnings.some((w) => w.includes('template')), JSON.stringify(res.body.warnings));
  await new Promise((r) => app2.server.close(r));
}
{
  eq('an unknown post is a 404', (await call(main.base, '/tenant/blogger/posts/nope/prefill')).status, 404);

  sessionSite = { id: 't2', slug: 'other' };
  eq("another tenant's post is a 403", (await call(main.base, '/tenant/blogger/posts/post-1/prefill')).status, 403);

  sessionSite = null;
  eq('no session is a 404', (await call(main.base, '/tenant/blogger/posts/post-1/prefill')).status, 404);
  sessionSite = { id: 't1', slug: 'acme' };
}
{
  const dry = await call(main.base, '/tenant/blogger/posts/post-1/publish/x', { method: 'POST', body: { dry: true } });
  eq('a dry run answers', dry.status, 200);
  eq('a dry run posts nothing', published.length, 0);
  ok('a dry run still shows the text', dry.body.text.includes('https://example.test/blog/post-1.html'), dry.text.slice(0, 120));
}
{
  const live = await call(main.base, '/tenant/blogger/posts/post-1/publish/x', { method: 'POST', body: {} });
  eq('a live publish answers', live.status, 200);
  eq('a live publish returns the tweet', live.body.tweet.id, '999');
  eq('the tweet is attributed to the tenant slug', published[0].tenant, 'acme');
  eq('the composed card is the source', live.body.source, 'share_card');
}
{
  const before = published.length;
  const tooLong = await call(main.base, '/tenant/blogger/posts/post-1/publish/x', { method: 'POST', body: { text: 'a'.repeat(400) } });
  eq('an over-length override is a 400', tooLong.status, 400);
  eq('an over-length override is not sent', published.length, before);
}
{
  const failing = await serve({
    ...baseDeps,
    publisher: { publish: async () => { throw new SocialError('NOT_CONFIGURED', 'No X token configured for tenant "acme"'); } }
  });
  const res = await call(failing.base, '/tenant/blogger/posts/post-1/publish/x', { method: 'POST', body: {} });
  eq('an unconfigured tenant gets a 409, not a fake success', res.status, 409);
  eq('the failure is typed', res.body.error, 'social_not_configured');
  await new Promise((r) => failing.server.close(r));
}

// ---------------------------------------------------------------------------
// 6. Platform registry and portal wiring
// ---------------------------------------------------------------------------
console.log('\n-- platforms --');

const dash = fs.readFileSync('admin/tenant_dashboard.html', 'utf8');

eq('Micro1 is registered as an account source', getPlatform('micro1').sourceType, 'account');
eq('Turing is registered as an account source', getPlatform('turing').sourceType, 'account');
eq('Mercor is registered as a referral source', getPlatform('mercor').sourceType, 'referral');
eq('an unknown platform resolves to null', getPlatform('nope'), null);
eq('the registry lists three marketplaces', listPlatforms().length, 3);
eq('Micro1 is described as reading the tenant account', describePlatform('micro1').readsOwnAccount, true);

// Drift guard: the registry must point exactly where the portal's button goes, so
// an adapter can never be written against a URL the tenant stopped using.
const hrefOf = (id) => {
  const at = dash.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const match = dash.slice(at, at + 400).match(/href="([^"]+)"/);
  return match ? match[1] : null;
};
eq('the Micro1 button matches the registry', hrefOf('wfMicro1Btn'), PLATFORMS.micro1.portalUrl);
eq('the Turing button matches the registry', hrefOf('wfTuringBtn'), PLATFORMS.turing.portalUrl);
ok('both marketplace buttons open in a new tab without leaking the opener',
  /wfMicro1Btn[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(dash) &&
  /wfTuringBtn[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(dash));

// Distribution wiring in the portal.
ok('the Share modal asks for the composed copy', dash.includes('/prefill`'));
ok('the desktop composer prefill path still exists', dash.includes('shareActive=true'));
ok('a phone copies the caption instead of posting a bare link',
  dash.includes('wfIsMobileShare') && dash.includes('wfShareLinkedInMobile') && dash.includes('Caption copied'));
ok('the desktop composer prefill survives for the web case', dash.includes('shareActive=true'));
ok('copy is offered as the primary LinkedIn action',
  dash.includes('btn btn-sm btn-info" id="wfShareCopyLinkedIn"'));
ok('the portal no longer advertises a link-only LinkedIn share', !dash.includes('LinkedIn (link)'));
ok('an X prefill link sits beside the API post',
  dash.includes('twitter.com/intent/tweet') && dash.includes('/publish/x'));
ok('the portal shows marketplace coverage, not the collector progress file',
  dash.includes('/tenant/blogger/coverage') && dash.includes('wfCoverage') && !dash.includes('collect_progress'));
// The offers list is the tenant's working set, so it must be filterable by the three
// things that decide whether an offer earns: is it live, is its link real, has it
// been written.
ok('offers can be filtered by status, link health and pages',
  dash.includes('wfFilterStatus') && dash.includes('wfFilterLinks') && dash.includes('wfFilterPages'));
ok('offers can be sorted by column', dash.includes('data-wfsort') && dash.includes('wfOfferState'));
ok('a link pointing at another job is visible in the list, not just the strip',
  dash.includes('wrong job') && dash.includes('wfLinkBadge'));
ok('an offer with no referral link says so plainly', dash.includes('earns nothing'));
ok('X is published from the portal through the API', dash.includes('/publish/x'));
ok('there is no LinkedIn publish path anywhere in the portal', !/publish\/linkedin/i.test(dash));
ok('the portal tells the tenant LinkedIn is theirs to post', dash.includes('prepared for you to post'));

await new Promise((resolve) => main.server.close(resolve));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

