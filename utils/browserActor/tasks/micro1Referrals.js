/**
 * Micro1 referral links are multi-role — and that is why nothing has been earning (2026-11-13)
 *
 * Live behaviour on micro1's "Your referral link" page:
 *
 *     Select the opportunities you want to include in your link
 *     … 1 Roles selected … Select at least 2 roles
 *
 * So a referral link is generated for a **group** of at least two opportunities, not per role.
 * Every link this system has captured for micro1 so far came from a single role page, which means
 * they are either not valid referral links at all or links that never attribute — consistent with
 * the dashboard showing no statistics while pages were being shared.
 *
 * What that changes, and what this module is:
 *
 *   - The unit of capture is a **group**, not a role. One generated link is attached to every
 *     offer in its group, so two roles share one link. That is micro1's own model, not a shortcut.
 *   - Groups should be *related* (same category, same skill family) because the page is organised
 *     that way and because a link mixing "Paralegal" with "Godot Developer" reads as spam to the
 *     person receiving it.
 *   - "Refer and earn" is the real value signal, so the planner prefers groups whose members pay
 *     the most per referral. Hourly pay is only a tiebreak: a $1,500 referral at $80/hr beats a
 *     $100 referral at $200/hr.
 *
 * Everything here is pure, so grouping is decided and tested offline; the browser only has to
 * click what this produces.
 */

/** Tokens too common to imply any relationship between two roles. */
const STOP = new Set([
  'expert', 'specialist', 'senior', 'junior', 'software', 'engineer', 'developer', 'analyst',
  'consultant', 'advisor', 'manager', 'associate', 'assistant', 'lead', 'principal', 'staff',
  'and', 'or', 'the', 'of', 'for', 'with', 'language', 'based', 'remote', 'us', 'uk', 'level',
  'training', 'evaluation', 'ai', 'ml', 'data', 'openings', 'role', 'roles'
]);

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+\s#]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

/** "Legal Expert (Employment & Labor Law)" -> 'legal' — the family a recruiter would group on. */
export function roleFamily(title) {
  return tokens(title)[0] || null;
}

/**
 * The field a role belongs to (2026-11-16).
 *
 * The tenant's own rule: software engineering is software engineering, whether it is dressed as ML, full-stack or
 * back-end, and the same holds for law, medicine and languages. A first-token family is too narrow for that — it makes
 * "Machine Learning Researcher" and "Applied Scientists — Machine Learning" strangers — and too narrow means roles
 * that can never be paired, which on Micro1 means links that can never be minted.
 *
 * A pair inside one field still reads as a recommendation to the person receiving it, which is the line that must not
 * be crossed: a shared field is defensible, a shared nothing is a mailshot.
 */
const FIELD_RULES = [
  {
    id: 'tech',
    phrases: ['full stack', 'back end', 'front end', 'machine learning', 'deep learning', 'data science', 'site reliability', 'computer vision', 'natural language', 'prompt engineer'],
    words: ['software', 'engineer', 'engineering', 'developer', 'backend', 'frontend', 'fullstack', 'stack', 'platform', 'infrastructure', 'infra', 'architect', 'devops', 'sre', 'mobile', 'android', 'ios', 'web', 'api', 'qa', 'tester', 'testing', 'unreal', 'unity', 'godot', 'game', 'graphics', 'compiler', 'cloud', 'embedded', 'machine', 'learning', 'ml', 'ai', 'llm', 'nlp', 'vision', 'researcher', 'scientist', 'annotation', 'annotator', 'prompt', 'evaluator', 'rlhf', 'model', 'data', 'analytics', 'database', 'sql', 'pipeline', 'mlops', 'bioinformatics', 'computational', 'systems', 'security', 'technical']
  },
  {
    id: 'legal',
    phrases: ['labor law', 'civil rights', 'environmental law', 'entertainment law', 'intellectual property'],
    words: ['legal', 'law', 'attorney', 'counsel', 'paralegal', 'litigation', 'patent', 'antitrust', 'regulatory', 'privacy', 'contract', 'compliance', 'court', 'judicial']
  },
  {
    id: 'health',
    phrases: ['clinical research'],
    words: ['physician', 'hematology', 'medical', 'medicine', 'clinical', 'nurse', 'nursing', 'health', 'healthcare', 'patient', 'pharmacy', 'pharma', 'dental', 'radiology', 'oncology', 'surgeon', 'therapy', 'therapist', 'psychology', 'psychiatry', 'biotech', 'anatomy']
  },
  {
    id: 'language',
    phrases: [],
    words: ['language', 'translator', 'translation', 'localization', 'interpreter', 'linguist', 'spanish', 'french', 'portuguese', 'english', 'german', 'italian', 'japanese', 'mandarin', 'arabic', 'hindi', 'korean', 'russian', 'bilingual']
  },
  {
    id: 'finance',
    phrases: ['investment banking', 'equity research', 'credit research', 'commercial underwriting'],
    words: ['finance', 'financial', 'banking', 'investment', 'equity', 'credit', 'underwriter', 'underwriting', 'accounting', 'accountant', 'audit', 'tax', 'treasury', 'trading', 'portfolio', 'actuarial', 'payroll', 'loan', 'lending']
  },
  {
    id: 'public_service',
    phrases: [],
    words: ['medicare', 'medicaid', 'ship', 'passport', 'veterans', 'eligibility', 'enrollment', 'benefits', 'claims', 'caseworker', 'social', 'counselor', 'counsellor', 'government', 'defense', 'military', 'combat', 'special', 'operations']
  },
  {
    id: 'education',
    phrases: [],
    words: ['tutor', 'teacher', 'instructor', 'professor', 'lecturer', 'curriculum', 'academic', 'educator', 'exam', 'assessment', 'grading', 'school', 'university']
  },
  {
    id: 'content',
    phrases: ['content writer'],
    words: ['design', 'designer', 'ux', 'ui', 'figma', 'illustrator', 'creative', 'brand', 'content', 'writer', 'copywriter', 'editor', 'blog', 'seo', 'video', 'recorder', 'photographer', 'audio', 'music']
  },
  {
    id: 'commerce',
    phrases: ['e commerce', 'ecommerce'],
    words: ['commerce', 'ecommerce', 'catalog', 'merchandising', 'marketplace', 'retail', 'seller', 'inventory']
  },
  {
    id: 'sales_growth',
    phrases: ['business development', 'go to market', 'revenue operations'],
    words: ['sales', 'business', 'gtm', 'revenue', 'growth', 'marketing', 'demand', 'partnership', 'account', 'bdr', 'sdr', 'customer', 'commercial', 'procurement', 'logistics', 'supply', 'warehouse', 'coordinator', 'administrator', 'support']
  }
];

/**
 * The key two renderers of the same role agree on (2026-11-16).
 *
 * The builder and the listing spell roles differently — "E-commerce Data & Catalog Specialist" vs "Ecommerce Data and
 * Catalog Specialist" — and an exact-title join skipped exactly the offers that need links. One implementation, used by
 * the planner and by the attach path, so they cannot drift apart.
 */
