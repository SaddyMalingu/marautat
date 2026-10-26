/**
 * Article HTML guard for the blog writers.
 *
 * Why this module exists (live 2026-10-26, alphadome.onrender.com):
 * the writers ask a model for an *article fragment* — `h2`, `h3`, `p`, `ul`,
 * `li` — and the answer is injected into the page template's `<article>`. Some
 * models answer with a whole document instead: `<!DOCTYPE html>`, `<html>`, a
 * `<head>` carrying its own `<style>` with `background:#fff` / `color:#fff`,
 * often fenced in ```html. A `<style>` element still applies when it sits
 * inside `<body>`, so the model's palette overrode the site theme: a live probe
 * of the 283 published pages found 20 carrying a second `<style>` block, 27 that
 * pasted a whole document into the article, 10 declaring a white background,
 * 97 repeating the page title as their own `<h1>` and 105 breaking at least one
 * rule below — several white-on-white, i.e. a blank-looking page for a paying
 * tenant.
 *
 * The rules of the house are simple: a blog page has exactly one theme, ours,
 * and the article body may never restyle the page. `sanitizeArticleHTML()` is
 * the enforcement; `auditBlogHTML()` is how a caller proves a page still obeys
 * it before it is written or served.
 *
 * Pure functions only — no fs, no network, no database — so the verifier can run
 * offline (scripts/test_blog_html_sanitize.mjs).
 */

// One sentence that keeps a model from answering with a whole document. The
// sanitizer is the enforcement; this is the cheap prevention.
export const FRAGMENT_ONLY = ' Return ONLY the article body fragment: h2, h3, p, ul, li and table elements. '
  + 'No <!DOCTYPE>, <html>, <head>, <body>, <style> or <script> tags, no markdown fences, '
  + 'and no colour or background styles — the site supplies the theme.';

// Inline style declarations the theme owns. Everything else (padding, border,
// width, text-align) is layout and is kept: the salary angles legitimately ask
// for tables.
const THEME_DECLARATIONS = /^(?:color|background|background-color|background-image|font|font-family)\s*:/i;

/** Escape a value for an HTML attribute or text node. */
export function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Emphasis and links a model writes in markdown even when it was asked for HTML.
// Deliberately narrow: `_` is left alone (it shows up in identifiers and URLs),
// and a link only becomes an anchor when it is an absolute http(s) URL.
function inlineMarkdown(text) {
  return String(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

// Only the text nodes of an HTML line are touched, so an attribute value can
// never be rewritten into markup.
function inlineMarkdownInHtml(line) {
  return String(line).replace(/>([^<]+)</g, (m, text) => '>' + inlineMarkdown(text) + '<');
}

// Cheap "worth a pass?" test, so a normal HTML fragment is returned untouched:
// a block marker at the start of a line (heading, bullet, ordered item, quote)
// or an inline marker (**bold**, __bold__, ~~strike~~, `code`, [link](http…)).
const MAYBE_MARKDOWN = /(^|\n)[ \t]*(?:#{1,6}[ \t]|[*+\-][ \t]|\d+[.)][ \t]|>[ \t])|\*\*|__|~~|`|\[[^\]\n]+\]\(https?:/;

// Block-level markdown a plain-text answer falls back on. Live 2026-10-26:
// pages read "**SolidWorks Premium Skills Guide**" and "### Application Usage"
// on screen, with `*   **Corporate Finance**: …` bullets shown as literal
// asterisks, because the model ignored "HTML only" and answered in markdown.
// Deleting the markers (the old clean()) left the structure gone; converting
// them keeps the article readable.
function markdownBlocks(html) {
  if (!MAYBE_MARKDOWN.test(html)) return html;
  const out = [];
  let para = [];
  let list = null;
  let inPre = false;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; } };
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const raw of String(html).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (inPre) { out.push(line); if (/<\/(?:pre|code)>/i.test(line)) inPre = false; continue; }
    if (/<(?:pre|code)\b/i.test(line)) { flushPara(); closeList(); out.push(line); inPre = !/<\/(?:pre|code)>/i.test(line); continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (/^\s*</.test(line)) { flushPara(); closeList(); out.push(inlineMarkdownInHtml(line)); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara(); closeList();
      // The page already renders the post title as its only h1.
      const level = heading[1].length >= 3 ? Math.min(4, heading[1].length) : 2;
      out.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
      continue;
    }
    const item = line.match(/^\s*(?:([*+\-])|(\d+)[.)])\s+(.+)$/);
    if (item) {
      flushPara();
      const want = item[1] ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inlineMarkdown(item[3]) + '</li>');
      continue;
    }
    const quote = line.match(/^\s*>\s+(.+)$/);
    if (quote) { flushPara(); closeList(); out.push('<blockquote><p>' + inlineMarkdown(quote[1]) + '</p></blockquote>'); continue; }
    closeList();
    para.push(inlineMarkdown(line.trim()));
  }
  flushPara();
  closeList();
  return out.length ? out.join('\n') : html;
}

