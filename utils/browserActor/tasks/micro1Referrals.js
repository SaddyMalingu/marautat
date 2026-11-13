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
      family: roleFamily(card?.title),
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
export function planReferralGroups(cards = [], { size = 2, maxGroups = 10, alreadyGrouped = [] } = {}) {
  const sizeWanted = Math.max(2, Number(size) || 2);
  const used = new Set((alreadyGrouped || []).map((t) => String(t).toLowerCase()));
  const pool = (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.title && !used.has(String(card.title).toLowerCase()));

  const byFamily = new Map();
  for (const card of pool) {
    const key = card.family || '(none)';
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key).push(card);
  }
  for (const list of byFamily.values()) {
    list.sort((a, b) => (b.referValue || 0) - (a.referValue || 0) || (b.payMax || 0) - (a.payMax || 0));
  }

  const groups = [];
  const skipped = [];

  /** Take whole groups off the front of a list; remember the ones that cannot form one. */
  const take = (family, list, kind) => {
    while (list.length >= 2 && groups.length < maxGroups) {
      const members = list.splice(0, sizeWanted);
      groups.push({
        family,
        kind,
        members,
        title: members.map((m) => m.title).join(' + '),
        referralValue: members.reduce((sum, m) => sum + (m.referValue || 0), 0),
        maxPay: Math.max(...members.map((m) => m.payMax || 0)),
        // Carried into the run report so the portal can say *why* these were paired.
        reason: kind === 'family'
          ? `${members.length} ${family || 'related'} role(s) — a coherent recommendation`
          : `${members.length} leftover role(s) — paired to satisfy micro1's two-role minimum`
      });
    }
    for (const leftover of list) {
      skipped.push({ title: leftover.title, reason: 'no partner in its family — micro1 needs at least 2 roles' });
    }
  };

  for (const [family, list] of byFamily) take(family, list, 'family');

  // Stranded singles can still pair with other stranded singles: better a mixed link than an offer
  // that can never earn.
  if (groups.length < maxGroups) {
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
  return { groups: groups.slice(0, maxGroups), skipped };
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
    const box = card.querySelector('input[type="checkbox"]');
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
      checked: box ? !!box.checked : null
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
  if (window.__m1clipInstalled) return JSON.stringify({ ok: true, already: true });
  window.__m1clipInstalled = true;
  window.__m1clip = null;
  const keep = (value) => { try { window.__m1clip = String(value == null ? '' : value); } catch (e) {} };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (text) { keep(text); return original(text); };
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
        }
        return exec.apply(null, arguments);
      };
    }
  } catch (e) {}
  return JSON.stringify({ ok: true, already: false });
})()`;
}

/**
 * Tick one group's roles, then prove they are ticked.
 *
 * The checkbox is `sr-only`, so the click goes to the wrapping `<label>`; `input.click()` is the
 * fallback. Either way the assertion afterwards is on `input.checked` and the page's own
 * "N Roles selected" counter — not on "we did not throw", because a click swallowed by a
 * re-render would otherwise mint a link for the wrong roles.
 */
export function selectRolesExpr({ titles = [], settleMs = 400 } = {}) {
  const wanted = JSON.stringify(titles.map((t) => String(t)));
  return `(async () => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const wanted = ${wanted};
  const cards = Array.from(document.querySelectorAll('${MICRO1_CARD}'));
  const titleOf = (card) => {
    const h = card.querySelector('h2') || card.querySelector('h3');
    return h ? clean(h.innerText || h.textContent) : '';
  };
  const clicked = [];
  const missed = [];
  for (const title of wanted) {
    const key = title.toLowerCase();
    const matches = cards.filter((c) => {
      const actual = titleOf(c).toLowerCase();
      return actual && (actual === key || actual.startsWith(key) || key.startsWith(actual));
    });
    // The live page lists some roles twice in one grid and only one copy carries a checkbox.
    // Ticking the copy without one looks like a click and selects nothing, so prefer the boxed one.
    const card = matches.filter((c) => c.querySelector('input[type="checkbox"]'))[0] || matches[0];
    if (!card) { missed.push(title); continue; }
    const box = card.querySelector('input[type="checkbox"]');
    if (!box) { missed.push(title); continue; }
    if (box.checked) { clicked.push({ title: titleOf(card), already: true }); continue; }
    const label = card.querySelector('label');
    try { card.scrollIntoView({ block: 'center' }); } catch (e) {}
    if (label) label.click(); else box.click();
    clicked.push({ title: titleOf(card), already: false });
  }
  await new Promise((r) => setTimeout(r, ${Number(settleMs) || 400}));
  // Read the state back from the DOM: this is the difference between "clicked" and "selected".
  const states = clicked.map((row) => {
    const key = row.title.toLowerCase();
    const pool = cards.filter((c) => titleOf(c).toLowerCase() === key);
    // Same preference as the click: the boxed copy is the one whose state means anything.
    const card = pool.filter((c) => c.querySelector('input[type="checkbox"]'))[0] || pool[0];
    const box = card ? card.querySelector('input[type="checkbox"]') : null;
    return { title: row.title, checked: box ? !!box.checked : null };
  });
  const body = clean(document.body ? document.body.innerText : '');
  const counter = (body.match(/(\\d+)\\s+Roles?\\s+selected/i) || [])[0] || null;
  const action = Array.from(document.querySelectorAll('button')).find((b) =>
    /select at least|generate|create link|copy link|get link/i.test(clean(b.innerText || b.textContent)));
  return JSON.stringify({
    ok: states.every((s) => s.checked === true) && states.length === wanted.length,
    selected: states.filter((s) => s.checked === true).map((s) => s.title),
    unselected: states.filter((s) => s.checked !== true).map((s) => s.title),
    missed,
    counter,
    action: action ? { label: clean(action.innerText || action.textContent), disabled: !!action.disabled } : null,
    states
  });
})()`;
}

/** Untick everything, so one group's roles cannot leak into the next group's link. */
export function clearSelectionExpr({ settleMs = 300 } = {}) {
  return `(async () => {
  const cards = Array.from(document.querySelectorAll('${MICRO1_CARD}'));
  let cleared = 0;
  for (const card of cards) {
    const box = card.querySelector('input[type="checkbox"]');
    if (!box || !box.checked) continue;
    const label = card.querySelector('label');
    if (label) label.click(); else box.click();
    cleared += 1;
  }
  await new Promise((r) => setTimeout(r, ${Number(settleMs) || 300}));
  const left = cards.filter((c) => {
    const box = c.querySelector('input[type="checkbox"]');
    return box && box.checked;
  }).length;
  return JSON.stringify({ ok: left === 0, cleared, remaining: left });
})()`;
}


/** Click the page's own confirm button (its label changes with the build, so match the family). */
export function clickActionExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const button = Array.from(document.querySelectorAll('button')).find((b) =>
    /select at least|generate|create link|copy link|get link|share/i.test(clean(b.innerText || b.textContent)));
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
export async function runReferralGroups({ evaluate, groups = [], waitForLinkMs = 6000, pollMs = 400, log = () => {} } = {}) {
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

    log(`group ${groupId}: clearing, then selecting ${titles.length} roles`);
    await evaluate(clearSelectionExpr());

    const selection = await evaluate(selectRolesExpr({ titles }));
    if (!selection?.ok) {
      failures.push({ groupId, reason: 'selection_not_verified', titles, selection });
      continue;
    }
    log(`selected ${selection.selected?.length || 0} role(s) — ${selection.counter || 'counter unread'}`);

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

    log(`link captured via ${link.strategy} for ${titles.length} role(s)`);
    for (const title of titles) {
      captures.push({
        title,
        groupId,
        referralUrl: link.url,
        strategy: link.strategy,
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