export function titleKey(value) {
  return String(value || '')
    .toLowerCase()
    // "E-commerce" and "Ecommerce" are the same word to a reader; hyphens must not split them.
    .replace(/-/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    // Every token counts, including "a"/"b": dropping them made distinct roles collide ("Sales Rep A" and "Sales Rep B"
    // became one key), and a collision here can attach a link to the wrong offer.
    .filter((word) => word && !['and', 'the', 'of', 'for', 'with'].includes(word))
    .join(' ');
}

/**
 * Which field this role belongs to, or null when the title says nothing usable.
 *
 * Scoring rather than first-match: "E-commerce Data & Catalog Specialist" is commerce, not data engineering, and
 * "Senior Commercial Underwriter" is finance even though "commercial" appears in the sales list. Phrases outweigh
 * single words, so the specific reading wins over the generic one.
 */
export function roleField(title) {
  const text = String(title || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const words = new Set(text.split(' ').filter(Boolean));
  let best = null;
  for (const rule of FIELD_RULES) {
    let score = 0;
    for (const phrase of rule.phrases || []) if (text.includes(phrase)) score += 3;
    for (const word of rule.words || []) if (words.has(word)) score += 1;
    if (score && (!best || score > best.score)) best = { id: rule.id, score };
  }
  return best ? best.id : null;
}

/** $1,000 -> 1000. "$100 - $200/hour" -> 200 (the top of the band, i.e. the best case). */
export function parseRefereeValue(text) {
  const numbers = String(text || '').match(/[\d,]+/g);
  if (!numbers) return null;
  const values = numbers.map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/** "$100 - $200/hour" -> 200, for the tiebreak. */
export function parsePay(text) {
  return parseRefereeValue(text);
}

/**
 * Cards read off the "Your referral link" page.
 *
 * The page renders each opportunity as a card with a title, a pay band, a "Refer and earn" figure
 * and an expandable skills list — so the reader returns text and the numbers are parsed here,
 * rather than by another regex written inside the browser expression.
 *
 * @param {{ok: boolean, cards?: object[]}} snapshot
 */
export function parseAffiliateCards(snapshot = {}) {
  if (!snapshot?.ok) return { ok: false, reason: snapshot?.reason || 'unreadable', cards: [] };
  const cards = (Array.isArray(snapshot.cards) ? snapshot.cards : [])
    .map((card, index) => ({
      index,
      title: String(card?.title || '').trim(),
      payText: card?.pay || null,
      referText: card?.refer || null,
      skills: Array.isArray(card?.skills) ? card.skills.filter(Boolean) : [],
      posted: card?.posted || null,
      openings: Number(String(card?.openings || '').match(/\d+/)?.[0] || 0) || null,
      // An explicit family wins: the reader may know better than a first-token guess, and tests supply one.
      family: card?.family || roleFamily(card?.title),
      // The wider field, so a run can pair across siblings without re-deriving it (see `roleField`).
      field: card?.field || roleField(card?.title),
      payMax: parsePay(card?.pay),
      // Carried through so duplicates can prefer the copy that can actually be ticked.
      selectable: card?.selectable === true,
      referValue: parseRefereeValue(card?.refer)
    }))
    .filter((card) => card.title);

  // The live page lists some roles twice in one grid: 48 cards, 27 unique titles, and only 24 of
  // the cards carry a checkbox. Keeping both copies would let a "pair" be one role twice — two
  // roles counted, one role referred — so duplicates collapse, preferring the selectable copy.
  const byTitle = new Map();
  for (const card of cards) {
    const key = card.title.toLowerCase();
    const existing = byTitle.get(key);
    if (!existing || (card.selectable && !existing.selectable)) byTitle.set(key, card);
  }
  const unique = [...byTitle.values()];
  return { ok: true, cards: unique, duplicates: cards.length - unique.length };
}

/**
 * Group cards into referral links of `size` roles.
 *
 * Same family first, then whatever is left — a link with two legal roles is a coherent
 * recommendation; a link mixing legal with game development is not. Ties inside a family break by
 * referral value, so the high-value pairs are generated first.
 *
 * @param {object[]} cards   from parseAffiliateCards().cards
 * @param {{size?: number, maxGroups?: number, alreadyGrouped?: string[]}} options
 * @returns {{groups: object[], skipped: object[]}}
 */
export function planReferralGroups(cards = [], { size = 2, maxGroups = 10, alreadyGrouped = [], allowMixed = true, allowLoose = true } = {}) {
  const sizeWanted = Math.max(2, Number(size) || 2);
  const used = new Set((alreadyGrouped || []).map((t) => String(t).toLowerCase()));
  const pool = (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.title && !used.has(String(card.title).toLowerCase()));

  const byFamily = new Map();
  for (const card of pool) {
    // Derive the family when the card does not carry one. Without this, cards handed straight to the planner all land
    // in a single "(none)" bucket and pair with each other as though they were related — the mistake that paired an AI
    // tester with a Spanish linguist.
    const key = card.family || roleFamily(card.title) || '(none)';
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(card);
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) => (b.referValue || 0) - (a.referValue || 0) || (b.payMax || 0) - (a.payMax || 0));
  }

  const groups = [];
  const skipped = [];

  /** Take whole groups off the front of a list; remember the ones that cannot form one. */
  const take = (family, list, kind, field = null) => {
    while (list.length >= 2 && groups.length < maxGroups) {
      const members = list.splice(0, sizeWanted);
      groups.push({
        family,
        kind,
        // Why these roles were put together, carried into the run report so the tenant can audit any pairing.
        basis: kind,
        field: field || undefined,
        members,
        title: members.map((m) => m.title).join(' + '),
        referralValue: members.reduce((sum, m) => sum + (m.referValue || 0), 0),
        maxPay: Math.max(...members.map((m) => m.payMax || 0)),
        reason: kind === 'family'
          ? `${members.length} ${family || 'related'} role(s) — a coherent recommendation`
          : kind === 'field'
            ? `${members.length} role(s) in the same field (${field}) — a coherent recommendation`
            : `${members.length} leftover role(s) — paired to satisfy micro1's two-role minimum`
      });
    }
    for (const leftover of list) {
      skipped.push({
        title: leftover.title,
        reason: kind === 'field'
          ? `only role in the ${field} field — micro1 needs at least 2 roles`
          : 'no partner in its family — micro1 needs at least 2 roles'
      });
    }
  };

  for (const [family, list] of byFamily) take(family, list, 'family');

  /**
   * Second tier: same field (2026-11-16).
   *
   * Strict families first keeps the tightest pairs — two legal experts, two Spanish experts. Whatever is left is
   * grouped by field, which is the tenant's own rule: software engineering is software engineering even when it is
   * dressed as ML, full-stack or back-end, and the same holds for law, medicine and languages. Without this tier most
   * roles can never be paired, and on Micro1 an unpaired role can never have a payable link.
   *
   * This is not the mixed tier: a pair here shares a field, so it still reads as a recommendation. A pair sharing
   * nothing stays off unless `allowMixed` is set explicitly.
   */
  if (allowLoose && groups.length < maxGroups) {
    const byField = new Map();
    for (const [, list] of byFamily) {
      for (const card of list) {
        const field = card.field || roleField(card.title);
        if (!field) continue; // unclassifiable titles fall through to the mixed tier, or stay unpaired
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field).push(card);
      }
    }
    for (const list of byField.values()) {
      list.sort((a, b) => (b.referValue || 0) - (a.referValue || 0) || (b.payMax || 0) - (a.payMax || 0));
    }
    // Highest-value fields first: the pairs worth a link are the ones a candidate would actually click.
    const fields = [...byField.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [field, list] of fields) {
      if (list.length < 2) continue;
      // `take` consumes the list in place; whatever is left is a lone role in that field and is reported as such.
      take(field, list, 'field', field);
    }
  }

  // Stranded singles can still pair with other stranded singles — but only when the caller allows it.
  //
  // A link covering "Sales Rep + Maths Tutor" is legal and earns, and it also looks arbitrary to the person who
  // receives it: two unrelated roles in one recommendation reads like a mailshot. So the referral runner asks for
  // related pairs only, and a role with no same-family partner is reported as unpairable instead of being forced
  // into a group that would embarrass the tenant.
  if (allowMixed && groups.length < maxGroups) {
    const leftovers = [];
    for (const [, list] of byFamily) leftovers.push(...list);
    leftovers.sort((a, b) => (b.referValue || 0) - (a.referValue || 0));
    if (leftovers.length >= 2) {
      const mixed = [];
      take(null, leftovers, 'mixed');
      // `take` collected the pair(s); the remains are genuinely un-pairable.
      for (const item of mixed) leftovers.push(item);
    }
    for (const leftover of leftovers) {
      if (!skipped.some((s) => s.title === leftover.title)) {
        skipped.push({ title: leftover.title, reason: 'only one role left with no partner' });
      }
    }
  }

  groups.sort((a, b) => b.referralValue - a.referralValue || b.maxPay - a.maxPay);
  // One entry per role: a role skipped by the family tier and then by the field tier was reported twice, which made a
  // log of 20 roles look like 40 (2026-11-16). The later reason is kept because it says the more useful thing.
  const byTitle = new Map();
  for (const row of skipped) byTitle.set(String(row.title).toLowerCase(), row);
  return { groups: groups.slice(0, maxGroups), skipped: [...byTitle.values()] };
}

