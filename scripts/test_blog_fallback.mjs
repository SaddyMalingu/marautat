#!/usr/bin/env node

/**
 * Offline test for the deterministic writer fallback (utils/angleFallback.js)
 * and the per-angle slugs it publishes under (utils/contentJourney.js).
 *
 * Production failures this protects against (2026-10-22, live host):
 *   1) Every AI provider was out of quota at once — OpenRouter 429 on the
 *      remaining free slugs, Gemini daily quota spent, HuggingFace 402 no
 *      credits — so a 9-angle journey wrote nothing and the tenant got a 502.
 *   2) Two templates shared each angle, slugged `<offer>-<angle>`, so the second
 *      post overwrote the first: "9 of 9 angles" was really 5 pages.
 *
 * Runs entirely in-process — no keys, no database, no network.
 *
 * Usage: npm run test:blog-fallback
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import chalk from "chalk";
import { getContentJourney } from "../utils/contentJourney.js";
import { composeAnglePost, FALLBACK_CTA } from "../utils/angleFallback.js";

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

const words = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
const journey = getContentJourney(OFFER);

logInfo(`Journey: ${journey.length} angles for ${OFFER.title}`);

// Regression 2: unique URLs per angle. Before the fix this was 5.
await check("every angle publishes under its own slug", async () => {
  const slugs = journey.map((j) => j.slug);
  const unique = new Set(slugs);
  assert(journey.length === 9, `expected 9 angles, got ${journey.length}`);
  assert(unique.size === journey.length,
    `expected ${journey.length} unique slugs, got ${unique.size}: ${slugs.join(", ")}`);
  assert(!slugs.some((s) => /undefined|null|NaN/.test(s)), `bad slug generated: ${slugs.join(", ")}`);
  return `${unique.size} unique slugs (${slugs[0]} … ${slugs[slugs.length - 1]})`;
});

// The journey was job-only; buyer copy must not have replaced the career copy
// that the legacy Mercor catalog depends on. The titles themselves changed on
// 2026-10-29 (the LinkedIn export showed command-shaped titles reaching 1-25
// people), so this now pins the *intent* of each page, not its old wording.
await check("job offers keep the career journey", async () => {
  const job = { ...OFFER, offer_type: "job", title: "ML Engineer", slug: "ml-engineer" };
  const titles = getContentJourney(job).map((x) => x.title).join(" | ");
  assert(/Earns\?|Hourly Rate Really Means|Pay/.test(titles), `job journey lost its pay post: ${titles}`);
  assert(/Five Years/.test(titles), `job journey lost its progression post: ${titles}`);
  assert(/Applying for ML Engineer Work/.test(titles), `job journey lost its hiring post: ${titles}`);
  assert(/Before you|Assessment Asks For/.test(titles), `job journey lost its preparation post: ${titles}`);
  assert(getContentJourney(job).length === 9, "job journey length changed");
  return "career titles intact for offer_type=job";
});

// A service listing must not be told to build a portfolio or find remote work
// (live 2026-10-22: /blog carried "How to Get Hired as a Kassangas Music Shop").
await check("service offers get buyer copy, not career copy", async () => {
  const titles = journey.map((x) => x.title).join(" | ");
  for (const careerOnly of ["Salary Guide", "Career Roadmap", "Portfolio That Gets You Hired", "Remote ", "Five Years", "Applying for"]) {
    assert(!titles.includes(careerOnly), `service journey still says "${careerOnly}": ${titles}`);
  }
  assert(titles.includes("What It Costs"), `service journey lost its pricing post: ${titles}`);
  const prompts = journey.map((x) => x.prompt).join(" ").toLowerCase();
  assert(!/getting hired as|becoming a|remote .* jobs/.test(prompts), "service prompts still ask for career content");
  return "buyer titles and prompts on a service offer";
});

// Regression 1: a composed journey is always writable.
await check("composes a substantial post for every angle", async () => {
  const short = [];
  for (const item of journey) {
    const html = composeAnglePost(OFFER, item);
    const w = words(html);
    if (w.length < 220) short.push(`${item.slug}=${w.length}w`);
    assert(/<h2>/.test(html), `${item.angle} has no <h2>`);
    assert(/<ul>|<\/p>/.test(html), `${item.angle} has no body blocks`);
    assert(html.includes("Kassangas Music Shop"), `${item.angle} does not name the offer`);
  }
  assert(short.length === 0, `too thin: ${short.join(", ")}`);
  return `9 posts, ${Math.min(...journey.map((j) => words(composeAnglePost(OFFER, j)).length))}+ words each`;
});

// Duplicate copy would be discounted by search engines and look lazy in a demo.
// Mirrors blogManager.isDuplicate: word-set overlap above 0.5 counts as a dupe.
await check("angle copy is not near-duplicate", async () => {
  const sets = journey.map((j) => new Set(words(composeAnglePost(OFFER, j)).map((w) => w.toLowerCase())));
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const inter = [...sets[a]].filter((x) => sets[b].has(x)).length;
      const ratio = inter / Math.max(sets[a].size, sets[b].size);
      assert(ratio <= 0.5, `${journey[a].slug} vs ${journey[b].slug} overlap ${ratio.toFixed(2)}`);
    }
  }
  return "no pair exceeds 0.5 word overlap";
});

// A brand-new tenant may publish an offer with nothing but a title.
await check("survives an offer with only a title", async () => {
  for (const item of journey) {
    const html = composeAnglePost({ title: "Bare Offer" }, item);
    const leak = html.match(/.{0,40}(?:undefined|null|NaN).{0,40}/);
    assert(!leak, `${item.angle} leaked a placeholder: ${leak && leak[0]}`);
    assert(words(html).length >= 150, `${item.angle} too thin without offer details`);
  }
  return "no placeholders, still 150+ words";
});

// Tenant-supplied strings land inside HTML, so they must not be able to break
// out of the markup or inject a tag.
await check("offer fields are HTML-escaped", async () => {
  const html = composeAnglePost({ title: 'Tom & Jerry <script>alert(1)</script>', offer_type: "product" }, journey[0]);
  assert(!/<script>/i.test(html), "raw <script> reached the post body");
  assert(html.includes("Tom &amp; Jerry &lt;script&gt;"), "expected escaped title in the body");
  return "title escaped, no tag injection";
});

// Markdown artefacts are the most visible AI tell in a published post.
await check("no markdown artefacts in composed copy", async () => {
  for (const item of journey) {
    const html = composeAnglePost(OFFER, item);
    assert(!/\*\*|__|^#{1,6} /m.test(html), `${item.angle} contains markdown`);
  }
  return "no **, __ or # headings";
});

// The price is the buyer's first question and must never be invented.
await check("price is quoted only when the offer states one", async () => {
  const withPrice = journey.map((j) => composeAnglePost(OFFER, j)).join(" ");
  const withoutPrice = journey.map((j) => composeAnglePost({ title: "No Price Ltd" }, j)).join(" ");
  assert(withPrice.includes("KES 1,500") || withPrice.includes("KES 1500"), "listed price missing from copy");
  assert(!/KES/.test(withoutPrice), "invented a currency for an offer without a price");
  return "KES 1,500 quoted, nothing invented without it";
});

// Every CTA type the platform supports must resolve to a readable label.
await check("cta labels resolve for every offer type", async () => {
  for (const type of Object.keys(FALLBACK_CTA)) {
    const html = composeAnglePost({ title: "T", offer_type: type }, journey[6]);
    assert(html.includes(FALLBACK_CTA[type]), `${type} CTA not used`);
  }
  const html = composeAnglePost({ title: "T", offer_type: "service", cta_label: "Book a session" }, journey[6]);
  assert(html.includes("Book a session"), "explicit cta_label ignored");
  return `${Object.keys(FALLBACK_CTA).length} types + explicit cta_label`;
});


const failed = results.filter((r) => r.status === "FAIL").length;
console.log("");
if (failed) {
  console.log(chalk.red(`Summary: ${failed} failed, ${results.length - failed} passed`));
  process.exit(1);
}
console.log(chalk.green(`Summary: ${results.length} passed, 0 failed`));
process.exit(0);