/**
 * Reduce model-authored copy to a body fragment that cannot repaint the page.
 * Idempotent: running it twice changes nothing.
 *
 * @param {string} input raw model output (fragment, full document or fenced)
 * @returns {string} safe article body HTML
 */
export function sanitizeArticleHTML(input) {
  let html = String(input == null ? '' : input);
  if (!html.trim()) return html;
  // Models wrap their answer in a ```html fence often enough to matter.
  html = html.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  // A full document: keep only what a body would have carried.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) html = bodyMatch[1];
  // Anything that can restyle or script the page, plus document scaffolding.
  html = html
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '');
  // Inline declarations that can hide text on the theme.
  html = html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, quoted, dq, sq) => {
    const kept = String(dq != null ? dq : sq).split(';').map((d) => d.trim())
      .filter((d) => d && !THEME_DECLARATIONS.test(d));
    return kept.length ? ' style="' + kept.join(';') + '"' : '';
  });
  // Presentational attributes bypass the stylesheet entirely.
  html = html
    .replace(/\sb(?:gcolor|ackground)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\scolor\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<font\b/gi, '<span')
    .replace(/<\/font>/gi, '</span>');
  // Markdown the model wrote instead of HTML, then one h1 per page: the template
  // already prints the post title as the article's only h1.
  html = markdownBlocks(html)
    .replace(/<h1(\s[^>]*)?>/gi, '<h2>')
    .replace(/<\/h1>/gi, '</h2>');
  // Collapse the blank runs the removals leave behind.
  return html.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Check one rendered page for the "one theme" rule.
 *
 * @param {string} html the full page as written to disk
 * @returns {{ ok: boolean, issues: string[], textLen: number }}
 */
export function auditBlogHTML(html) {
  const s = String(html || '');
  const issues = [];
  const styleCount = (s.match(/<style\b/gi) || []).length;
  if (styleCount !== 1) issues.push('style-blocks:' + styleCount);
  const htmlCount = (s.match(/<html\b/gi) || []).length;
  if (htmlCount !== 1) issues.push('html-tags:' + htmlCount);
  const bodyCount = (s.match(/<body\b/gi) || []).length;
  if (bodyCount !== 1) issues.push('body-tags:' + bodyCount);
  if (/```/.test(s)) issues.push('markdown-fence');
  const article = (s.match(/<article>([\s\S]*?)<\/article>/) || [])[1] || '';
  if (/<style\b|<script\b|<html\b|<body\b/i.test(article)) issues.push('ai-document-in-article');
  if (/\s(?:bgcolor|background)\s*=/i.test(article)) issues.push('ai-background-attribute');
  const whiteBg = (article.match(/background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/gi) || []).length;
  if (whiteBg) issues.push('white-background:' + whiteBg);
  // The template prints the title as the article's h1; a second one means the
  // model repeated it.
  const h1Count = (article.match(/<h1\b/gi) || []).length;
  if (h1Count > 1) issues.push('article-h1:' + h1Count);
  // Markdown that reached the browser as literal characters.
  if (/\*\*[^*\n]+\*\*/.test(article)) issues.push('markdown-bold');
  if (/(^|\n)\s*#{1,6}\s+\S/.test(article)) issues.push('markdown-heading');
  if (/(^|\n)\s*[*+-]\s+\S/.test(article)) issues.push('markdown-list');
  const textLen = article.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (textLen < 200) issues.push('thin-content:' + textLen);
  return { ok: issues.length === 0, issues, textLen };
}
