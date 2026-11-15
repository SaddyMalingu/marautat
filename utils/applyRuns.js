/**
 * ChatterApply as a *portal* run: answers in, run queued, worker drives it (2026-11-14)
 *
 * The operator console (`routes/applyConsole.js`) spawns the driver on the machine running the server. That
 * cannot work for a tenant whose MoreLogin profile sits on their own computer, and it cannot work at all from
 * Render. So this is the other half of the same idea:
 *
 *   tenant fills the page  ->  a row in `browser_actor_runs` (kind `apply`, platform `chatterapply`)
 *                          ->  their worker claims it and runs the same script against the same profile
 *                          ->  the log comes back through `/api/agent/runs/:id/progress`
 *
 * The answers are the tenant's, so the page collects them: name, Discord, country, email, phone, the
 * experience pair, the source, the referral and the desk-photo path. Only those keys exist here — an unknown
 * key is dropped **and reported**, because the runner matches profile keys to questions and a typo would
 * silently become a blank field on a live application.
 *
 * Pure functions, no database: the queue detail, the answer sanitiser and the bounded log are all testable.
 */

/** Its own kind, so a ChatterApply run never blocks a Micro1 capture waiting for the same profile. */
export const APPLY_KIND = 'apply';
export const APPLY_PLATFORM = 'chatterapply';

/** What the page may ask for. Anything else is refused, not defaulted. */
export const APPLY_MODES = Object.freeze(['fill', 'map', 'discover', 'dry-run']);

/**
 * The answers the runner understands, taken from the app's own question ids.
 *
 * `deskPhoto` is a **path on the tenant's machine**: the worker is what can see that file, so the page asks
 * for a path and the worker attaches it. Never the file itself — a photo uploaded to the portal and copied to
 * a worker is a second custody problem for no gain.
 */
export const ANSWER_KEYS = Object.freeze([
  'fullName', 'discordUsername', 'country', 'email', 'phone',
  'hasExperience', 'experienceDetails', 'source', 'referral', 'deskPhoto',
  // Steps 16–20 are the five writing answers (subscriber agency, sales process, the three caption
  // questions). They are the tenant's own words, so the page collects them and the runner types them —
  // without this the worker could drive the form to step 15 and then had nothing to write at 16.
  'subscriberAgency', 'salesProcess', 'captionShower', 'captionStrip', 'captionExplicit'
]);

export const WAIT_HUMAN_MAX_SECONDS = 3600;
export const TYPING_WPM_MIN = 20;
export const TYPING_WPM_MAX = 200;

/** How many log lines a run carries back. The worker adds one per event; the page shows the tail. */
export const MAX_LOG_LINES = 300;
/** One line is capped too: a single enormous line must not become the whole log. */
export const MAX_LOG_LINE = 400;

/** The answers that are prose, not a value: a caption question needs more than a name's worth of characters. */
export const LONG_ANSWER_KEYS = Object.freeze([
  'experienceDetails', 'subscriberAgency', 'salesProcess', 'captionShower', 'captionStrip', 'captionExplicit'
]);

/**
 * Keep only answers the runner knows, trimmed and bounded.
 *
 * Returns what was kept *and* what was dropped, because "my email did not save" is a support ticket unless the
 * response says `rejected: ['emial']`.
 */
export function sanitizeAnswers(raw = {}) {
  const answers = {};
  const rejected = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (!ANSWER_KEYS.includes(key)) { rejected.push(key); continue; }
    if (value === null || value === undefined) continue;
    const limit = LONG_ANSWER_KEYS.includes(key) ? 2000 : 300;
    const text = String(value).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, limit);
    if (text) answers[key] = text;
  }
  return { answers, rejected };
}

/** A queued run's detail: what the worker needs, and nothing it does not. */
export function buildApplyDetail(body = {}) {
  const errors = [];
  const mode = String(body.mode || 'fill');
  if (!APPLY_MODES.includes(mode)) errors.push(`mode must be one of ${APPLY_MODES.join(', ')}`);
  const waitHumanSeconds = Math.max(0, Math.min(WAIT_HUMAN_MAX_SECONDS, Number(body.waitHumanSeconds) || 0));
  const typingWpm = Math.max(TYPING_WPM_MIN, Math.min(TYPING_WPM_MAX, Number(body.typingWpm) || 70));
  const { answers, rejected } = sanitizeAnswers(body.answers);
  if (rejected.length) errors.push(`unknown answer keys: ${rejected.join(', ')}`);
  // The two answers whose absence stops a live application are named here, not discovered by a worker halfway
  // through somebody's form: the desk photo stops step 12, and a missing name stops step 3.
  if (!answers.fullName) errors.push('fullName is required');
  if (!answers.deskPhoto) errors.push('deskPhoto is required: the path to the photo on the worker machine');
  if (!Object.keys(answers).length) errors.push('at least one answer is required, or the run has nothing to fill');

  const detail = {
    platform: APPLY_PLATFORM,
    mode,
    waitHumanSeconds,
    includeTyping: Boolean(body.includeTyping),
    typingWpm,
    open: Boolean(body.open),
    answers
  };
  return { detail, errors, rejected };
}

/**
 * Append a line to a run's bounded log.
 *
 * Stored inside `detail` (an existing jsonb column) rather than a new table: the worker already posts progress
 * every few seconds, `detail` is ours to shape, and a migration is a deployment risk this feature does not need
 * to be useful. The tail is what a person reads; the whole history is not.
 */
export function appendLogLine(detail = {}, line, limit = MAX_LOG_LINES) {
  const text = String(line == null ? '' : line).replace(/\s+$/, '').slice(0, MAX_LOG_LINE);
  if (!text) return detail;
  const log = Array.isArray(detail?.log) ? detail.log.slice() : [];
  if (log[log.length - 1] === text) return detail; // a repeated heartbeat line is noise, not history
  log.push(text);
  while (log.length > limit) log.shift();
  return { ...detail, log };
}

/**
 * What the page shows for a run.
 *
 * Deliberately not the raw row: `detail` also carries the tenant's answers, and a status endpoint has no
 * business echoing somebody's email back to a browser. `prompt` is split out because it is the one line that
 * requires the tenant to do something.
 */
export function applyRunView(run) {
  if (!run) return null;
  const log = Array.isArray(run.detail?.log) ? run.detail.log.slice(-120) : [];
  const prompt = [...log].reverse().find((line) => /\*\* YOU:/.test(line)) || null;
  return {
    id: run.id,
    status: run.status,
    mode: run.detail?.mode || 'fill',
    startedAt: run.started_at || null,
    finishedAt: run.finished_at || null,
    heartbeatAt: run.heartbeat_at || null,
    done: run.done_items ?? 0,
    ok: run.ok_items ?? 0,
    failed: run.failed_items ?? 0,
    total: run.total_items ?? 0,
    message: run.message || null,
    prompt,
    log,
    answersSet: ANSWER_KEYS.filter((key) => Boolean(run.detail?.answers?.[key]))
  };
}