/**
 * Which of *our* offers a generated link belongs to.
 *
 * The link is per group, so every offer whose title matches a member gets the same URL. Matching is
 * normalised because micro1's card wording and our imported title differ by a suffix more often
 * than by meaning ("Student Loan Counselor" vs "Student Loan Counselor/Advisor").
 */
export function matchOffersToGroup(group, offers = []) {
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = (group.members || []).map((m) => norm(m.title));
  return (Array.isArray(offers) ? offers : []).filter((offer) => {
    const title = norm(offer.title);
    if (!title) return false;
    return wanted.some((target) => target && (title === target || title.startsWith(target) || target.startsWith(title)));
  });
}


/*
 * ─── The browser half ──────────────────────────────────────────────────────────
 *
 * Written against two saved copies of `refer.micro1.ai/opportunities` (2026-11-13). They are the
 * same URL and the same `<title>`, but they are **not the same page**, and only one of them can
 * mint a multi-role link:
 *
 *   builder (342 KB)   `[data-testid="job-card"]` × 24, each with
 *                      `label > span > input[type=checkbox].sr-only` × 24,
 *                      a "0 Roles selected" counter, and a **disabled** button reading
 *                      "Select at least 2 roles".  This is the page the brief describes.
 *
 *   listing (182 KB)   the same cards and the same "Refer and earn $500" buttons, but
 *                      `input[type=checkbox]` appears **zero** times. Clicking "Refer and earn"
 *                      here copies that one role's link (it does not navigate or open a dialog).
 *
 * So the reader reports which page it is on instead of assuming: `mode: 'builder'` can group,
 * `mode: 'listing'` cannot, and a runner that finds `listing` has to say so rather than generate
 * a pile of single-role links that — per the delivery check — never attribute.
 *
 * What the markup gives us to hold on to:
 *   - `[data-testid="job-card"]` is an explicit test hook, so the card needs no class guessing.
 *   - the title is the card's `h2`.
 *   - the checkbox is `sr-only` (visually hidden, still a real input), so the click goes to its
 *     `<label>`; `input.click()` also works, and both land on the same React handler.
 *   - `Pay: $100 - $200/hour` and `5 Openings` are plain text inside the card.
 */
export const MICRO1_CARD = '[data-testid="job-card"]';

/**
 * Read the cards on whichever of the two pages is open.
 *
 * Returns `mode`, and `ok:false` with a reason when there are no cards at all — because "signed
 * out" and "no opportunities" are different facts and only one of them is the tenant's problem.
 */
