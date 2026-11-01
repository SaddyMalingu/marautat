/**
 * Run tracking (2026-11-02)
 *
 * A collection run happens on the operator's machine, because that is where the
 * leased browser is. The portal runs somewhere else and cannot watch it. Until now
 * the only record was `tmp/collect_progress.json` on that machine: invisible to the
 * tenant, lost with the laptop, and per-operator instead of per-tenant.
 *
 * The record is now a row in `browser_actor_runs`, keyed by tenant, so every tenant
 * sees their own runs and nobody sees anyone else's.
 *
 * Three rules, each learned from a failure that looked like success:
 *
 *   1. **One active run per (tenant, kind).** Enforced by a partial unique index. Two
 *      operators on two machines cannot both claim one tenant's capture; a JavaScript
 *      check would have been a race, and the loser would have corrupted the winner's
 *      capture mid-flight.
 *   2. **Alive means a recent heartbeat**, not a `running` status. A runner that is
 *      killed leaves its row behind; reporting that as "running" is how a stuck job
 *      looks healthy for a week. `isStalled` is the difference.
 *   3. **Partial is a real outcome.** 76 links captured and 8 roles failed is neither
 *      success nor failure, and rounding it to either one hides the 8.
 *
 * Pure functions carry the rules and are tested; the store is a thin map onto SQL.
 */

export const RUN_TABLE = 'browser_actor_runs';

/** Kinds of work a tenant can see progress on. */
export const RUN_KINDS = Object.freeze(['collect', 'import', 'referrals', 'verify']);

export const RUN_STATUSES = Object.freeze([
  'queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'
]);

/** Statuses that still claim the tenant's profile lease. */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);

/**
 * A runner heartbeats every few roles (see scripts/browser_actor_referrals.mjs).
 * Five minutes without one means it is gone, not slow.
 */
export const RUN_STALL_MS = 5 * 60_000;

export const RUN_KIND_LABELS = Object.freeze({
  collect: 'Scan marketplace roles',
  import: 'Import roles as offers',
  referrals: 'Capture referral links',
  verify: 'Verify referral links'
});

/** Kinds the portal may queue for a runner. Verification runs inside the request. */
export const QUEUEABLE_KINDS = Object.freeze(['collect', 'import', 'referrals']);

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(String(status || '').toLowerCase());
}

export function kindLabel(kind) {
  return RUN_KIND_LABELS[String(kind || '').toLowerCase()] || String(kind || 'Run');
}

/** Heartbeat age in ms, or null when the run has never beaten. */
export function heartbeatAgeMs(run, now = Date.now()) {
  if (!run) return null;
  const at = run.heartbeat_at || run.started_at || null;
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? Math.max(0, now - ms) : null;
}

/**
 * Is this run dead rather than slow?
 *
 * Only a running status can stall: a finished run has no heartbeat requirement, and a
 * queued run has no runner to hear from yet — it is waiting, which is exactly what
 * the portal should say.
 */
export function isStalled(run, now = Date.now()) {
  if (!run) return false;
  if (String(run.status || '').toLowerCase() !== 'running') return false;
  const age = heartbeatAgeMs(run, now);
  return age !== null && age > RUN_STALL_MS;
}

/** How far along, as a number a progress bar and a sentence can both use. */
export function runProgress(run, now = Date.now()) {
  if (!run) return { percent: 0, done: 0, total: 0, label: 'No run', stalled: false };
  const total = Math.max(0, Number(run.total_items) || 0);
  const done = Math.max(0, Number(run.done_items) || 0);
  const stalled = isStalled(run, now);
  const status = String(run.status || '').toLowerCase();
  // A finished run is 100% even when the totals were never filled in: the runner said
  // it was done, and a bar stuck at 0% on a completed run reads as broken.
  const finished = ['succeeded', 'partial', 'failed', 'cancelled'].includes(status);
  const percent = finished ? 100 : total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return { percent, done, total, stalled, status };
}

