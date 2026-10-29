/**
 * Objective quality gate for generated blog copy.
 *
 * Why this module exists (2026-10-25): the writers asked a model for "HTML with
 * h2,h3,p,ul,li" and got back, page after page, a heading followed by four
 * bullets. Nothing in the pipeline could tell a good draft from a bad one, so
 * "Generate 9 pages" always reported success and the audit of the 283 published
 * pages found 144-character non-articles alongside real ones.
 *
 * This module is the missing referee. It measures the things a converting blog
 * actually needs — prose, structure, specificity, a call to action, absence of
 * model boilerplate — and returns a score plus named issues. `scripts/blogManager.js`
 * uses it to (a) log what a page scored, (b) send one targeted repair prompt, and
 * (c) refuse to call a list-only stub a success.
 *
 * Deliberately heuristic, deterministic and dependency-free: the same HTML must
 * always score the same, offline, so the rule can be tested and tuned.
 *
 * 2026-10-29: the gate now also measures conversion — whether the offer arrives
 * in the first screen, whether there is an ask in the middle as well as at the
 * end, whether the page tells the reader what the next step demands, whether the
 * business ever speaks in first person, and whether the title is a promise.
 */
import { weakTitleReason } from './conversionPlaybook.js';

export const QUALITY_TARGETS = {
  // A page shorter than this is a note, not a blog post. Buyer pages run a
  // little shorter than career pages, so the gate is one floor for both.
  minWords: 700,
  minParagraphs: 8,
  minHeadings: 3,
  // Share of all words that sit inside <li>. Above this the page reads as notes.
  maxListWordRatio: 0.32,
  // A heading followed only by a list is the exact shape the old prompts
  // produced. One is a legitimate summary block; three is a bullet-point blog.
  maxListOnlySections: 1,
  minAvgSentences: 1.5,
  minScore: 70,
};