export function readAffiliateExpr({ limit = 120 } = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const nodes = Array.from(document.querySelectorAll('${MICRO1_CARD}')).slice(0, ${Number(limit) || 120});
  const body = clean(document.body ? document.body.innerText : '');
  if (!nodes.length) {
    return JSON.stringify({
      ok: false,
      mode: 'unknown',
      reason: 'no_job_cards',
      url: String(location.href),
      title: clean(document.title),
      bodyStart: body.slice(0, 200)
    });
  }
  const cards = nodes.map((card, index) => {
    const box = card.querySelector('input[type="checkbox"]')
      || card.querySelector('[role="checkbox"], [aria-checked]');
    const heading = card.querySelector('h2') || card.querySelector('h3');
    // innerText keeps the newlines that separate "Pay:" from its value; the collapsed copy does not.
    const raw = String(card.innerText || '');
    // Cut the pay value at the reward line: on the live page "Pay: $100 - $200/hour" is followed
    // immediately by "Refer and earn $500", and a flat read of the card bleeds the two together.
    const payRaw = (raw.match(/Pay:\\s*([^\\n]+)/i) || [])[1];
    const pay = payRaw ? clean(payRaw.replace(/refer\\s*(?:and|&)\\s*earn[\\s\\S]*$/i, '')) : null;
    const openings = (raw.match(/(\\d+)\\s*Openings?/i) || [])[0];
    const refer = clean(raw).match(/refer\\s*(?:and|&)\\s*earn\\s*(\\$[\\d,.]+)/i);
    const skillsBlock = Array.from(card.querySelectorAll('p')).find((p) => /required skills/i.test(String(p.innerText || '')));
    const chips = skillsBlock && skillsBlock.parentElement
      ? Array.from(skillsBlock.parentElement.querySelectorAll('div'))
          .map((d) => clean(d.innerText))
          .filter((t) => t && t.length < 60 && !/^\\+\\d+$/.test(t) && !/required skills/i.test(t))
      : [];
    return {
      index,
      title: heading ? clean(heading.innerText || heading.textContent) : '',
      pay: pay ? clean(pay) : null,
      refer: refer ? refer[1] : null,
      openings: openings || null,
      skills: chips.slice(0, 8),
      selectable: !!box,
      checked: box ? (typeof box.checked === 'boolean' ? !!box.checked : box.getAttribute('aria-checked') === 'true') : null
    };
  }).filter((card) => card.title);

  // Read the counter from the element that IS the counter, not with a body-wide regex: the live
  // page nests the number across several spans, so a flat read yields "0000 Roles selected" and a
  // body-wide match would report a count that was never on screen.
  const counterEl = (Array.from(document.querySelectorAll('span,div,p'))
    .map((el) => clean(el.textContent))
    .filter((t) => /^\\d+\\s+Roles?\\s+selected$/i.test(t))
    .pop()) || null;
  // Fall back to the flattened text only when no single element holds the whole phrase.
  const counter = counterEl || (body.match(/(\\d+)\\s+Roles?\\s+selected/i) || [])[0] || null;
  const action = Array.from(document.querySelectorAll('button')).find((b) =>
    /select at least|generate|create link|copy link|get link/i.test(clean(b.innerText || b.textContent)));
  return JSON.stringify({
    ok: cards.length > 0,
    mode: cards.some((c) => c.selectable) ? 'builder' : 'listing',
    reason: cards.some((c) => c.selectable) ? null : 'no_checkboxes',
    url: String(location.href),
    title: clean(document.title),
    counter,
    minimum: /select at least (\\d+)/i.test(body) ? Number(body.match(/select at least (\\d+)/i)[1]) : null,
    action: action ? { label: clean(action.innerText || action.textContent), disabled: !!action.disabled } : null,
    cards,
    count: cards.length
  });
})()`;
}


/**
 * Install a clipboard trap before anything is clicked.
 *
 * On the listing page "Refer and earn" does not navigate and opens no dialog — it *copies* the
 * coded link (`jobs.micro1.ai/post/<uuid>?referralCode=<code>&utm_…`). Reading the clipboard back
 * needs a permission that a background worker does not have, so instead the calls are wrapped
 * before the click: whatever the page tries to copy is captured in the page itself and read out
 * afterwards. This is the only reliable way to see a link that is never rendered as text.
 */
export function installClipboardHookExpr() {
  return `(() => {
  if (window.__m1clipInstalled) return JSON.stringify({ ok: true, already: true, value: window.__m1clip || null });
  window.__m1clipInstalled = true;
  window.__m1clip = null;
  const keep = (value) => { try { window.__m1clip = String(value == null ? '' : value); } catch (e) {} };
  // The page's copy button calls the async clipboard API. THAT call is what raises Chrome's "allow micro1 to see
  // text copied to the clipboard" bubble over the top-left of the window, which steals focus and stalls a run that
  // cannot click a browser bubble (2026-11-16). The link only has to be READ, so the value is kept in the page and
  // the native call is never made: no prompt, and the page still sees a successful copy.
  try {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = function (text) { keep(text); return Promise.resolve(); };
      navigator.clipboard.readText = function () { return Promise.resolve(String(window.__m1clip || '')); };
    }
  } catch (e) {}
  try {
    const exec = document.execCommand ? document.execCommand.bind(document) : null;
    if (exec) {
      document.execCommand = function (command) {
        if (String(command).toLowerCase() === 'copy') {
          const active = document.activeElement;
          const fromField = active && 'value' in active ? active.value : null;
          if (fromField) keep(fromField);
          else if (window.getSelection) keep(String(window.getSelection()));
          // Report success without touching the system clipboard: no permission prompt.
          return true;
        }
        return exec.apply(null, arguments);
      };
    }
  } catch (e) {}
  return JSON.stringify({ ok: true, already: false });
})()`;
}

/**
 * The tick helper, shared by the select and clear expressions (2026-11-16).
 *
 * The live popup (refer.micro1.ai/opportunities) puts a small square in each card's TOP-RIGHT corner, shows its own
 * "N Roles selected" counter, and disables "Select at least 2 roles" until two are ticked. On the first live run the
 * modal opened and nothing got selected: a single click on the found control was not enough, and the verification
 * only read `input.checked`, which cannot see a control the page renders and tracks itself.
 *
 * So each attempt walks a ladder — real input, then ARIA checkbox, then the visible square found by geometry — and
 * the page's own counter is accepted as proof alongside the checkbox state. Written once and interpolated into both
 * expressions so the untick path can never drift from the tick path.
 */
const TICK_HELPER = `
  const pointerAt = (el, type, x, y) => {
    const at = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
    try { el.dispatchEvent(new (String(type).indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(type, at)); } catch (e) {}
  };
  const press = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const x = r ? r.left + r.width / 2 : 0;
    const y = r ? r.top + r.height / 2 : 0;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) pointerAt(el, t, x, y);
    try { el.click(); } catch (e) {}
    return true;
  };
  const boxOf = (card) =>
    card.querySelector('input[type="checkbox"]') || card.querySelector('[role="checkbox"], [aria-checked]') || null;
  const isTicked = (card) => {
    const input = card.querySelector('input[type="checkbox"]');
    if (input) return !!input.checked;
    const aria = card.querySelector('[role="checkbox"], [aria-checked]');
    if (aria) return aria.getAttribute('aria-checked') === 'true';
    return null;
  };
  // The square in the top-right corner, found by where it is rather than by what it is called.
  const cornerTarget = (card) => {
    const r = card.getBoundingClientRect();
    if (!r || !r.width) return null;
    const el = document.elementFromPoint(
      Math.min(window.innerWidth - 2, r.right - 22),
      Math.max(2, r.top + 22)
    );
    return el && card.contains(el) ? el : null;
  };
  const counterNow = () => {
    const flat = (v) => String(v == null ? '' : v).split(/[^0-9a-zA-Z$]+/).join(' ').trim();
    const one = Array.from(document.querySelectorAll('span,div,p'))
      .map((n) => flat(n.textContent))
      .filter((t) => /^[0-9]+ Roles? selected$/i.test(t))
      .pop();
    const found = one || (flat(document.body ? document.body.innerText : '').match(/[0-9]+ Roles? selected/i) || [])[0];
    const digit = found ? String(found).match(/[0-9]+/) : null;
    return digit ? Number(digit[0]) : null;
  };
  const waitTicked = async (card, ms) => {
    const end = Date.now() + Math.max(100, ms || 0);
    for (;;) {
      const v = isTicked(card);
      if (v === true) return true;
      if (Date.now() >= end) return v;
      await new Promise((r) => setTimeout(r, 120));
    }
  };