/**
 * The status a runner should record for the work it did.
 *
 * `cancelled` and `error` win because they are statements about the run, not counts.
 * Everything else is arithmetic: all done = succeeded, none done = failed, anything
 * in between = partial. Reporting a half-finished capture as "succeeded" is the
 * specific lie this prevents.
 */
export function deriveRunStatus({ cancelled = false, error = null, total = 0, done = 0, ok = 0, failed = 0 } = {}) {
  if (cancelled) return 'cancelled';
  if (error) return failed > 0 || ok > 0 || done > 0 ? 'partial' : 'failed';
  const processed = Math.max(Number(done) || 0, (Number(ok) || 0) + (Number(failed) || 0));
  if (processed === 0) return 'failed';
  if (Number(failed) === 0 && (!Number(total) || processed >= Number(total))) return 'succeeded';
  if (Number(ok) === 0) return 'failed';
  return 'partial';
}

function humanAge(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * One sentence a tenant can act on.
 *
 * "Waiting for a runner" is deliberately not phrased as progress: a queued run has no
 * worker until the operator starts one, and dressing that up as activity would make a
 * forgotten queue look like a busy system.
 */
export function describeRun(run, now = Date.now()) {
  if (!run) return 'No run yet.';
  const status = String(run.status || '').toLowerCase();
  const label = kindLabel(run.kind);
  const { done, total } = runProgress(run, now);
  const age = humanAge(heartbeatAgeMs(run, now));

  if (status === 'running') {
    if (isStalled(run, now)) return `${label} stopped reporting ${age} ago — re-run to resume from where it got to`;
    return total ? `${label} running · ${done}/${total} · updated ${age} ago` : `${label} running · updated ${age} ago`;
  }
  if (status === 'queued') return `${label} queued — waiting for a runner to pick it up`;
  if (status === 'cancelled') return `${label} cancelled${total ? ` at ${done}/${total}` : ''}`;
  if (status === 'partial') return `${label} finished with gaps · ${run.ok_items || 0} done, ${run.failed_items || 0} failed${run.message ? ` · ${run.message}` : ''}`;
  if (status === 'failed') return `${label} failed${run.message ? ` · ${run.message}` : ''}`;
  return `${label} finished${total ? ` · ${done}/${total}` : ''}${run.message ? ` · ${run.message}` : ''}`;
}

/** May this tenant queue one more run of this kind? */
export function canQueue(runs = [], { kind, now = Date.now() } = {}) {
  const wanted = String(kind || '').toLowerCase();
  if (!QUEUEABLE_KINDS.includes(wanted)) {
    return { ok: false, reason: 'unknown_kind', message: `"${kind}" is not a queueable run kind` };
  }
  const blocking = (Array.isArray(runs) ? runs : []).find(
    (run) => run && String(run.kind || '').toLowerCase() === wanted && isActiveStatus(run.status) && !isStalled(run, now)
  );
  if (blocking) {
    return {
      ok: false,
      reason: 'already_active',
      message: `${kindLabel(wanted)} is already ${String(blocking.status || '').toLowerCase()} for this tenant`,
      run: blocking
    };
  }
  return { ok: true };
}

/** Where this tenant's most recent activity stands, per kind. */
export function summarizeRuns(runs = [], now = Date.now()) {
  const rows = (Array.isArray(runs) ? runs : []).filter(Boolean);
  const active = rows.filter((run) => isActiveStatus(run.status));
  const latestByKind = {};
  for (const run of rows) {
    const kind = String(run.kind || '').toLowerCase();
    if (!latestByKind[kind]) latestByKind[kind] = run; // rows arrive newest first
  }
  return {
    total: rows.length,
    active: active.length,
    stalled: active.filter((run) => isStalled(run, now)).length,
    latestByKind,
    // The line the portal shows when nothing is running.
    headline: active.length
      ? describeRun(active[0], now)
      : rows.length
        ? `Last run: ${describeRun(rows[0], now)}`
        : 'No collection run has been recorded for this tenant yet.'
  };
}

// ---------------------------------------------------------------------------
// Payload builders — pure, so the exact shapes written to the database are tested.
// ---------------------------------------------------------------------------

export function buildQueueRow({ tenantId, kind, sourceSlug = null, requestedBy = null, detail = {} } = {}) {
  return {
    tenant_id: tenantId,
    kind: String(kind || '').toLowerCase(),
    source_slug: sourceSlug || null,
    status: 'queued',
    requested_by: requestedBy || null,
    detail: detail && typeof detail === 'object' ? detail : {},
    total_items: Math.max(0, Number(detail?.limit) || 0)
  };
}

export function buildProgressPatch({ done, ok, failed, total, message = null } = {}) {
  return {
    done_items: Math.max(0, Number(done) || 0),
    ok_items: Math.max(0, Number(ok) || 0),
    failed_items: Math.max(0, Number(failed) || 0),
    ...(total === undefined ? {} : { total_items: Math.max(0, Number(total) || 0) }),
    ...(message ? { message } : {}),
    // The heartbeat is the only thing that separates a live run from an abandoned one,
    // so it travels with every progress patch rather than in a call of its own.
    heartbeat_at: new Date().toISOString()
  };
}

export function buildClaimPatch(now = new Date()) {
  return {
    status: 'running',
    started_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString()
  };
}

export function buildFinishPatch({ status, done, ok, failed, total, message = null, detail = null, now = new Date() } = {}) {
  const derived = RUN_STATUSES.includes(String(status || '').toLowerCase())
    ? String(status).toLowerCase()
    : deriveRunStatus({ total, done, ok, failed });
  return {
    status: derived,
    done_items: Math.max(0, Number(done) || 0),
    ok_items: Math.max(0, Number(ok) || 0),
    failed_items: Math.max(0, Number(failed) || 0),
    ...(total === undefined ? {} : { total_items: Math.max(0, Number(total) || 0) }),
    message: message || null,
    ...(detail && typeof detail === 'object' ? { detail } : {}),
    finished_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Store — a thin map onto the table. `table` is injectable so tests need no database.
// ---------------------------------------------------------------------------

/**
 * @param {() => any} table  returns a `browser_actor_runs` query builder
 */
export function createRunStore({ table, now = () => Date.now() } = {}) {
  if (typeof table !== 'function') throw new Error('createRunStore needs a table() function');

  return {
    async queue({ tenantId, kind, sourceSlug, requestedBy, detail }) {
      const row = buildQueueRow({ tenantId, kind, sourceSlug, requestedBy, detail });
      const { data, error } = await table().insert(row).select('*').maybeSingle();
      if (error) throw error;
      return data || { ...row, id: null };
    },

    /** Oldest queued run of a kind for this tenant — what a runner picks up first. */
    async claimNext({ tenantId, kind }) {
      const { data, error } = await table()
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('kind', kind)
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] || null : null;
      if (!row) return null;
      return this.claim({ runId: row.id });
    },

    async claim({ runId }) {
      const { data, error } = await table()
        .update(buildClaimPatch(new Date(now())))
        .eq('id', runId)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async progress({ runId, done, ok, failed, total, message }) {
      const { error } = await table()
        .update(buildProgressPatch({ done, ok, failed, total, message }))
        .eq('id', runId);
      if (error) throw error;
    },

    async finish({ runId, status, done, ok, failed, total, message, detail }) {
      const { data, error } = await table()
        .update(buildFinishPatch({ status, done, ok, failed, total, message, detail, now: new Date(now()) }))
        .eq('id', runId)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async cancel({ runId, tenantId }) {
      let query = table()
        .update({ status: 'cancelled', finished_at: new Date(now()).toISOString() })
        .eq('id', runId);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      const { data, error } = await query.select('*').maybeSingle();
      if (error) throw error;
      return data || null;
    },

    async list({ tenantId, limit = 20 }) {
      const { data, error } = await table()
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    }
  };
}


