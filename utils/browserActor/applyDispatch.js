/**
 * Driving a ChatterApply run from a tenant's worker (2026-11-14)
 *
 * The tenant presses a button in the portal; the portal queues a row; this computer claims it. What is left is
 * the translation: the run's `detail` (answers + options) into an argv the existing script already understands,
 * and its output back into progress the portal can show.
 *
 * Kept pure and separate from `browser_actor_worker.mjs` for one reason: that file is the one thing a tenant
 * runs on their own machine, and every branch added to it is a branch nobody can unit-test. Here the argv is
 * data.
 */
import path from 'node:path';

/** The runner this worker spawns. A literal, matched by the bundle test, not a path built by hand. */
export const APPLY_SCRIPT = path.join('scripts', 'browser_actor_chatterapply.mjs');

/** Where the answers live while a run is in flight. Named per run so two runs cannot read each other's file. */
export function answersFileName(runId) {
  const safe = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return `.apply-answers-${safe || 'run'}.json`;
}

/**
 * The argv for one apply run.
 *
 * Only what the run asked for is passed: a wait of zero is not a wait, and typing is not claimed unless the
 * tenant asked for it. `--out` is pointed at a file so the runner's own report survives even if the portal is
 * unreachable when it ends.
 */
export function buildApplyChildArgs({ tenantSlug, answersPath, detail = {}, outPath = null } = {}) {
  if (!tenantSlug) throw new Error('a tenant slug is required');
  if (!answersPath) throw new Error('an answers file is required');
  const args = [APPLY_SCRIPT, '--tenant', String(tenantSlug), '--profile', String(answersPath)];
  const wait = Math.max(0, Math.min(3600, Number(detail.waitHumanSeconds) || 0));
  if (wait > 0) args.push('--wait-human', String(wait));
  if (detail.includeTyping) {
    const wpm = Math.max(20, Math.min(200, Number(detail.typingWpm) || 70));
    args.push('--include-typing', '--typing-wpm', String(wpm));
  }
  if (detail.open) args.push('--open');
  if (outPath) args.push('--out', String(outPath));
  return args;
}

/**
 * What a line of the runner's output means for the run's progress.
 *
 * The portal shows a bar and a sentence; the worker only knows text. Counting `advance` is the honest measure
 * of how far the form got, because that event is emitted exactly when the page really moved.
 */
export function classifyApplyLine(line) {
  const text = String(line == null ? '' : line);
  const isPrompt = /\*\* YOU:/.test(text);
  const advanced = /^\s*advance\b/.test(text) || /\badvance step \d+/.test(text);
  const filled = /^\s*fill\b/.test(text) || /\bfill step \d+/.test(text);
  const uploaded = /^\s*upload\b/.test(text);
  const failed = /^\s*Stopped:|"reason":\s*"(?!none)|— run failed|failed:/.test(text);
  return { text, isPrompt, advanced, filled, uploaded, failed };
}

/** A short sentence for the run's `message`, preferring the thing a person needs to act on. */
export function summarizeApplyLine(line) {
  const { text, isPrompt } = classifyApplyLine(line);
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isPrompt) return trimmed.replace(/^\s*/, '').slice(0, 300);
  return trimmed.slice(0, 300);
}