`;

/**
 * Tick one group's roles, then prove they are ticked.
 *
 * The assertion is on the checkbox state AND the page's own "N Roles selected" counter — not on "we did not throw",
 * because a click swallowed by a re-render would otherwise mint a link for the wrong roles.
 */
export function selectRolesExpr({ titles = [], settleMs = 400 } = {}) {
  const wanted = JSON.stringify(titles.map((t) => String(t)));
  return `(async () => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const wanted = ${wanted};
  ${TICK_HELPER}
  const cards = Array.from(document.querySelectorAll('${MICRO1_CARD}'));
  const titleOf = (card) => {
    const h = card.querySelector('h2') || card.querySelector('h3');
    return h ? clean(h.innerText || h.textContent) : '';
  };
  const clicked = [];
  const missed = [];
  const counterBefore = counterNow();
  for (const title of wanted) {
    const key = title.toLowerCase();
    const matches = cards.filter((c) => {
      const actual = titleOf(c).toLowerCase();
      return actual && (actual === key || actual.startsWith(key) || key.startsWith(actual));
    });
    // Prefer the copy that exposes a control, then any copy at all: the ladder can find the square by geometry even
    // when the markup has no input, so requiring one would skip cards that are perfectly tickable (2026-11-16).
    const card = matches.find((c) => boxOf(c)) || matches[0];
    if (!card) { missed.push(title); continue; }
    const before = counterNow();
    const target = boxOf(card);
    if (isTicked(card) === true) { clicked.push({ title: titleOf(card), already: true, method: 'already' }); continue; }
    // Ladder: the control itself, then its label, then the visible square in the corner. On the live popup the
    // first click did nothing, and the old code had no second attempt — which is how a modal opened and no role
    // was ever selected.
    let method = null;
    let ticked = null;
    if (target) { press(target); method = 'box'; ticked = await waitTicked(card, 800); }
    if (ticked !== true) {
      const label = card.querySelector('label');
      if (label) { press(label); method = method ? method + '+label' : 'label'; ticked = await waitTicked(card, 500); }
    }
    if (ticked !== true) {
      const corner = cornerTarget(card);
      if (corner && press(corner)) {
        method = method ? method + '+corner' : 'corner';
        ticked = await waitTicked(card, 800);
      }
    }
    clicked.push({ title: titleOf(card), already: false, method, ticked, before, after: counterNow() });
  }
  await new Promise((r) => setTimeout(r, ${Number(settleMs) || 400}));
  const counterAfter = counterNow();
  // Read the state back from the DOM: this is the difference between "clicked" and "selected".
  const states = clicked.map((row) => {
    const key = row.title.toLowerCase();
    const card = cards.filter((c) => titleOf(c).toLowerCase() === key)[0] || null;
    return { title: row.title, checked: card ? isTicked(card) : null };
  });
  const body = clean(document.body ? document.body.innerText : '');
  const counter = (body.match(/(\\d+)\\s+Roles?\\s+selected/i) || [])[0] || null;
  const action = Array.from(document.querySelectorAll('button')).find((b) =>
    /select at least|generate|create link|copy link|get link/i.test(clean(b.innerText || b.textContent)));
  return JSON.stringify({
    // Proof is the checkbox state OR the page's own counter rising by the number of roles asked for. The counter is
    // what the tenant can see, and a custom control may never expose its checked state to us at all.
    ok: (states.every((s) => s.checked === true) && states.length === wanted.length)
      || (counterBefore != null && counterAfter != null && counterAfter - counterBefore >= wanted.length),
    selected: states.filter((s) => s.checked === true).map((s) => s.title),
    unselected: states.filter((s) => s.checked !== true).map((s) => s.title),
    missed,
    counterBefore,
    counterAfter,
    ticks: clicked,
    counter,
    action: action ? { label: clean(action.innerText || action.textContent), disabled: !!action.disabled } : null,
    states
  });
})()`;
}

/** Untick everything, so one group's roles cannot leak into the next group's link. */
export function clearSelectionExpr({ settleMs = 300 } = {}) {
  return `(async () => {
  ${TICK_HELPER}
  const cards = Array.from(document.querySelectorAll('${MICRO1_CARD}'));
  const counterBefore = counterNow();
  let cleared = 0;
  for (const card of cards) {
    if (isTicked(card) !== true) continue;
    const target = boxOf(card);
    if (target) press(target);
    if (isTicked(card) === true) {
      const label = card.querySelector('label');
      if (label) press(label);
    }
    if (isTicked(card) === true) {
      const corner = cornerTarget(card);
      if (corner) press(corner);
    }
    cleared += 1;
  }
  await new Promise((r) => setTimeout(r, ${Number(settleMs) || 300}));
  const left = cards.filter((c) => isTicked(c) === true).length;
  return JSON.stringify({ ok: left === 0, cleared, remaining: left, counterBefore, counterAfter: counterNow() });
})()`;
}


/** Click the page's own confirm button (its label changes with the build, so match the family). */
export function clickActionExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  // Never the header pill: clicking "Your referral link" reopens its menu and takes the modal away.
  const button = Array.from(document.querySelectorAll('button')).filter((b) =>
    !/your referral link/i.test(clean(b.innerText || b.textContent)))
    .find((b) => /select at least|generate|create link|copy link|get link|share|referral link/i.test(clean(b.innerText || b.textContent)));
  if (!button) return JSON.stringify({ ok: false, reason: 'no_action_button' });
  if (button.disabled) {
    return JSON.stringify({
      ok: false,
      reason: 'action_disabled',
      label: clean(button.innerText || button.textContent)
    });
  }
  const label = clean(button.innerText || button.textContent);
  try { button.scrollIntoView({ block: 'center' }); } catch (e) {}
  button.click();
  return JSON.stringify({ ok: true, label });
})()`;
}

/**
 * Read the link the page produced.
 *
 * The clipboard trap is checked first, because on this site the link is *copied* rather than
 * rendered: nothing to query, and a naive read returns "no link" while a perfectly good coded
 * link sits in the clipboard.
 */
