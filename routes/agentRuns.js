/**
 * Agent endpoints for a tenant's own worker (2026-11-02)
 *
 * A worker runs where the browser is: on the tenant's machine, for a desktop MoreLogin
 * profile that Render cannot reach. This is the API it talks to, and it is deliberately
 * tiny — the worker protocol is four calls, and everything else it needs already exists in
 * `browser_actor_runs`.
 *
 *   GET  /api/agent/health              prove the token works
 *   GET  /api/agent/runs                this tenant's queued/running runs
 *   POST /api/agent/runs/:id/claim      queued -> running (atomic compare-and-set)
 *   POST /api/agent/runs/:id/progress   counters + heartbeat
 *   POST /api/agent/runs/:id/finish     close with a status and a message
 *
 * Isolation rules, all enforced by the token rather than by trusting the caller:
 *
 *   - the tenant comes from the **token**, never from the request body;
 *   - claim is `update … where id = ? and tenant_id = ? and status = 'queued'`, so two
 *     workers racing for one run means one wins and the other gets a 409 — no in-memory
 *     lock, no coordination, correct under concurrency;
 *   - a revoked token is refused even though the row still exists.
 */
import { Router } from 'express';
import { createRunStore, deriveRunStatus, RUN_STATUSES, runPlatform } from '../utils/browserActor/runs.js';
import { bearerTokenFromHeader, createAgentTokenStore } from '../utils/browserActor/agentTokens.js';
import { applyCaptures, applyCaptureUpdates, readCoverage } from '../utils/browserActor/applyCaptures.js';
import { isValidEnvId } from '../utils/browserActor/identity.js';
import { publicWorkerBrowser, readAccess, writeWorkerBrowser } from '../utils/tenantAccess.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { createPairingStore, extractPairingCode, pairingState, PAIRING_TABLE } from '../utils/browserActor/pairing.js';
import { planSearchQueries } from '../utils/socialIntent.js';
import { isSocialPlatform } from '../utils/browserActor/tasks/socialPlatforms.js';
import {
  buildSignalRows,
  createSocialSignalStore,
  loadTaxonomy,
  sanitizeListeningPosts,
  SOCIAL_SIGNALS_TABLE
} from '../utils/socialSignals.js';

const MAX_CAPTURES_PER_RESULT = 50;
const MAX_TEXT = 20_000;

/**
 * A pairing attempt budget per address.
 *
 * The codes are long random strings, so guessing is not realistic — but an endpoint that mints
 * credentials should still have a ceiling, and a download passed around an office should stop
 * after one use rather than after a thousand tries. In memory on purpose: a restart clearing
 * a 10-minute budget is not a security problem.
 */
const PAIR_ATTEMPT_LIMIT = 10;
const PAIR_ATTEMPT_WINDOW_MS = 10 * 60_000;
const pairAttempts = new Map();

