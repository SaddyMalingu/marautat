/**
 * Render Workflow entry point (2026-11-05)
 *
 * This is the file the workflow service's **Start Command** must run:
 *
 *     node workflows/index.js
 *
 * (The dashboard's default `node index.js` crashes: there is no `index.js` in the repo root —
 * `package.json` still points `main` at one, which is a leftover, and the web service's own
 * start command is `node server.js`.)
 *
 * Registration is all a workflow worker needs to do; it connects to Render and waits for runs.
 * That is why the process never exits on its own.
 *
 * Build Command for this service: `npm install && npm install @renderinc/sdk@^1.7.0`
 * — the SDK is installed at build time rather than declared in package.json on purpose,
 * because adding a dependency without regenerating `package-lock.json` breaks `npm ci` in
 * `.github/workflows/blog-automation.yml`.
 *
 * Required environment variables (same names the web service already uses):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   one of OPENROUTER_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / HF_API_KEY
 *   SITE_URL   (canonical links on the pages)
 * Do **not** set REPLICATE_API_TOKEN here: image files cannot survive a workflow run.
 */
import { createClient } from '@supabase/supabase-js';
import { task } from '@renderinc/sdk/workflows';
import { registerBlogWorkflow } from './blogWorkflow.js';
import { requireSupabaseEnv } from '../utils/supabaseEnv.js';

// Same guard as scripts/blog_queue.mjs: a misconfigured service should say which variable is
// wrong, not fail at the socket with "fetch failed" once a task run is already underway.
const supabaseEnv = requireSupabaseEnv();
const supabase = createClient(supabaseEnv.url, supabaseEnv.key);

/** The queue reads the same two tables the portal does, so coverage is never guessed. */
async function load() {
  const { data: offers, error } = await supabase
    .from('opportunities')
    .select('id, title, slug, status, referral_url, compensation_max, description, deleted_at, source:opportunity_sources(slug)')
    .is('deleted_at', null);
  if (error) throw new Error('reading offers: ' + error.message);

  const ids = (offers || []).map((o) => o.id);
  if (!ids.length) return { offers: [], posts: [] };

  const { data: posts, error: postErr } = await supabase
    .from('blog_posts')
    .select('opportunity_id, slug, status')
    .in('opportunity_id', ids);
  // Refuse to plan on unknown coverage: treating a schema miss as "nothing is written yet"
  // would queue a full journey for every offer in the database.
  if (postErr) throw new Error('reading blog_posts: ' + postErr.message);

  return { offers: offers || [], posts: posts || [] };
}

async function generateOffer(offerId) {
  // Imported lazily so a workflow that only lists tasks does not pay for the writer's imports.
  const { generateBlogPostsForOpportunity } = await import('../scripts/blogManager.js');
  // images:false — see the note in blogWorkflow.js. The page is durable, the PNG is not.
  return generateBlogPostsForOpportunity(offerId, { images: false });
}

/**
 * Ask the web service to re-read `blog_posts` into `public/blog`.
 *
 * The pages were written to the *database* from this run; the site serves them from a
 * directory on a different machine. `POST /admin/restore-blogs` is the existing ops path for
 * that, and `server.js` accepts the key in an `x-admin-key` header so the password never
 * appears in a URL, a request log or an access log.
 *
 * Skipped when `ADMIN_PASS` is not configured rather than failing: the run's real output is
 * already durable, and the next deploy restores anyway.
 */
async function refreshSite() {
  const site = process.env.SITE_URL || 'https://alphadome.onrender.com';
  const key = process.env.ADMIN_PASS || process.env.ADMIN_KEY;
  if (!key) return { ok: false, skipped: 'no ADMIN_PASS on this service' };
  try {
    const response = await fetch(site.replace(/\/$/, '') + '/admin/restore-blogs', {
      method: 'POST',
      headers: { 'x-admin-key': key }
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json().catch(() => ({}));
    console.log('[workflow] site refreshed: ' + (body.restored == null ? 'ok' : body.restored + ' posts'));
    return { ok: true, restored: body.restored ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

registerBlogWorkflow({ task, deps: { load, generateOffer, refreshSite } });
console.log('[workflow] registered blogQueue + blogOffer');