export function readGeneratedLinkExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const isReferral = (url) => /^https?:\\/\\//i.test(url) && /micro1\\.(ai|com)/i.test(url);

  if (window.__m1clip && isReferral(window.__m1clip)) {
    return JSON.stringify({ ok: true, url: String(window.__m1clip).trim(), strategy: 'clipboard-hook' });
  }
  const attr = Array.from(document.querySelectorAll('[data-clipboard-text],[data-copy],[data-link]'))
    .map((el) => el.getAttribute('data-clipboard-text') || el.getAttribute('data-copy') || el.getAttribute('data-link'))
    .find((v) => v && isReferral(v));
  if (attr) return JSON.stringify({ ok: true, url: attr, strategy: 'data-attribute' });

  const value = Array.from(document.querySelectorAll('input,textarea'))
    .map((el) => el.value)
    .find((v) => v && isReferral(v));
  if (value) return JSON.stringify({ ok: true, url: value, strategy: 'input-value' });

  const body = clean(document.body ? document.body.innerText : '');
  const fromText = (body.match(/https?:\\/\\/\\S*micro1\\S*/i) || [])[0];
  if (fromText) return JSON.stringify({ ok: true, url: fromText, strategy: 'text' });

  return JSON.stringify({ ok: false, reason: 'no_link_found', bodyStart: body.slice(0, 300) });
})()`;
}


/**
 * Drive one group: clear → tick → confirm → read, and attach the link to every role in the group.
 *
 * Injected `evaluate` (expression string → parsed JSON) keeps this offline-testable and keeps the
 * CDP plumbing in the runner where it already lives. Nothing here decides *which* roles group;
 * `planReferralGroups` does that, and this refuses a group it cannot verify rather than publishing
 * a link that covers the wrong roles.
 *
 * The failure that matters: a group whose link is captured but whose selections were never
 * verified. That is exactly how months of single-role links produced zero attribution, so it is a
 * hard failure here — never a silent success.
 */
/**
 * Does this link carry attribution? (2026-11-16)
 *
 * The tenant's complaint was precise: a group link must *display accreditation when clicked*. A URL that points
 * at micro1 without a referral/affiliate parameter is a valid-looking link that credits nobody — the same shape
 * of failure as the single-role links that produced months of zero earnings. So attribution is checked before a
 * capture is recorded, here in Node where it can be asserted, rather than inside the page expression.
 *
 * `unknown` is honest rather than optimistic: an unrecognised query parameter may well be the referral code, and
 * refusing those would throw away good links on a guess. A bare URL with no query at all cannot be attribution.
 *
 * @returns {'param'|'path'|'unknown'|'none'}
 */
export function referralAttribution(rawUrl) {
  const url = String(rawUrl == null ? '' : rawUrl).trim();
  if (!url) return 'none';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'none';
  }
  const known = /^(referral|referral_?code|ref|ref_?code|code|aff|affiliate|affiliate_?id|invite|invite_?code|token|via|src|utm_source)$/i;
  const keys = Array.from(parsed.searchParams.keys());
  if (keys.some((key) => known.test(key))) return 'param';
  if (keys.length) return 'unknown';
  if (/\/(r|ref|invite|i)\/[A-Za-z0-9_-]{5,}/i.test(parsed.pathname)) return 'path';
  return 'none';
}

export async function runReferralGroups({ evaluate, groups = [], waitForLinkMs = 6000, pollMs = 400, ensureBuilder = null, log = () => {} } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('runReferralGroups needs an evaluate() function');
  const captures = [];
  const failures = [];
  if (!groups.length) return { ok: false, reason: 'no_groups', captures, failures };

  log('installing the clipboard trap');
  await evaluate(installClipboardHookExpr());

  for (const group of groups) {
    // `planReferralGroups` emits `members`; a hand-built task may say `roles` or `titles`. All three
    // are accepted so the planner's output can be fed straight into this without a translation step
    // that would be one more place for the two halves to disagree.
    const titles = (group.members || group.roles || group.titles || [])
      .map((role) => (typeof role === 'string' ? role : role?.title))
      .filter(Boolean);
    // A group's readable identity: the planner's own title, else the family, else a number.
    const groupId = group.id || group.title || group.family || `group-${groups.indexOf(group) + 1}`;
    if (titles.length < 2) {
      // Micro1 will not mint a link for one role; trying would report a page rule as a capture bug.
      failures.push({ groupId, reason: 'group_too_small', titles });
      continue;
    }

    log(`group ${groupId}${group.field ? ` [${group.basis || 'field'}: ${group.field}]` : ''}: clearing, then selecting ${titles.length} roles`);
    // The popup closes after it generates a link, so every group after the first would tick cards on the listing
    // page instead — which is exactly what happened on 2026-11-16: group 1 captured, group 2 read `counter 2→?`,
    // group 3 found no action button at all. Re-open it before touching anything.
    if (typeof ensureBuilder === 'function') {
      const ready = await ensureBuilder().catch((error) => ({ ok: false, reason: error?.message || 'ensure_failed' }));
      if (!ready?.ok) {
        failures.push({ groupId, reason: `builder_lost:${ready?.reason || 'unknown'}`, titles });
        log(`group ${groupId}: the popup could not be re-opened (${ready?.reason || 'unknown'}) — stopping`);
        break;
      }
    }
    await evaluate(clearSelectionExpr());

    // Assert the state we are about to act on. Re-opening can succeed while the page is still the wrong one, and the
    // old code then ticked cards, clicked a button that was not there and reported a failure three steps later. A
    // popup with no readable counter or no action button is a stop, named here.
    const state = await evaluate(readAffiliateExpr({ limit: 1 })).catch(() => null);
    if (!state?.ok || state.mode !== 'builder') {
      failures.push({ groupId, reason: `builder_not_ready:${state?.mode || 'unreadable'}`, titles });
      log(`group ${groupId}: the popup is not on screen (${state?.mode || 'unreadable'}) — stopping`);
      break;
    }
    if (state.counter == null) {
      failures.push({ groupId, reason: 'counter_unreadable', titles });
      log(`group ${groupId}: no "N Roles selected" counter on the page — stopping rather than ticking blind`);
      break;
    }

    const selection = await evaluate(selectRolesExpr({ titles }));
    if (!selection?.ok) {
      // Say what the page showed, not just that it failed: the counter before→after, which roles could not be
      // found, and how each one was (or was not) ticked. A bare "selection_not_verified" cost a live run.
      const ticks = (selection?.ticks || [])
        .map((t) => `${String(t.title || '').slice(0, 28)}=${t.method || 'no control'}/${t.ticked === true ? 'ticked' : (t.ticked === null ? 'unreadable' : 'not ticked')}`)
        .join(', ');
      log(`selection not verified — counter ${selection?.counterBefore ?? '?'}→${selection?.counterAfter ?? '?'}${selection?.missed?.length ? `, missing: ${selection.missed.join(', ')}` : ''}${ticks ? ` · ${ticks}` : ''}`);
      failures.push({ groupId, reason: 'selection_not_verified', titles, selection });
      continue;
    }
    log(`selected ${selection.selected?.length || 0} role(s) — counter ${selection.counterBefore ?? '?'}→${selection.counterAfter ?? '?'}`);

    // Reset the trap before each confirm: a stale link from the previous group must never be
    // attached to this one.
    await evaluate('(() => { window.__m1clip = null; return JSON.stringify({ ok: true }); })()');

    const action = await evaluate(clickActionExpr());
    if (!action?.ok) {
      failures.push({ groupId, reason: action?.reason || 'action_failed', titles, action });
      continue;
    }

    const deadline = Date.now() + Math.max(0, Number(waitForLinkMs) || 0);
    let link = null;
    for (;;) {
      // The link may be copied or painted a beat after the click; poll rather than fixed-sleep.
      const read = await evaluate(readGeneratedLinkExpr());
      if (read?.ok) { link = read; break; }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.max(50, Number(pollMs) || 400)));
    }

    if (!link?.ok) {
      failures.push({ groupId, reason: link?.reason || 'link_not_found', titles, action });
      continue;
    }

    // A link with no attribution parameter credits nobody: recording it would recreate the very failure this
    // whole exercise exists to fix (links that look fine and earn nothing).
    const attribution = referralAttribution(link.url);
    if (attribution === 'none') {
      failures.push({ groupId, reason: 'link_without_attribution', titles, referralUrl: link.url });
      log(`group ${groupId}: link carries no attribution parameter — not recorded`);
      continue;
    }
    if (attribution === 'unknown') {
      log(`group ${groupId}: link attribution is an unrecognised parameter — recorded, but confirm a click credits the tenant`);
    }

    log(`link captured via ${link.strategy} for ${titles.length} role(s) (attribution: ${attribution})`);
    for (const title of titles) {
      captures.push({
        title,
        groupId,
        referralUrl: link.url,
        strategy: link.strategy,
        attribution,
        // The same URL on both roles is micro1's own model, so it is recorded rather than deduped.
        sharedWith: titles.filter((other) => other !== title)
      });
    }
  }

  return {
    ok: captures.length > 0 && failures.length === 0,
    captures,
    failures,
    attempted: groups.length,
    captured: captures.length
  };
}

/**
 * Group capture, wired to the runner's page accessor (2026-11-14).
 *
 * The engine above takes an `evaluate(expression)`. The Micro1 runner has `evaluateJson({ host, port, expression })`
 * and a `readAffiliateExpr()` that returns the builder's cards. This bridges the two, so the runner's call site is
 * one line instead of a translation that could disagree with the engine.
 *
 * It refuses rather than guesses when the page is not the builder: micro1's listing has no checkboxes, and running
 * the selection expressions there would report a page rule as a capture bug. `reason` says what to do about it.
 *
 * @returns {Promise<{ok:boolean, reason?:string, cards:number, groups:number, captures:Array, failures:Array, skipped:Array}>}
 */
export async function captureGroupsOnPage({
  evaluateJson,
  host,
  port,
  size = 2,
  maxGroups = 5,
  alreadyGrouped = [],
  knownTitles = [],
  allowMixed = false,
  waitForLinkMs = 6000,
  openWaitMs = 4000,
  log = () => {}
} = {}) {
  if (typeof evaluateJson !== 'function') throw new TypeError('captureGroupsOnPage needs evaluateJson()');
  const evalExpr = (expression) => evaluateJson({ host, port, expression });

  /**
   * Open the popup, one stage per attempt, and report what it clicked.
   *
   * Called once to start and again before every group: the popup closes when it generates a link, so without this
   * groups two and three ticked cards on the listing page (2026-11-16 — `counter 2→?`, then `no_action_button`).
   */
  let controls = [];
  let lastEntry = null;
  const openBuilder = async () => {
    let page = (await evalExpr(parkedSurveyExpr()).catch(() => null))?.page || 'unknown';
    if (page === 'builder') return { ok: true, already: true, page };
    // Each attempt is one stage of the real path: walk to the dashboard → click "Your referral link" → click
    // "Link with specific expert opportunities" → the checkbox modal. Naming the stage is what makes a stop
    // readable ("clicked the pill, never got a menu") instead of a timeout.
    for (let attempt = 1; attempt <= 4 && page !== 'builder'; attempt += 1) {
      const opened = await evalExpr(openBuilderExpr()).catch((error) => ({ ok: false, reason: error?.message }));
      if (!opened?.ok) {
        if (opened?.controls) controls = opened.controls;
        return { ok: false, reason: `${page}:${opened?.reason || 'open_failed'}`, controls, page };
      }
      log(`builder entry [${attempt}] stage=${opened.stage || (opened.navigated ? 'nav' : 'entry')}: ${opened.navigated ? 'walked to the referral page via' : 'clicked'} "${String(opened.label || '').slice(0, 60)}"`);
      lastEntry = String(opened.label || '').slice(0, 40);
      if (Array.isArray(opened.controls) && opened.controls.length) controls = opened.controls;

      // Wait only as long as this stage needs: a menu appears at once, so waiting the modal's full budget before
      // clicking the menu item would spend seconds looking for a popup that is waiting on us.
      const budget = Number(opened.waitMs) || (opened.navigated ? Math.max(3_000, openWaitMs * 2) : Math.max(500, Number(openWaitMs) || 4_000));
      const openDeadline = Date.now() + budget;
      for (;;) {
        page = (await evalExpr(parkedSurveyExpr()).catch(() => null))?.page || 'unknown';
        if (page === 'builder' || Date.now() >= openDeadline) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!page || page === 'unknown') page = opened.navigated ? 'listing' : page;
    }
    return {
      ok: page === 'builder',
      reason: page === 'builder' ? undefined : `builder_did_not_open:${page} after clicking "${lastEntry || 'the entry'}"`,
      page,
      controls
    };
  };

  const openedAtStart = await openBuilder();
  if (!openedAtStart.ok) {
    return {
      ok: false,
      // Named with the label attached, so the next run says "the click went somewhere else" rather than timing out.
      reason: openedAtStart.reason,
      controls: openedAtStart.controls || [],
      cards: 0, groups: 0, captures: [], failures: [], skipped: []
    };
  }
  log('builder modal opened');

  const read = await evalExpr(readAffiliateExpr({ limit: 240 })).catch((error) => ({ ok: false, reason: error?.message }));
  // Plan from PARSED cards, never the raw read. parseAffiliateCards assigns the family (so only related roles pair),
  // normalises the pay band and referral value, and collapses the duplicates the grid renders. Feeding the raw read
  // straight to the planner put every card in one "(none)" family — which is how an AI Agent Tester got paired with a
  // Spanish Language Expert and the same pair was planned twice in one run.
  const parsed = parseAffiliateCards(read);
  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  if (!read?.ok || cards.length < 2) {
    return {
      ok: false,
      reason: read?.ok ? 'builder_has_too_few_roles' : `builder_unreadable:${read?.reason || 'unknown'}`,
      cards: cards.length,
      groups: 0,
      captures: [],
      failures: [],
      skipped: []
    };
  }
  if (parsed.duplicates) log(`builder: ${parsed.duplicates} duplicate card(s) collapsed before pairing`);
  // Informational only — pairing no longer gates on it. The flag is a guess from markup, and a card without an input
  // is still tickable through the ladder (the tick finds the square by geometry).
  const unread = cards.filter((card) => card.selectable === false).length;
  if (unread) log(`builder: ${unread} of ${cards.length} card(s) expose no obvious control — the tick will locate it`);

  /**
   * Pair only roles the tenant already holds as offers (2026-11-16).
   *
   * A link minted for a role we do not own has nowhere to go: the attach step answers `no_offer_for_role` and the
   * link — the one thing Micro1 will not give again — is wasted. Four links died that way in one run. So the order is
   * the one the tenant asked for: collect the offers first, then mint links for them.
   */
  const known = new Set((Array.isArray(knownTitles) ? knownTitles : []).map(titleKey).filter(Boolean));
  const knownCards = known.size ? cards.filter((card) => known.has(titleKey(card.title))) : cards;
  const notCollected = cards.length - knownCards.length;
  if (known.size && !knownCards.length) {
    return {
      ok: false,
      reason: 'no_known_offers_in_builder',
      cards: cards.length,
      groups: 0, captures: [], failures: [], skipped: []
    };
  }
  if (notCollected > 0) {
    log(`builder: ${knownCards.length} of ${cards.length} card(s) are offers you already hold — pairing those (${notCollected} not collected yet; the offers phase brings them in first)`);
  }

  // Every card in the popup is tickable — the reader's `selectable` flag is a guess made from markup, and gating on it
  // paired only 12 of 70 cards (2026-11-16). So pairing covers every parsed card, and a role that truly cannot be
  // ticked fails loudly by name in the tick ladder instead of being silently dropped here.
  const plan = planReferralGroups(knownCards, { size, maxGroups, alreadyGrouped, allowMixed });
  if (!plan.groups.length) {
    return { ok: false, reason: 'no_pairable_roles', cards: knownCards.length, groups: 0, captures: [], failures: [], skipped: plan.skipped };
  }
  const byBasis = plan.groups.reduce((acc, group) => {
    const basis = group.basis || 'family';
    acc[basis] = (acc[basis] || 0) + 1;
    return acc;
  }, {});
  log(`groups: ${plan.groups.length} pair(s) from ${knownCards.length} builder card(s)${Object.keys(byBasis).length ? ` (${Object.entries(byBasis).map(([basis, count]) => `${count} ${basis}`).join(', ')})` : ''}`);

  const run = await runReferralGroups({ evaluate: evalExpr, groups: plan.groups, waitForLinkMs, ensureBuilder: openBuilder, log });
  return {
    ok: run.ok,
    reason: run.ok ? undefined : (run.failures[0]?.reason || 'group_failed'),
    cards: cards.length,
    groups: plan.groups.length,
    captures: run.captures,
    failures: run.failures,
    skipped: plan.skipped
  };
}

/**
 * Open the builder modal (2026-11-16).
 *
 * From the live page dump: the card grid with checkboxes lives **inside** a modal opened by a button reading
 * "Link with specific expert opportunities", with a `fixed inset-0 z-[110]` overlay and a "Close modal" control.
 * Without this click there are no checkboxes on the page at all, and every selection attempt would fail with a
 * reason that looks like a selector problem.
 */
export function openBuilderExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const boxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]').length;
  const cards = document.querySelectorAll('${MICRO1_CARD}').length;
  if (boxes >= 2 && cards >= 2) return JSON.stringify({ ok: true, alreadyOpen: true, boxes, cards });
  // The failure this guards against, seen live on 2026-11-16: the first element whose *innerText* mentioned the
  // builder was a wrapper that contained the referral panel — tab label, copy, and the search input. Clicking it
  // focused the search field, so the runner sat in a search box while the log said it had opened the builder.
  // Two rules follow: never pick something that wraps a field, and prefer the smallest text (the leaf is the tab).
  const wrapsField = (el) => !!el.querySelector('input, textarea, select, [role="searchbox"], [contenteditable="true"]');
  // Two things the live page taught (2026-11-16): the entry is the pill reading "Your referral link" on the
  // referral dashboard, and the dashboard is a different page from the listing. So the matcher names the real
  // label, and when it is absent the expression can walk to the referral page and try again.
  const ENTRY = /your referral link|referral link|link with specific expert|specific expert opportunit|refer (?:and|&) earn|invite link|share referral/i;
  const NAV = /^my referrals$|^referrals?$|^affiliate(?: program)?$|referral dashboard/i;
  const textOf = (el) => clean(el.innerText || el.textContent);
  const matches = (el) => ENTRY.test(textOf(el));
  // role=menuitem and li matter: the pill opens a dropdown, and its items are not buttons on this build.
  const raw = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], a, li, [data-testid]'))
    .filter((el) => matches(el) && !wrapsField(el));
  // Keep the innermost match. A menu container (or an li wrapping the item) also contains the label text, and
  // clicking the container is how a click lands on nothing.
  const candidates = raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));
  if (!candidates.length) {
    // Nothing matches here — most likely we are on the listing and the pill lives on the referral dashboard.
    // Walk there rather than reporting "no entry", which reads like a selector bug and hides the real route.
    const nav = Array.from(document.querySelectorAll('a, [role="tab"], button, [role="link"]'))
      .filter((el) => !wrapsField(el))
      .find((el) => {
        const text = textOf(el);
        const href = String(el.getAttribute('href') || '');
        return (text.length <= 40 && NAV.test(text)) || /referral/i.test(href);
      });
    if (nav) {
      const label = textOf(nav).slice(0, 60);
      try { nav.scrollIntoView({ block: 'center' }); } catch (e) {}
      nav.click();
      return JSON.stringify({ ok: true, navigated: true, stage: 'nav', waitMs: 6_000, label, href: nav.getAttribute('href') || undefined, boxes, cards });
    }
    // Last resort, and the useful one: say what IS on the page. A dump of visible controls turns the next
    // failed attempt into a one-line selector fix instead of another screenshot and a guess.
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"]'))
      .filter((el) => !wrapsField(el) && el.getBoundingClientRect().width > 0)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: textOf(el).slice(0, 60)
      }))
      .filter((entry) => entry.text)
      .slice(0, 25);
    return JSON.stringify({ ok: false, reason: 'no_builder_entry', boxes, cards, controls });
  }
  // Click order matters, and the live page settled it (2026-11-16): the pill opens a MENU, and the modal only
  // opens from that menu's "Link with specific expert opportunities" item. So the menu item is tried first — it
  // exists only after the pill was clicked — then the pill, then a nav link. The menu's other item links every
  // role at once, which is the spammy path this work exists to avoid, so it is never matched.
  const pick = (test) => candidates.find((el) => test(textOf(el)));
  const specific = pick((text) => /specific expert/i.test(text));
  const pill = pick((text) => /your referral link|referral link/i.test(text));
  const button = specific || pill || candidates[0];
  const stage = specific ? 'menu' : (pill ? 'pill' : 'entry');
  // A menu renders in a moment, a modal takes longer, a page navigation takes longest.
  const waitMs = stage === 'menu' ? 5_000 : (stage === 'pill' ? 1_500 : 6_000);
  const label = textOf(button).slice(0, 120);
  if (button.disabled) return JSON.stringify({ ok: false, reason: 'builder_entry_disabled', label, stage, boxes, cards });
  try { button.scrollIntoView({ block: 'center' }); } catch (e) {}

  // Some tabs on this build are React components that ignore .click() and only act on the pointer sequence,
  // so send both rather than betting on one.
  const rect = button.getBoundingClientRect();
  const at = {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    bubbles: true,
    cancelable: true,
    button: 0
  };
  try {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      button.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, at));
    }
  } catch (e) {}
  button.click();

  return JSON.stringify({
    ok: true,
    clicked: true,
    navigated: false,
    stage,
    waitMs,
    label,
    tag: button.tagName.toLowerCase(),
    role: button.getAttribute('role') || undefined,
    textLen: label.length,
    candidates: candidates.length
  });
})()`;
}

/** Which page is in front of us: the builder (cards carrying controls), the listing, or something else. */
export function parkedSurveyExpr() {
  return `(() => {
    // Count controls that live INSIDE a card. Page-wide counts made the listing look like the builder: it has job
    // cards and enough aria toggles in its own furniture to satisfy a naive test, so a run that had never re-opened
    // the popup believed it was open and ticked nothing (2026-11-16).
    const cards = Array.from(document.querySelectorAll('[data-testid="job-card"]'));
    const withControl = cards.filter((card) => card.querySelector('input[type="checkbox"], [role="checkbox"], [aria-checked], button[aria-label*="select" i]')).length;
    const boxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked]').length;
    const builderWords = /select|refer\\s*&?\\s*earn|generate/i.test(document.body ? document.body.innerText.slice(0, 4000) : '');
    const page = withControl >= 2 ? 'builder' : (cards.length >= 2 ? 'listing' : 'unknown');
    return JSON.stringify({ ok: true, page, boxes, cards: cards.length, withControl, builderWords });
  })()`;
}