export function allowPairAttempt(ip, nowMs = Date.now()) {
  const key = String(ip || 'unknown');
  const entry = pairAttempts.get(key);
  if (!entry || entry.resetAt <= nowMs) {
    pairAttempts.set(key, { count: 1, resetAt: nowMs + PAIR_ATTEMPT_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= PAIR_ATTEMPT_LIMIT;
}

export function resetPairAttempts() {
  pairAttempts.clear();
}

function clampText(value, max = 500) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function cleanUrl(value) {
  const raw = clampText(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // A worker is untrusted input, so only real web links survive: `javascript:` and `file:`
    // have no business in a URL that ends up in a tenant's offer page.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * What a worker is allowed to say about a capture.
 *
 * Everything is coerced and bounded here rather than at the insert, because this body comes
 * from a machine we do not control: unknown fields are dropped, absurd lengths are cut, and a
 * non-web URL is discarded instead of being stored and rendered later.
 */
export function sanitizeAgentCaptures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_CAPTURES_PER_RESULT).map((item) => ({
    title: clampText(item?.title, 300),
    jobId: clampText(item?.jobId, 64),
    externalId: clampText(item?.externalId, 120),
    // The role page's own <title>, as the tenant's browser saw it. Some marketplaces render roles
    // in JavaScript, so the server's fetch gets the shell — only this evidence can prove a
    // captured link points at the role it claims (120 links were refused without it, 2026-11-04).
    pageTitle: clampText(item?.pageTitle, 300),
    url: cleanUrl(item?.url),
    referralUrl: cleanUrl(item?.referralUrl),
    content: clampText(item?.content, MAX_TEXT),
    summary: clampText(item?.summary, 2000),
    rate: clampText(item?.rate, 80),
    reason: clampText(item?.reason, 120),
    descriptionChars: Number.isFinite(Number(item?.descriptionChars)) ? Number(item.descriptionChars) : null
  })).filter((item) => (
    // A capture is identified by its job id (Micro1) **or** its marketplace id (Turing:
    // `turing:<slug>`). Requiring `jobId` silently dropped every Turing capture, and the route
    // then answered "no usable captures" — which is exactly what the tenant saw on 2026-11-03:
    // a run that captured 65 links and wrote nothing.
    item.title && (item.jobId || item.externalId)
  ));
}

export function createAgentRunsRouter({
  supabase,
  tokenTable = 'browser_actor_agent_tokens',
  runTable = 'browser_actor_runs',
  pairingTable = PAIRING_TABLE,
  socialTable = SOCIAL_SIGNALS_TABLE,
  now = () => Date.now()
} = {}) {
  const router = Router();
  const tokens = createAgentTokenStore({ table: () => supabase.from(tokenTable), now });
  const runs = createRunStore({ table: () => supabase.from(runTable), now });
  const pairings = createPairingStore({ table: () => supabase.from(pairingTable), now });
  const signals = createSocialSignalStore({ table: () => supabase.from(socialTable) });

  const fail = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });

  /** Resolve the token to a tenant, or refuse. Nothing downstream may guess it. */
  async function authenticate(req, res) {
    const token = bearerTokenFromHeader(req.get('authorization'));
    if (!token) {
      fail(res, 401, 'Missing bearer token — run the worker with --token, or create one in the portal');
      return null;
    }
    const row = await tokens.findLive(token).catch((error) => {
      fail(res, 500, error.message || 'Could not verify the token');
      return null;
    });
    if (!row) {
      // One message for "never existed" and "revoked": telling them apart would help a
      // token guesser more than a legitimate worker.
      fail(res, 401, 'This worker token is not valid. Create a new one in the portal.');
      return null;
    }
    const { data: site, error } = await supabase
      .from('site_tenants').select('id, slug').eq('id', row.tenant_id).maybeSingle();
    if (error) { fail(res, 500, error.message); return null; }
    if (!site) { fail(res, 401, 'This token belongs to a tenant that no longer exists'); return null; }
    tokens.touch({ id: row.id });
    return { tokenId: row.id, tenantId: site.id, tenantSlug: site.slug };
  }

  /** Health first: a worker should fail at startup, not halfway through a claim loop. */
  router.get('/api/agent/health', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    res.json({ ok: true, tenant: auth.tenantSlug, serverTime: new Date(now()).toISOString() });
  });

  /**
   * "The browser on this computer is P-4." — the worker reporting what it found (2026-11-03).
   *
   * Why this endpoint exists at all: the first version of BYO access asked the tenant to
   * paste a MoreLogin API key so the server could learn an envId. But when the worker already
   * runs next to MoreLogin, `ml-cli env list` answers that question on that machine, with no
   * key and no choice to make — so the tenant should never see an envId, and this is the
   * call that removes both steps. The worker keeps no secret it did not already have: the
   * token it authenticates with is the same one it uses for runs.
   *
   * What is stored is deliberately not `browserAccess`: nothing was sealed and no key
   * arrived, so it must not look like a connection the tenant made with a credential. It is
   * only ever used to resolve a run **on that machine** (`workerRuns`), never server-side.
   */
  router.post('/api/agent/browser', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const envId = String(req.body?.envId ?? '').trim();
      if (!isValidEnvId(envId)) {
        return fail(res, 400, 'That does not look like a MoreLogin profile id — expected digits only', {
          hint: 'The worker reads it from your own MoreLogin window, so this usually means the wrong value was passed with --env-id.'
        });
      }

      const { data: site, error } = await supabase
        .from('site_tenants').select('id, slug, metadata').eq('id', auth.tenantId).maybeSingle();
      if (error) throw error;
      if (!site) return fail(res, 404, 'Tenant not found');

      const metadata = writeWorkerBrowser(site.metadata, {
        envId,
        label: clampText(req.body?.label, 120),
        machine: clampText(req.body?.machine, 120),
        reportedAt: new Date(now()).toISOString()
      });
      const { error: writeError } = await supabase
        .from('site_tenants').update({ metadata }).eq('id', auth.tenantId);
      if (writeError) throw writeError;

      const keyed = readAccess(metadata);
      console.error(`[agent] worker browser reported tenant=${auth.tenantSlug} profile=${envId}${req.body?.label ? ` label=${clampText(req.body.label, 60)}` : ''}`);
      res.json({
        ok: true,
        workerBrowser: publicWorkerBrowser(metadata),
        // Which profile a run will actually use, said out loud: a tenant who connected a key
        // would otherwise wonder why their new report changed nothing.
        uses: keyed?.keySealed ? 'tenant' : 'worker',
        note: keyed?.keySealed
          ? 'Saved, but the MoreLogin key you connected in the site portal takes priority — press Disconnect there if this computer should be used instead.'
          : 'Saved. Captures from this computer use this profile; nothing else to set up.'
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not record the browser');
    }
  });

  router.get('/api/agent/runs', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      // Everything this worker may act on: what is waiting, and what it already claimed.
      const all = await runs.list({ tenantId: auth.tenantId, limit: 20 });
      const relevant = all.filter((run) => ['queued', 'running'].includes(String(run.status)));
      res.json({ ok: true, tenant: auth.tenantSlug, runs: relevant });
    } catch (error) {
      fail(res, 500, error.message || 'Could not list runs');
    }
  });

  router.post('/api/agent/runs/:id/claim', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const id = String(req.params.id || '');
      // Compare-and-set in one statement: the `status = 'queued'` filter is what makes two
      // racing workers safe, and the tenant filter is what keeps one tenant out of another.
      const { data, error } = await supabase
        .from(runTable)
        .update({
          status: 'running',
          started_at: new Date(now()).toISOString(),
          heartbeat_at: new Date(now()).toISOString()
        })
        .eq('id', id)
        .eq('tenant_id', auth.tenantId)
        .eq('status', 'queued')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return fail(res, 409, 'That run is not queued for this tenant any more (claimed, cancelled or finished)');
      }
      res.json({ ok: true, run: data });
    } catch (error) {
      fail(res, 500, error.message || 'Could not claim the run');
    }
  });

  /** Progress is a heartbeat too: the portal decides "stalled" from it. */
  router.post('/api/agent/runs/:id/progress', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');
      await runs.progress({
        runId: run.id,
        done: req.body?.done,
        ok: req.body?.ok,
        failed: req.body?.failed,
        total: req.body?.total,
        message: req.body?.message ? String(req.body.message).slice(0, 300) : null
      });
      res.json({ ok: true });
    } catch (error) {
      fail(res, 500, error.message || 'Could not record progress');
    }
  });

  router.post('/api/agent/runs/:id/finish', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');

      const requested = String(req.body?.status || '').toLowerCase();
      // A worker may report a status, but only a real one; otherwise the counters decide.
      const status = RUN_STATUSES.includes(requested)
        ? requested
        : deriveRunStatus({
          done: req.body?.done,
          ok: req.body?.ok,
          failed: req.body?.failed,
          total: req.body?.total
        });
      const closed = await runs.finish({
        runId: run.id,
        status,
        done: req.body?.done,
        ok: req.body?.ok,
        failed: req.body?.failed,
        total: req.body?.total,
        message: req.body?.message ? String(req.body.message).slice(0, 300) : null,
        detail: req.body?.detail && typeof req.body.detail === 'object' ? req.body.detail : null
      });
      res.json({ ok: true, run: closed });
    } catch (error) {
      fail(res, 500, error.message || 'Could not close the run');
    }
  });

  /**
   * Everything the tenant's machine needs to run this job — and nothing more.
   *
   * Deliberately absent: the MoreLogin API key. A desktop profile is driven through the
   * MoreLogin client already signed in on that machine, so the key never leaves the server —
   * which means a stolen worker token cannot be turned into control of a marketplace account.
   *
   * The profile must be the **tenant's own and local**. Anything else is refused instead of
   * silently driving an operator's browser from a stranger's laptop.
   */
  router.get('/api/agent/runs/:id/context', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');

      const { data: tenantRow, error: tenantError } = await supabase
        .from('site_tenants').select('id, slug, name').eq('id', auth.tenantId).maybeSingle();
      if (tenantError) throw tenantError;
      if (!tenantRow) return fail(res, 404, 'Tenant not found');

      let identity;
      try {
        // `workerRuns: true` is what lets a machine that already reported its own profile
        // (`POST /api/agent/browser`) start a run without the tenant mapping anything: the
        // envId came from MoreLogin on that computer, so only that computer can use it.
        identity = await resolveRunnerIdentity({ supabase, tenantSlug: auth.tenantSlug, workerRuns: true });
      } catch (error) {
        // The resolver knows what to do about it; the worker does not, and neither does the
        // tenant reading a 409 that says "no browser is mapped". Carry the fix through.
        const fix = error?.details?.fix
          || 'Connect your MoreLogin profile in the portal (Your own browser), or ask Alphadome to map a hosted profile for this tenant.';
        console.error(`[agent] context refused run=${run.id} tenant=${auth.tenantSlug}: ${error?.message || error} — ${fix}`);
        return fail(res, 409, `${error?.message || 'No browser is set up for this tenant yet'}. ${fix}`);
      }
      // Only a cloud profile is out of reach for a worker: the browser is not on any machine
      // the tenant owns, so the portal has to start it. Everything else — the tenant's own
      // profile, an operator-hosted one, or the single-profile default — is driven by
      // `ml-cli` on whatever machine holds it, which is exactly what a worker is for.
      //
      // Refusing `hosted` outright (the first version did) broke the operator's own tenant:
      // their profile IS a local desktop profile, and the worker runs on that same machine.
      if (identity.runtime !== 'local') {
        console.error(`[agent] context refused run=${run.id} tenant=${auth.tenantSlug}: runtime=${identity.runtime}`);
        return fail(res, 409, 'That profile runs in the cloud, so the portal should run it — press Capture now again');
      }
      console.error(`[agent] context run=${run.id} tenant=${auth.tenantSlug} source=${identity.source} profile=${identity.envId} → allowed`);

      const { data: offers, error: offersError } = await supabase
        // `referral_url` travels too: a worker that cannot see which roles already have a link
        // has to open every one of them again, which is how a 120-role run repeats itself every
        // morning (2026-11-05). The title is already the tenant's own; so is the link.
        .from('opportunities').select('title, slug, external_id, referral_url').eq('tenant_id', auth.tenantId);
      if (offersError) throw offersError;

      // `runPlatform` first: the platform is written into `detail.platform` by the queue route,
      // and reading only a top-level `platform` column made a listen run resolve as `micro1` —
      // which sent it the marketplace adapter and no searches at all.
      const platform = runPlatform(run) || String(run.platform || 'micro1');
      const { data: sourceRow } = await supabase
        .from('opportunity_sources').select('id, slug').eq('slug', platform).maybeSingle();

      // A listening run is told *what to read*, not what the tenant already owns: the taxonomy is
      // the server's, so a bundled copy on a customer's laptop cannot drift from the intents the
      // portal will score against. Two phrases per intent, three intents by default.
      const isListen = isSocialPlatform(platform) || String(run.kind) === 'listen';
      const queries = isListen
        ? planSearchQueries(loadTaxonomy(), {
            intents: Math.max(1, Math.min(4, Number(run.detail?.limit) || 3)),
            perIntent: 2
          })
        : null;

      res.json({
        ok: true,
        run: { id: run.id, status: run.status, platform, limit: Number(run.detail?.limit) || 12 },
        tenant: { slug: tenantRow.slug, name: tenantRow.name || null },
        // envId identifies the profile; the key stays here. `source` tells the worker whose
        // profile this is, so its log says `source=hosted` instead of leaving the operator
        // guessing which browser just moved.
        identity: { envId: identity.envId, runtime: identity.runtime, source: identity.source },
        sourceSlug: platform,
        sourceId: sourceRow?.id || null,
        // Titles/slugs only: enough to skip roles the tenant already has, and all of it their
        // own data. A listener needs none of it — sending 132 offers to a browser that only
        // reads posts would be a payload for nothing.
        known: isListen ? [] : (Array.isArray(offers) ? offers : []),
        ...(queries ? { queries } : {})
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not build the run context');
    }
  });

  /**
   * What a listening run found, to be scored and stored here.
   *
   * The same doctrine as `/result`: the machine sends what it *saw*, the server decides what it
   * *means*. A worker could send any score it liked, so it sends none — it sends post text and a
   * permalink, and the server scores against the taxonomy it owns. Two consequences worth stating:
   * a stolen worker token cannot inject a "hot lead", and a crawl that reads 300 posts produces
   * only the handful that match an intent.
   *
   * Like `/result`, this leaves the run open so a long listen can post in batches and `/finish`
   * closes it once.
   */
  router.post('/api/agent/runs/:id/signals', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');
      if (!['queued', 'running'].includes(String(run.status))) {
        return fail(res, 409, `That run is already ${run.status} — nothing was written`);
      }

      const posts = sanitizeListeningPosts(req.body?.posts);
      if (!posts.length) return fail(res, 400, 'That result contained no usable posts');

      const taxonomy = loadTaxonomy();
      if (!taxonomy.intents.length) {
        return fail(res, 503, 'The intent taxonomy is not available on the server, so nothing could be scored', {
          hint: 'data/aboss_social_intent_taxonomy.json is missing or unreadable — the posts themselves are fine.'
        });
      }

      const plan = buildSignalRows({
        posts,
        taxonomy,
        tenantId: auth.tenantId,
        platform: runPlatform(run) || 'linkedin',
        runId: run.id
      });
      const written = plan.rows.length
        ? await signals.insertMany({ tenantId: auth.tenantId, rows: plan.rows })
        : { inserted: 0, duplicates: 0, failed: 0 };

      const progress = await runs.progress({
        runId: run.id,
        done: posts.length,
        // "ok" is what the portal accepted or already had. A post that matched no intent was not
        // a failure — it is the normal case, and counting it as one would paint every good run amber.
        ok: written.inserted + written.duplicates,
        failed: 0,
        total: posts.length,
        message: `${written.inserted} new signal(s), ${written.duplicates} already known, `
          + `${plan.excluded} excluded, ${plan.notRelevant} off-topic of ${posts.length} read`.slice(0, 300)
      }).catch((error) => {
        console.error(`[agent] run ${run.id} could not record signal progress: ${error?.message || error}`);
        return null;
      });

      if (plan.rows.length) {
        console.error(`[agent] run ${run.id} stored ${written.inserted} signal(s) `
          + `(${written.duplicates} duplicates, ${plan.excluded} excluded, ${plan.notRelevant} off-topic)`);
      }

      res.json({
        ok: true,
        stored: written.inserted,
        duplicates: written.duplicates,
        failed: written.failed,
        dropped: { excluded: plan.excluded, notRelevant: plan.notRelevant },
        // The run stays open: `/finish` closes it after the last batch.
        run: progress || run
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not record the signals');
    }
  });

  /**
   *
   * This is why the tenant's machine needs no database credential: it reports what it saw,
   * and the server — which already holds the privilege — verifies each link and inserts the
   * offers. A valid token proves *who* sent this, not that it is safe, so the payload is
   * sanitised and every link is re-checked before it is attached.
   */
  router.post('/api/agent/runs/:id/result', async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    try {
      const run = await findRunForTenant(auth, req.params.id);
      if (!run) return fail(res, 404, 'Run not found for this tenant');
      if (!['queued', 'running'].includes(String(run.status))) {
        return fail(res, 409, `That run is already ${run.status} — nothing was written`);
      }

      const captures = sanitizeAgentCaptures(req.body?.captures);
      if (!captures.length) return fail(res, 400, 'That result contained no usable captures');

      const { data: tenantRow, error: tenantError } = await supabase
        .from('site_tenants').select('id, slug, name').eq('id', auth.tenantId).maybeSingle();
      if (tenantError) throw tenantError;
      if (!tenantRow) return fail(res, 404, 'Tenant not found');

      // Same resolution as `/context`: `detail.platform` is where the queue route records it.
      const platform = runPlatform(run) || String(run.platform || 'micro1');
      const { data: offers } = await supabase
        .from('opportunities').select('id, title, slug, external_id, referral_url, description, status')
        .eq('tenant_id', auth.tenantId);
      const { data: sourceRow } = await supabase
        .from('opportunity_sources').select('id').eq('slug', platform).maybeSingle();

      const applied = await applyCaptures({
        supabase,
        tenant: tenantRow,
        offers: Array.isArray(offers) ? offers : [],
        sourceId: sourceRow?.id || null,
        sourceSlug: platform,
        captures,
        apply: true
      });
      // The other half of a capture: offers that already exist. Micro1 brings new roles, so
      // `applyCaptures` inserts them; Turing brings a link and a body for 78 roles the tenant
      // already has, and inserting those would duplicate them. Both paths verify every link
      // server-side before writing — the worker is the machine that cannot be trusted to judge
      // whether a link lands on its own role.
      const updated = await applyCaptureUpdates({
        supabase,
        offers: Array.isArray(offers) ? offers : [],
        captures
      }).catch((error) => {
        console.error(`[agent] run ${run.id} could not apply offer updates: ${error?.message || error}`);
        return null;
      });
      const coverage = await readCoverage(supabase, tenantRow.id);

      const total = captures.length;
      const links = captures.filter((capture) => capture.referralUrl).length;
      const linksUpdated = updated?.links?.updated || 0;
      const descriptionsUpdated = updated?.descriptions?.updated || 0;
      // "ok" covers both shapes of work: an offer created, or an existing one given its link
      // or its body. Counting only inserts would report a perfect Turing run as a failure.
      const okCount = Math.min(total, applied.inserted + linksUpdated + descriptionsUpdated);
      const failed = Math.max(0, total - okCount);

      /**
       * Report progress, but do **not** close the run.
       *
       * A 120-role Turing run drives the browser for four minutes. While this endpoint closed
       * the run, everything was all-or-nothing: a worker that was stopped, or a machine that
       * slept, lost the whole capture even though sixty links had already been minted. Now the
       * runner may post in batches — each call verifies and writes what it was given, skipping
       * anything already written — and the run is closed by `/finish`, once, at the end.
       */
      const progress = await runs.progress({
        runId: run.id,
        done: total,
        ok: okCount,
        failed,
        total,
        message: `${applied.inserted} imported, ${linksUpdated} links attached, ${descriptionsUpdated} descriptions filled of ${total} captured${applied.error ? ` (${applied.error})` : ''}`.slice(0, 300)
      }).catch((error) => {
        console.error(`[agent] run ${run.id} could not record progress: ${error?.message || error}`);
        return null;
      });

      res.json({
        ok: true,
        applied: {
          planned: applied.planned,
          inserted: applied.inserted,
          skipped: applied.skipped,
          withLinks: applied.withLinks,
          withoutLinks: applied.withoutLinks,
          verification: applied.verification,
          error: applied.error,
          // What happened to offers that already existed (the Turing shape).
          existing: updated
            ? {
                linksUpdated,
                linksPlanned: updated.links?.planned || 0,
                linkSkipped: updated.links?.skipped || [],
                linkConflicts: updated.links?.conflicts || [],
                descriptionsUpdated,
                descriptionsSkipped: updated.descriptions?.skipped || []
              }
            : null
        },
        coverage,
        // The run stays open on purpose: `/finish` closes it, so a capture can arrive in
        // several batches and an interrupted run still keeps what it posted.
        run: progress || run
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not apply the result');
    }
  });

  /**
   * Trade a setup code for a worker token — the one endpoint a fresh install calls.
   *
   * Unauthenticated by necessity: the code *is* the credential, and it was shipped inside the
   * download the tenant just opened. Three things make that safe rather than hopeful:
   * the code is single-use (claimed atomically), it expires in 30 minutes, and only a hash of
   * it is stored. Attempts are rate-limited per IP so a stolen download is not a guessing game.
   */
  router.post('/api/agent/pair', async (req, res) => {
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    if (!allowPairAttempt(ip, now())) {
      return fail(res, 429, 'Too many setup attempts from this connection. Wait a few minutes, then download the worker again.');
    }

    const code = extractPairingCode(req.body?.code);
    if (!code) {
      return fail(res, 400, 'That does not look like a setup code — they start with pair_ and come inside the worker download.');
    }

    try {
      const row = await pairings.find(code);
      const state = pairingState(row, now());
      if (!state.ok) {
        console.error(`[agent] pairing refused (${state.reason}) from ${ip}`);
        return fail(res, state.reason === 'not_found' ? 404 : 409, state.message);
      }

      const issued = await tokens.issue({ tenantId: row.tenant_id, label: 'paired worker' });
      // Claim *after* the token exists so the row can point at it; if the claim loses the race,
      // the token we just made is revoked instead of becoming an orphan credential.
      const claimed = await pairings.claim(code, { tokenId: issued.row?.id || null });
      if (!claimed) {
        if (issued.row?.id) await tokens.revoke({ tenantId: row.tenant_id, id: issued.row.id }).catch(() => {});
        return fail(res, 409, 'That setup code was used a moment ago. Download the worker again for a fresh one.');
      }

      const { data: site } = await supabase
        .from('site_tenants').select('id, slug, name').eq('id', row.tenant_id).maybeSingle();
      if (!site) {
        await tokens.revoke({ tenantId: row.tenant_id, id: issued.row.id }).catch(() => {});
        return fail(res, 404, 'That setup code belongs to a tenant that no longer exists.');
      }

      console.error(`[agent] pairing accepted from ${ip} → tenant=${site.slug} token=${issued.row?.token_prefix || ''}`);
      res.status(201).json({
        ok: true,
        token: issued.token,
        api: `${req.protocol}://${req.get('host')}`,
        tenant: site.slug,
        note: 'Saved. This code has now been used and will not work again.'
      });
    } catch (error) {
      fail(res, 500, error.message || 'Could not complete setup');
    }
  });

  /** Tenant-scoped lookup for the two routes where the id comes from the URL. */
  async function findRunForTenant(auth, id) {
    const all = await runs.list({ tenantId: auth.tenantId, limit: 50 });
    return all.find((row) => row.id === String(id || '')) || null;
  }

  return router;
}

