#!/usr/bin/env node

/**
 * Offline test for the page share card (utils/postShare.js).
 *
 * The Share button on Writer's Flow → Blogger hands the tenant a link plus a
 * hook/summary/excerpt they forward on WhatsApp. Production failures this
 * protects against (2026-10-22, live host):
 *   1) Every AI provider was out of quota at once, so an "AI summary" would have
 *      come back empty — the card must still be usable, composed from the page.
 *   2) A model that ignores "max 140 characters" or wraps its JSON in fences must
 *      not break the screen or ship a 900-character hook.
 *   3) Nine pages of one offer must not produce nine identical cards; a tenant
 *      sharing "our latest article" twice is spam.
 *
 * Runs entirely in-process — no keys, no database, no network.
 *
 * Usage: npm run test:share-card
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import chalk from "chalk";
import { getContentJourney } from "../utils/contentJourney.js";
import { composeAnglePost } from "../utils/angleFallback.js";
import {
  deriveShareCard,
  parseShareCard,
  buildSharePrompt,
  htmlToText,
  clip,
  firstSentences,
  sentences,
  hashtagsFor,
  leadParagraph,
  sections,
  SHARE_LIMITS,
} from "../utils/postShare.js";

const logInfo = (msg) => console.log(chalk.blue(`i ${msg}`));
const logPass = (msg) => console.log(chalk.green(`+ ${msg}`));
const logFail = (msg) => console.log(chalk.red(`x ${msg}`));

const results = [];
function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const line = `${name}${detail ? " — " + detail : ""}`;
  if (status === "PASS") logPass(line);
  else logFail(line);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record("PASS", name, detail || "");
  } catch (e) {
    record("FAIL", name, e.message);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const OFFER = {
  title: "Kassangas Music Shop",
  slug: "kassangas-music-shop",
  offer_type: "service",
  compensation_max: 1500,
  compensation_currency: "KES",
  location_text: "Nairobi",
  skills: ["Sound engineering", "Event planning"],
  description: "Studio recording, mixing and live sound for artists and events in Nairobi.",
};

const journey = getContentJourney(OFFER);
const PAGES = journey.map((angle) => ({
  angle: angle.angle,
  title: angle.title,
  content: composeAnglePost(OFFER, angle),
}));

// Regression 1: a dry AI tier must still yield a usable card.
logInfo(`Journey: ${PAGES.length} pages for ${OFFER.title}`);
await check("every page yields a complete card", async () => {
  for (const page of PAGES) {
    const card = deriveShareCard({ title: page.title, angle: page.angle, content: page.content, offer: OFFER });
    assert(card.hook, `${page.angle}: empty hook`);
    assert(card.summary, `${page.angle}: empty summary`);
    assert(card.excerpt, `${page.angle}: empty excerpt`);
    assert(card.mode === "template", `${page.angle}: mode should be template, got ${card.mode}`);
    assert(card.hook.length <= SHARE_LIMITS.hook, `${page.angle}: hook ${card.hook.length} > ${SHARE_LIMITS.hook}`);
    assert(card.summary.length <= SHARE_LIMITS.summary, `${page.angle}: summary too long`);
    assert(card.excerpt.length <= SHARE_LIMITS.excerpt, `${page.angle}: excerpt too long`);
  }
  return `${PAGES.length} cards, all fields within limits`;
});

// Regression 3: nine pages, nine different hooks.
await check("no two pages share a hook", async () => {
  const hooks = PAGES.map((p) => deriveShareCard({ title: p.title, angle: p.angle, content: p.content, offer: OFFER }).hook);
  const unique = new Set(hooks);
  assert(unique.size === hooks.length, `${hooks.length} pages produced only ${unique.size} distinct hooks`);
  return `${unique.size} distinct hooks`;
});

// The card is rendered into HTML, so it must be text, never markup.
await check("cards contain no HTML or placeholders", async () => {
  for (const page of PAGES) {
    const card = deriveShareCard({ title: page.title, angle: page.angle, content: page.content, offer: OFFER });
    const blob = [card.hook, card.summary, card.excerpt, ...card.hashtags].join(" ");
    assert(!/<[a-z/][^>]*>/i.test(blob), `${page.angle}: markup leaked into the card`);
    const leak = blob.match(/.{0,30}(?:undefined|null|NaN|\[object Object\]).{0,30}/);
    assert(!leak, `${page.angle}: placeholder leaked: ${leak && leak[0]}`);
  }
  return "plain text only, no undefined/null/NaN";
});

// A brand-new tenant may publish an offer with nothing but a title.
await check("survives a page with no body text", async () => {
  const card = deriveShareCard({ title: "Bare Offer", angle: "awareness", content: "", offer: null });
  assert(card.hook === "Bare Offer", `expected the title as hook, got "${card.hook}"`);
  assert(card.summary && card.excerpt, "empty card for a title-only page");
  const empty = deriveShareCard({});
  assert(empty.hook === "" && empty.summary === "", "empty input should return an empty card, not junk");
  return "title-only page still shareable";
});

await check("htmlToText strips tags, scripts and entities", async () => {
  const text = htmlToText('<h2>Cost</h2><p>Tom &amp; Jerry <script>alert(1)</script>pay <b>KES</b>&nbsp;1,500.</p>');
  assert(!/<|>/.test(text), `tags survived: ${text}`);
  assert(!/alert/.test(text), "script body survived");
  assert(text.includes("Tom & Jerry"), `entity not decoded: ${text}`);
  assert(text.includes("KES 1,500"), `spacing lost: ${text}`);
  return text.slice(0, 60);
});

await check("sentence splitting keeps decimals", async () => {
  const parts = sentences("Pay KES 1,500.00 today. Then book. Done!");
  assert(parts.length === 3, `expected 3 sentences, got ${parts.length}: ${JSON.stringify(parts)}`);
  assert(parts[0].includes("1,500.00"), "decimal was split");
  return parts.join(" | ");
});

await check("clip and firstSentences respect the cap", async () => {
  const long = "word ".repeat(200).trim();
  assert(clip(long, 140).length <= 141, `clip overran: ${clip(long, 140).length}`);
  assert(clip(long, 140).endsWith("…"), "clipped text should be marked with an ellipsis");
  assert(clip("short line", 140) === "short line", "short text was modified");
  assert(firstSentences(long, 100).length <= 100, "firstSentences overran");
  return "caps hold at the boundary";
});

await check("hashtags are usable tags", async () => {
  const tags = hashtagsFor(["Essential Skills for Life Sciences Research Expert (Python)", "consideration", "service"]);
  assert(tags.length > 0 && tags.length <= SHARE_LIMITS.hashtags, `bad tag count: ${tags.length}`);
  for (const tag of tags) {
    assert(/^#[A-Za-z][A-Za-z0-9]*$/.test(tag), `unusable tag: ${tag}`);
    assert(!/^#(The|For|How|Guide|Article)$/.test(tag), `filler word leaked into tags: ${tag}`);
  }
  return tags.join(" ");
});


// Determinism matters: the same page must not produce a different card on every
// open (the route caches it, and the tenant compares what they copied).
await check("composition is deterministic", async () => {
  const first = deriveShareCard({ title: PAGES[0].title, angle: PAGES[0].angle, content: PAGES[0].content, offer: OFFER });
  const second = deriveShareCard({ title: PAGES[0].title, angle: PAGES[0].angle, content: PAGES[0].content, offer: OFFER });
  assert(JSON.stringify(first) === JSON.stringify(second), "two calls returned different cards");
  return "same input, same card";
});

await check("lead and sections read the page structure", async () => {
  const html = "<p>Opening line that is long enough to count as the lead paragraph of this page.</p><h2>What it costs</h2><p>KES 1,500 covers the session. Extras are quoted separately.</p>";
  assert(/Opening line/.test(leadParagraph(html)), "lead paragraph not found");
  const secs = sections(html);
  assert(secs.length === 1 && secs[0].heading === "What it costs", `bad sections: ${JSON.stringify(secs)}`);
  return `${secs.length} section parsed`;
});

// Regression 2: tolerant parsing of what a model actually returns.
await check("parses a bare JSON card", async () => {
  const card = parseShareCard('{"hook":"H","summary":"S","excerpt":"E"}');
  assert(card && card.hook === "H" && card.excerpt === "E", `parse failed: ${JSON.stringify(card)}`);
  return "bare JSON";
});

await check("parses fenced and prose-wrapped JSON", async () => {
  const fenced = parseShareCard('```json\n{"hook":"H","summary":"S","excerpt":"E"}\n```');
  assert(fenced && fenced.hook === "H", "fenced JSON not parsed");
  const prose = parseShareCard('Here is the card:\n{"hook":"H2","summary":"S2","excerpt":"E2"}\nHope it helps.');
  assert(prose && prose.hook === "H2", "prose-wrapped JSON not parsed");
  return "fences and prose tolerated";
});

await check("rejects unusable model output", async () => {
  assert(parseShareCard("I cannot help with that.") === null, "prose accepted as a card");
  assert(parseShareCard('{"hook":"H"}') === null, "incomplete card accepted");
  assert(parseShareCard("") === null, "empty string accepted");
  assert(parseShareCard(null) === null, "null accepted");
  return "prose, partial JSON and empty replies rejected";
});

await check("clips an overlong model hook instead of trusting it", async () => {
  const card = parseShareCard(JSON.stringify({ hook: "H ".repeat(300), summary: "S", excerpt: "E" }));
  assert(card && card.hook.length <= SHARE_LIMITS.hook + 1, `hook not clipped: ${card.hook.length}`);
  return `${card.hook.length} chars`;
});

await check("prompt carries the page and the honesty rules", async () => {
  const prompt = buildSharePrompt({ title: "T", angle: "cost", content: PAGES[0].content, offer: OFFER });
  assert(/ONLY minified JSON/.test(prompt), "prompt does not constrain the reply format");
  assert(/Never invent/.test(prompt), "prompt lost the no-invention rule");
  assert(prompt.includes("KES 1500"), "prompt lost the offer price");
  assert(prompt.length < 6000, `prompt too long: ${prompt.length}`);
  return `${prompt.length} chars`;
});

const failed = results.filter((r) => r.status === "FAIL").length;
console.log("");
if (failed) {
  console.log(chalk.red(`Summary: ${failed} failed, ${results.length - failed} passed`));
  process.exit(1);
}
console.log(chalk.green(`Summary: ${results.length} passed, 0 failed`));
process.exit(0);