// Phrases that mark machine copy. `weight` is how many points one hit costs;
// capped per phrase so a model that likes a word cannot sink an otherwise good
// page — except the cliché openers, which are a positioning problem, not style.
const BANNED = [
  [/\bin today'?s (?:fast[- ]paced|digital|modern|competitive|ever[- ]changing)\b/gi, 'opens with "in today\'s fast-paced world"', 8, 1],
  [/\bin the (?:ever[- ]evolving|rapidly changing) (?:world|landscape|realm)\b/gi, 'ever-evolving world/landscape', 6, 1],
  [/\bwhether you'?re an? [^.,;]{3,40} or an? [^.,;]{3,40}/gi, 'the "whether you\'re an X or a Y" scaffold', 5, 1],
  [/\b(?:let'?s )?dive in(?:to)?\b/gi, '"dive in"', 3, 1],
  [/\bdelve into\b/gi, '"delve into"', 4, 1],
  [/\bunlock(?:ing)? (?:the|your|its) (?:full )?potential\b/gi, '"unlock potential"', 4, 1],
  [/\bgame[- ]chang(?:er|ing)\b/gi, '"game-changer"', 4, 1],
  [/\belevate your\b/gi, '"elevate your"', 3, 1],
  [/\bit'?s important to note\b/gi, '"it\'s important to note"', 3, 1],
  [/\b(?:in conclusion|to sum up|in summary)\b/gi, 'formal essay closing', 3, 1],
  [/\bnavigat(?:e|ing) the (?:complexities|landscape|world)\b/gi, '"navigate the complexities"', 3, 1],
  [/\bseamless(?:ly)?\b/gi, '"seamless"', 2, 2],
  [/\bcutting[- ]edge\b/gi, '"cutting-edge"', 2, 2],
  [/\bstate[- ]of[- ]the[- ]art\b/gi, '"state-of-the-art"', 2, 1],
  [/\bwe(?:'| a)?re (?:excited|thrilled) to\b/gi, '"we\'re excited to"', 3, 1],
];

const CTA = /\b(call|contact|whatsapp|book|order|enquir|inquir|request a quote|apply|sign up|get in touch|talk to us|start (?:today|now)|send us|visit us|reserve|shop now|learn more)\b/i;

function textOf(html) {
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

function wordsOf(text) {
  return String(text || '').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
}

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => wordsOf(s).length > 1);
}

function blocks(html) {
  // Every heading and paragraph, in document order, so a heading can be tied to
  // the prose (or the absence of it) that follows.
  const out = [];
  const re = /<(h2|h3|p|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    out.push({ tag: m[1].toLowerCase(), html: m[2], text: textOf(m[2]) });
  }
  return out;
}

/**
 * Score one article body.
 *
 * @param {string} html the article fragment (not the whole page)
 * @returns {{
 *   score: number, ok: boolean, critical: string[], words: number,
 *   paragraphs: number, headings: number, listWordRatio: number,
 *   listOnlySections: number, avgSentencesPerParagraph: number,
 *   numbers: number, cta: boolean,
 *   issues: Array<{code: string, detail: string, weight: number}>,
 *   summary: string
 * }}
 */
export function analyzeArticle(html, options) {
  const text = textOf(html);
  const words = wordsOf(text);
  const list = blocks(html);
  const issues = [];
  const critical = [];
  const add = (code, detail, weight, isCritical) => {
    issues.push({ code, detail, weight });
    if (isCritical) critical.push(code);
  };

  const paragraphs = list.filter((b) => b.tag === 'p' && wordsOf(b.text).length >= 12);
  const headings = list.filter((b) => b.tag === 'h2' || b.tag === 'h3');
  const listBlocks = list.filter((b) => b.tag === 'ul' || b.tag === 'ol');
  const listWords = listBlocks.reduce((n, b) => n + wordsOf(b.text).length, 0);
  const listWordRatio = words.length ? listWords / words.length : 0;

  // Paragraphs made only of one-line filler ("This is essential.", "Read on.")
  // are how a model pads a page without saying anything.
  const stubby = paragraphs.filter((p) => wordsOf(p.text).length < 18).length;
  const sentencesPerParagraph = paragraphs.map((p) => sentencesOf(p.text).length);
  const avgSentencesPerParagraph = sentencesPerParagraph.length
    ? sentencesPerParagraph.reduce((a, b) => a + b, 0) / sentencesPerParagraph.length
    : 0;

  let listOnlySections = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i].tag !== 'h2' && list[i].tag !== 'h3') continue;
    const section = [];
    for (let j = i + 1; j < list.length; j++) {
      if (list[j].tag === 'h2' || list[j].tag === 'h3') break;
      section.push(list[j]);
    }
    const hasProse = section.some((b) => b.tag === 'p' && wordsOf(b.text).length >= 25);
    const hasList = section.some((b) => b.tag === 'ul' || b.tag === 'ol');
    if (hasList && !hasProse) listOnlySections++;
  }

  const numbers = words.filter((w) => /\d/.test(w)).length;
  const lower = text.toLowerCase();
  const cta = CTA.test(lower.slice(Math.floor(lower.length * 0.65))) || CTA.test(lower.slice(-400));

  // --- conversion rules -----------------------------------------------------
  // Added 2026-10-29, after two measurements said the corpus was well-written
  // and still did not convert:
  //   · Mercor referrals: 159 applications started, 22 completed (13.8%).
  //     Nothing on the page had told the reader what the form would ask for.
  //   · 48 LinkedIn articles: median 91 impressions, and every title built as a
  //     command ("Unlock…", "Master…", "Ready to…") reached 0-25 people, while
  //     situational titles reached 59,563 and 3,726.
  // So: the offer must arrive in the first screen, the ask must appear mid-page
  // as well as at the end, the next step must be spelled out, and the title must
  // not be a promise.
  const opts = options || {};
  const offerType = String(opts.offerType || '').toLowerCase();
  const flat = words.join(' ').toLowerCase();
  const opening = flat.split(' ').slice(0, 110).join(' ');
  const midWindow = flat.split(' ').slice(Math.floor(words.length * 0.3), Math.floor(words.length * 0.75)).join(' ');
  const distinctNumbers = new Set(words.filter((w) => /\d/.test(w)).map((w) => w.replace(/[^0-9.]/g, ''))).size;
  const firstPerson = (text.match(/\b(?:we|our|us)\b/gi) || []).length;

  const norm = paragraphs.map((p) => p.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim());
  const seenParas = new Map();
  let duplicateParagraphs = 0;
  for (const p of norm) {
    if (wordsOf(p).length < 20) continue;
    const n = (seenParas.get(p) || 0) + 1;
    seenParas.set(p, n);
    if (n === 2) duplicateParagraphs++;
  }

  // The heading must use the verb this offer type actually asks for: a job page
  // that says "Before you get in touch" is a buyer template with the nouns
  // swapped, which is exactly the bug the widened engine shipped.
  const READINESS_VERB = {
    job: /before you (?:apply|start the application)/i,
    product: /before you (?:order|buy)/i,
    course: /before you (?:enrol|enroll|sign up)/i,
    service: /before you (?:get in touch|request|enquire|enquire|contact|send)/i,
    affiliate: /before you (?:click|sign up|open)/i,
    brand: /before you (?:get in touch|call|visit|contact|come in)/i,
  };
  const readinessRe = READINESS_VERB[offerType] || null;
  const readinessHeading = readinessRe ? readinessRe.test(text) : false;
  const requiresReadiness = Boolean(readinessRe);
  const offerInOpening = distinctNumbers > 0 || CTA.test(opening) || /\b(?:kes|usd|ksh|\$)\b/i.test(opening);
  const midAsk = CTA.test(midWindow);
  const weakTitle = weakTitleReason(opts.title);

  const conversion = {
    offerType: offerType || 'unspecified',
    offerInOpening, midAsk, readinessHeading, firstPerson, distinctNumbers,
    duplicateParagraphs, weakTitle, wordCount: words.length,
  };

  // --- hard rules -----------------------------------------------------------
  if (words.length < QUALITY_TARGETS.minWords) {
    const gap = QUALITY_TARGETS.minWords - words.length;
    add('thin-article', words.length + ' words (floor ' + QUALITY_TARGETS.minWords + ')',
      Math.min(25, 8 + Math.ceil(gap / 40)), words.length < 450);
  }
  if (paragraphs.length < QUALITY_TARGETS.minParagraphs) {
    add('few-paragraphs', paragraphs.length + ' substantial paragraphs (floor ' + QUALITY_TARGETS.minParagraphs + ')',
      Math.min(25, 6 + (QUALITY_TARGETS.minParagraphs - paragraphs.length) * 2), paragraphs.length < 4);
  }
  if (listWordRatio > QUALITY_TARGETS.maxListWordRatio) {
    add('list-heavy', Math.round(listWordRatio * 100) + '% of the words sit inside lists (ceiling ' +
      Math.round(QUALITY_TARGETS.maxListWordRatio * 100) + '%)',
      Math.min(22, Math.round((listWordRatio - QUALITY_TARGETS.maxListWordRatio) * 60)),
      listWordRatio > 0.55);
  }
  if (listOnlySections > QUALITY_TARGETS.maxListOnlySections) {
    add('bullet-sections', listOnlySections + ' sections are a heading plus a list and no prose (ceiling ' +
      QUALITY_TARGETS.maxListOnlySections + ')',
      Math.min(20, 6 * (listOnlySections - QUALITY_TARGETS.maxListOnlySections)), listOnlySections >= 4);
  }
  if (headings.length < QUALITY_TARGETS.minHeadings) {
    add('few-headings', headings.length + ' headings (floor ' + QUALITY_TARGETS.minHeadings + ')', 8, false);
  }
  if (paragraphs.length && avgSentencesPerParagraph < QUALITY_TARGETS.minAvgSentences) {
    add('flat-paragraphs',
      'paragraphs average ' + avgSentencesPerParagraph.toFixed(1) + ' sentences (floor ' +
      QUALITY_TARGETS.minAvgSentences + ')', 8, false);
  }
  // --- style rules ---------------------------------------------------------
  for (const [re, label, weight, cap] of BANNED) {
    const hits = (text.match(re) || []).length;
    if (!hits) continue;
    add('cliche', label + ' ×' + hits, Math.min(weight * hits, weight * cap), false);
  }
  if (paragraphs.length && stubby / paragraphs.length > 0.4) {
    add('stubby-paragraphs', stubby + ' of ' + paragraphs.length +
      ' paragraphs are under 18 words', 8, false);
  }
  if (!numbers) {
    add('no-specifics', 'no number, price, timeline or quantity anywhere on the page', 8, false);
  }
  if (!cta) {
    add('no-cta', 'no call to action in the closing third', 6, false);
  }

  // --- conversion verdict ---------------------------------------------------
  if (duplicateParagraphs) {
    add('duplicate-paragraph', duplicateParagraphs + ' paragraph(s) repeat word for word — the fallback composer shipped this on live pages', 12, true);
  }
  if (requiresReadiness && !readinessHeading) {
    const verb = offerType === 'job' ? 'apply' : offerType === 'product' ? 'order'
      : offerType === 'course' ? 'enrol' : offerType === 'affiliate' ? 'click' : 'get in touch';
    add('no-readiness', 'no "Before you ' + verb + '" section; the reader meets the requirements at the form instead of here', 10, false);
  }
  if (!offerInOpening) {
    add('no-offer-early', 'the first 110 words name no figure, price or next step', 8, false);
  }
  if (!midAsk) {
    add('no-mid-ask', 'the only ask is at the end; a reader who leaves at the halfway point is never invited to act', 6, false);
  }
  if (distinctNumbers < 3) {
    add('thin-specifics', distinctNumbers + ' distinct figures on the page (floor 3)', 6, false);
  }
  if (firstPerson < 1) {
    add('no-first-person', 'the business never speaks in first person, so the page reads like a directory listing', 4, false);
  }
  if (weakTitle) {
    add('weak-title', 'title is a promise rather than a situation: ' + weakTitle, 0, false);
  }

  const firstWords = paragraphs.slice(0, 6).map((p) => (wordsOf(p.text)[0] || '').toLowerCase());
  if (firstWords.length >= 4) {
    const counts = new Map();
    for (const w of firstWords) counts.set(w, (counts.get(w) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top / firstWords.length >= 0.5) {
      add('repetitive-openers', 'half the paragraphs start with the same word', 5, false);
    }
  }
  const headingTexts = headings.map((h) => h.text.toLowerCase());
  if (new Set(headingTexts).size < headingTexts.length) {
    add('duplicate-headings', 'two or more headings repeat', 5, false);
  }

  const penalty = issues.reduce((n, i) => n + i.weight, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const ok = score >= QUALITY_TARGETS.minScore && critical.length === 0;

  const summary = score + '/100, ' + words.length + ' words, ' + paragraphs.length + ' paragraphs, ' +
    headings.length + ' headings, lists ' + Math.round(listWordRatio * 100) + '%' +
    (critical.length ? ' — blocking: ' + critical.join(', ') : '');

  return {
    score, ok, critical, words: words.length, paragraphs: paragraphs.length,
    headings: headings.length, listWordRatio, listOnlySections,
    avgSentencesPerParagraph, numbers, cta, issues, summary, conversion,
  };
}

/**
 * The named failures, as instructions a model can act on. Capped so a repair
 * prompt stays a brief instead of a lecture.
 */
export function qualityBrief(analysis) {
  if (!analysis || !analysis.issues || !analysis.issues.length) return 'No structural problems detected.';
  return analysis.issues
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((i) => '- ' + i.detail + ' [' + i.code + ']')
    .join('\n');
}

/** One-line log/diagnostic string. */
export function describeQuality(analysis) {
  return analysis ? analysis.summary : 'not analysed';
}

