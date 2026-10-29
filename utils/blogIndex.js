/**
 * Decisions about what belongs on the public blog, kept pure so they can be
 * tested without a database or a filesystem.
 *
 * Why these exist (2026-10-29): `restoreFromDB()` writes one `.html` per
 * published post, and both `/blog` index generators list whatever `.html` they
 * find on disk. So a file whose post is no longer published stays advertised
 * forever — the verifier's own pages ("verify-writers-flow-20261022080548
 * Salary Guide: What You Can Actually Earn") were 36 links deep in the public
 * index, and a verifier page still answered 200.
 *
 * Deleting files is the one destructive thing the boot path does, so the rule
 * lives here, where a test can pin it.
 */

// Slugs the verifier and the provider smoke test generate. They are real posts
// with real HTML and must never appear in public.
export const TEST_ARTIFACT_SLUG = /^(?:verify-writers-flow-|test-ai-specialist-)/i;

/** True when a slug belongs to a test artifact rather than a customer's page. */
export function isTestArtifact(slug) {
  return TEST_ARTIFACT_SLUG.test(String(slug || '').replace(/\.html$/i, ''));
}

/**
 * Files on disk that no published post owns.
 *
 * @param {string[]} files every filename in the blog directory
 * @param {Set<string>|string[]} keep filenames this restore just wrote
 * @returns {string[]} filenames safe to delete
 */
export function orphanPageFiles(files, keep) {
  const kept = keep instanceof Set ? keep : new Set(keep || []);
  return (files || []).filter((f) => {
    if (!/\.html$/i.test(f) || f === 'index.html') return false;
    return !kept.has(f);
  });
}

/**
 * The article body as stored inside a rendered page.
 *
 * The template adds three things that are not part of the stored article — the
 * <h1>, the "Published … | N min read" line and the lead image — so they are
 * stripped before comparing. Used by scripts/audit_page_fidelity.mjs to prove a
 * rebuild changed the page and not the prose.
 */
export function articleBodyOf(pageHtml) {
  const s = String(pageHtml || '');
  const open = s.indexOf('<article>');
  if (open < 0) return null;
  let body = s.slice(open + '<article>'.length);
  const close = body.indexOf('</article>');
  if (close >= 0) body = body.slice(0, close);
  body = body.replace(/<h1>[\s\S]*?<\/h1>/i, '');
  body = body.replace(/<p style="color:var\(--muted\)">Published [\s\S]*?<\/p>/i, '');
  body = body.replace(/^\s*<img\b[^>]*>/i, '');
  return body.trim();
}

/** Comparable text: tags stripped, whitespace collapsed. Case preserved. */
export function plainTextOf(html) {
  return String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A cached index that advertises a page which should no longer be public, or
 * that still carries the pre-2026-10-29 footer text. Either way it is stale and
 * the richer generator in server.js should rebuild it.
 */
export function indexIsStale(html) {
  const s = String(html || '');
  if (!s) return false;
  if (/(?:verify-writers-flow-|test-ai-specialist-)/i.test(s)) return true;
  return /Ready to Start\?|This (?:opportunity|offer) is available now\./.test(s);
}
