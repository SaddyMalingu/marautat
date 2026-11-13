/**
 * Micro1 multi-role referral links (2026-11-13)
 *
 * The live page says "Select at least 2 roles", so a per-role link is not a referral link. These
 * tests use the real cards from the affiliate page (titles, pay bands and "Refer and earn" figures
 * copied from it) because the whole point is that the grouping matches how micro1 actually works.
 */
import {
  parseAffiliateCards,
  planReferralGroups,
  matchOffersToGroup,
  roleFamily,
  parseRefereeValue,
  readAffiliateExpr,
  selectRolesExpr,
  clearSelectionExpr,
  installClipboardHookExpr,
  clickActionExpr,
  readGeneratedLinkExpr,
  runReferralGroups
} from '../utils/browserActor/tasks/micro1Referrals.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/** Cards exactly as the page renders them (abbreviated). */
const PAGE = {
  ok: true,
  cards: [
    { title: 'Equity & Credit Research Expert', pay: '$100 - $200/hour', refer: '$500', openings: '5 Openings' },
    { title: 'Legal Expert (Employment & Labor Law)', pay: '$80 - $130/hour', refer: '$1,000', openings: '20 Openings' },
    { title: 'Legal Expert (Antitrust & Competition Law)', pay: '$80 - $130/hour', refer: '$1,000', openings: '20 Openings' },
    { title: 'Legal Expert (Environmental Law)', pay: '$80 - $130/hour', refer: '$1,000', openings: '20 Openings' },
    { title: 'Paralegal', pay: '$40 - $80/hour', refer: '$1,000', openings: '20 Openings' },
    { title: 'Paralegal / Law Student — Legal Research', pay: '$50 - $120/hour', refer: '$1,000', openings: '30 Openings' },
    { title: 'Game Developer (Godot Expert)', pay: '$70 - $130/hour', refer: '$1,000', openings: '10 Openings' },
    { title: 'Student Loan Counselor', pay: '$20 - $60/hour', refer: '$500', openings: '10 Openings' },
    { title: 'Passport Acceptance Agent', pay: '$20 - $50/hour', refer: '$100', openings: '10 Openings' }
  ]
};

// ─── Reading the page ──────────────────────────────────────────────────────
{
  const parsed = parseAffiliateCards(PAGE);
  eq('every card is read', parsed.cards.length, 9);
  eq('the referral figure is parsed', parsed.cards[1].referValue, 1000);
  eq('a comma in the figure is handled', parseRefereeValue('$1,500'), 1500);
  eq('the pay band yields the top of the band', parsed.cards[1].payMax, 130);
  eq('a role gets a family', parsed.cards[1].family, 'legal');
  eq('opening counts are numbers', parsed.cards[1].openings, 20);

  eq('an unreadable page says so', parseAffiliateCards({ ok: false, reason: 'no_cards' }).ok, false);
  eq('and returns no cards rather than guessing', parseAffiliateCards({ ok: false }).cards.length, 0);
}

// ─── Grouping, which is what micro1 actually requires ─────────────────────
{
  const { groups } = planReferralGroups(parseAffiliateCards(PAGE).cards, { size: 2, maxGroups: 5 });
  ok('groups are produced', groups.length > 0, String(groups.length));
  ok('no group has fewer than two roles — the whole constraint',
    groups.every((g) => g.members.length >= 2), JSON.stringify(groups.map((g) => g.members.length)));

  const legal = groups.find((g) => g.family === 'legal');
  ok('same-family roles are paired together', Boolean(legal), JSON.stringify(groups.map((g) => g.family)));

  ok('groups are ordered by what the referral pays',
    groups.every((g, i) => i === 0 || groups[i - 1].referralValue >= g.referralValue),
    groups.map((g) => g.referralValue).join(','));
  ok('and every group explains itself', groups.every((g) => typeof g.reason === 'string' && g.reason.length > 10));
}

{
  const { groups } = planReferralGroups(parseAffiliateCards(PAGE).cards, { size: 3, maxGroups: 2 });
  ok('a three-role group is allowed', groups.some((g) => g.members.length === 3));
  ok('the cap is honoured', groups.length <= 2);
}

{
  // A lone role cannot form a link. Saying so beats generating a link micro1 will reject.
  const single = { ok: true, cards: [{ title: 'Game Developer (Godot Expert)', pay: '$70 - $130/hour', refer: '$1,000' }] };
  const { groups, skipped } = planReferralGroups(parseAffiliateCards(single).cards);
  eq('one role on its own produces no link', groups.length, 0);
  ok('and is reported as unpairable', /at least 2/.test(skipped[0]?.reason || ''), JSON.stringify(skipped));
}

{
  // Two unrelated singletons still pair: an offer that can never earn is worse than a mixed link.
  const odd = {
    ok: true,
    cards: [
      { title: 'Game Developer (Godot Expert)', pay: '$70 - $130/hour', refer: '$1,000' },
      { title: 'Passport Acceptance Agent', pay: '$20 - $50/hour', refer: '$100' }
    ]
  };
  const { groups } = planReferralGroups(parseAffiliateCards(odd).cards);
  eq('two unrelated singletons are paired anyway', groups.length, 1);
  eq('and the pairing says it is a fallback', groups[0].kind, 'mixed');
}

{
  // Re-running a capture must not re-generate groups that already have a link.
  const { groups } = planReferralGroups(parseAffiliateCards(PAGE).cards, {
    alreadyGrouped: ['Legal Expert (Employment & Labor Law)', 'Legal Expert (Antitrust & Competition Law)']
  });
  const used = groups.flatMap((g) => g.members.map((m) => m.title));
  eq('an already-linked role is not grouped again', used.includes('Legal Expert (Employment & Labor Law)'), false);
}

// ─── Attaching one link to our own offers ─────────────────────────────────
{
  const { groups } = planReferralGroups(parseAffiliateCards(PAGE).cards, { size: 2, maxGroups: 3 });
  const group = groups.find((g) => g.family === 'legal');
  const offers = [
    { id: 'o1', title: 'Legal Expert (Employment & Labor)' },
    { id: 'o2', title: 'Legal Expert (Antitrust & Competition Law)' },
    { id: 'o3', title: 'Paralegal' },
    { id: 'o4', title: 'Something Else Entirely' }
  ];
  const matched = matchOffersToGroup(group, offers);
  eq('both roles of the group are matched', matched.length, 2);
  ok('an unrelated offer is not', matched.every((o) => o.id !== 'o4'));
  ok('a title with a different suffix still matches', matched.some((o) => o.id === 'o1'),
    matched.map((o) => o.title).join(' | '));
}

// ─── The browser expressions, run against the saved page's markup ───────────
// Not a lookalike: this mirrors the structure of the saved copy of refer.micro1.ai/opportunities
// (the 342 KB one) — a grid of `[data-testid="job-card"]`, each with `label > input[type=checkbox]`
// (sr-only on the real page), an `h2` title, `Pay:` and `N Openings` text, plus the page-level
// "0 Roles selected" counter and the "Select at least 2 roles" action button. That counter is the
// whole bug: no link can be minted until two roles are ticked.
const CODE = 'i43T7GgX';
const JOB = '13caa411-9f96-46b1-a762-9b9bd0604cfb';

function makePage(roles) {
  const state = { clip: null, generated: 0, clicks: [] };

  const cards = roles.map((role) => {
    const heading = { innerText: role.title };
    const box = { checked: false, click() { this.checked = !this.checked; } };
    const label = { click() { box.checked = !box.checked; } };
    const card = {
      innerText: `${role.title}\nmicro1\n${role.openings || 5} Openings\nRequired skills\n`
        + `Pay: ${role.pay}\nRefer and earn ${role.refer}`,
      querySelector: (sel) => {
        if (sel === 'input[type="checkbox"]') return box;
        if (sel === 'h2') return heading;
        if (sel === 'label') return label;
        return null;
      },
      querySelectorAll: () => [],
      scrollIntoView: () => {}
    };
    return { card, box, role };
  });

  const selected = () => cards.filter((c) => c.box.checked);

  // The page's own confirm control: disabled until two roles are ticked, exactly as in the dump.
  const action = {
    get disabled() { return selected().length < 2; },
    // The real button's label is the instruction while it is disabled; it only becomes an action
    // once the minimum is met. Reproducing that is what lets the test assert both states.
    get innerText() { return selected().length < 2 ? 'Select at least 2 roles' : 'Generate link'; },
    scrollIntoView: () => {},
    click() {
      state.clicks.push(selected().map((c) => c.role.title));
      state.generated += 1;
      // The real button copies the coded link; it does not navigate and does not render it.
      state.clip = `https://jobs.micro1.ai/post/${JOB}?referralCode=${CODE}&utm_source=referral`;
      window.navigator.clipboard.writeText(state.clip);
    }
  };

  const document = {
    title: 'Opportunities | micro1 referral platform',
    querySelectorAll(sel) {
      if (sel === '[data-testid="job-card"]') return cards.map((c) => c.card);
      if (sel === 'button') return [action];
      return [];
    },
    querySelector: () => null
  };
  // Computed, so it reflects the current tick state — the counter is what proves a tick landed.
  Object.defineProperty(document, 'body', {
    get: () => ({
      innerText: state.bodyOverride || (
        `${selected().length} Roles selected\nSelect the opportunities you want to include in your link\n`
        + (selected().length < 2 ? 'Select at least 2 roles' : 'Generate link')
      )
    })
  });

  const window = {
    __m1clip: null,
    navigator: { clipboard: { writeText: (t) => { state.clip = t; } } }
  };
  const location = { href: 'https://refer.micro1.ai/opportunities' };

  /** Run one of the real expressions against this page, returning parsed JSON. */
  const evaluate = async (expression) => {
    const result = await new Function('document', 'window', 'navigator', 'location', `return ${expression};`)(
      document, window, window.navigator, location
    );
    // The expressions return JSON strings; keeping that contract means a mistake there fails here.
    return typeof result === 'string' ? JSON.parse(result) : result;
  };

  return { state, cards, action, document, evaluate, window };
}

const ROLES = [
  { title: 'Legal Expert (Employment & Labor Law)', pay: '$80 - $130/hour', refer: '$1,000', openings: 20 },
  { title: 'Legal Expert (Antitrust & Competition Law)', pay: '$80 - $130/hour', refer: '$1,000', openings: 20 },
  { title: 'Paralegal', pay: '$40 - $80/hour', refer: '$1,000', openings: 20 }
];


{
  const page = makePage(ROLES);
  const snapshot = await page.evaluate(readAffiliateExpr());
  eq('the builder is recognised as such', snapshot.mode, 'builder');
  eq('every card is read', snapshot.count, 3);
  eq('titles come from the h2', snapshot.cards[0].title, 'Legal Expert (Employment & Labor Law)');
  eq('the reward is read', snapshot.cards[0].refer, '$1,000');
  eq('the openings are read', snapshot.cards[0].openings, '20 Openings');
  ok('the pay band is read', /\$80/.test(snapshot.cards[0].pay || ''), snapshot.cards[0].pay);
  eq('cards are selectable', snapshot.cards[0].selectable, true);
  eq('the counter is read', snapshot.counter, '0 Roles selected');
  eq('the minimum is read off the page', snapshot.minimum, 2);
  eq('the action starts disabled', snapshot.action.disabled, true);

  // The reader's own output must feed the planner, or the two halves drift apart.
  const planned = planReferralGroups(parseAffiliateCards(snapshot).cards, { size: 2, maxGroups: 3 });
  ok('the reader feeds the planner directly', planned.groups.length > 0, String(planned.groups.length));
  eq('and the legal pair groups by family', planned.groups[0]?.family, 'legal');
}

{
  // The other saved copy: same URL and title, same cards, but zero checkboxes. It must never be
  // mistaken for a page that can mint a group link.
  const listing = {
    title: 'Opportunities | micro1 referral platform',
    body: { innerText: 'Refer and earn $500' },
    querySelectorAll: (sel) => (sel === '[data-testid="job-card"]'
      ? [{
        innerText: 'Paralegal\nmicro1\n20 Openings\nRequired skills\nPay: $40 - $80/hour\nRefer and earn $500',
        querySelector: (s) => (s === 'h2' ? { innerText: 'Paralegal' } : null),
        querySelectorAll: () => []
      }]
      : [])
  };
  const snapshot = JSON.parse(await new Function('document', 'window', 'location', `return ${readAffiliateExpr()};`)(
    listing, { __m1clip: null }, { href: 'https://refer.micro1.ai/opportunities' }
  ));
  eq('a page with no checkboxes is the listing, not the builder', snapshot.mode, 'listing');
  eq('and says why', snapshot.reason, 'no_checkboxes');
  eq('the card is still readable', snapshot.cards[0].title, 'Paralegal');
}

{
  const empty = {
    title: 'Sign in | micro1',
    body: { innerText: 'Please sign in to continue' },
    querySelectorAll: () => []
  };
  const snapshot = JSON.parse(await new Function('document', 'window', 'location', `return ${readAffiliateExpr()};`)(
    empty, { __m1clip: null }, { href: 'https://refer.micro1.ai/opportunities' }
  ));
  eq('no cards is not ok', snapshot.ok, false);
  eq('and says why', snapshot.reason, 'no_job_cards');
  ok('and shows what it saw, so a sign-in wall is obvious', /sign in/i.test(snapshot.bodyStart), snapshot.bodyStart);
}


// ─── The whole capture, end to end, against the simulated page ──────────────
{
  const page = makePage(ROLES);
  const lines = [];
  const result = await runReferralGroups({
    evaluate: page.evaluate,
    groups: [{ id: 'g1', family: 'legal', roles: ROLES.slice(0, 2) }],
    waitForLinkMs: 50,
    pollMs: 10,
    log: (line) => lines.push(line)
  });

  eq('the group run succeeds', result.ok, true);
  eq('one link, attached to both roles', result.captures.length, 2);
  eq('both roles carry the SAME url', result.captures[0].referralUrl, result.captures[1].referralUrl);
  ok('the url is the coded job link', new RegExp(`referralCode=${CODE}`).test(result.captures[0].referralUrl),
    result.captures[0].referralUrl);
  eq('and it came from the clipboard trap, not from guessing', result.captures[0].strategy, 'clipboard-hook');
  eq('the roles are recorded as sharing it', result.captures[0].sharedWith.length, 1);
  eq('both roles were ticked when the button was pressed', page.state.clicks[0].length, 2);
  eq('exactly one link was generated', page.state.generated, 1);
  ok('the run explains itself', lines.length >= 2, lines.join(' | '));
}

{
  // A group of one is refused before the browser is touched: micro1 would not mint it anyway.
  const page = makePage(ROLES);
  const result = await runReferralGroups({
    evaluate: page.evaluate,
    groups: [{ id: 'solo', roles: ['Paralegal'] }],
    waitForLinkMs: 50,
    pollMs: 10
  });
  eq('a single role is not attempted', result.ok, false);
  eq('and is reported as too small', result.failures[0].reason, 'group_too_small');
  eq('nothing was clicked', page.state.generated, 0);
}

{
  // Two groups in a row must not leak selections into each other.
  const page = makePage(ROLES);
  const result = await runReferralGroups({
    evaluate: page.evaluate,
    groups: [
      { id: 'g1', roles: [ROLES[0].title, ROLES[1].title] },
      { id: 'g2', roles: [ROLES[1].title, ROLES[2].title] }
    ],
    waitForLinkMs: 50,
    pollMs: 10
  });
  eq('both groups run', result.ok, true);
  eq('each group produced two captures', result.captures.length, 4);
  eq('the second group selected exactly its own two roles', page.state.clicks[1].length, 2);
  ok('and not the first group\'s leftovers', !page.state.clicks[1].includes(ROLES[0].title),
    page.state.clicks[1].join(' | '));
  eq('the second group\'s captures are tagged with it', result.captures[2].groupId, 'g2');
}

{
  // A role that vanished from the page must fail its group, not produce a half-covered link.
  const page = makePage(ROLES.slice(0, 2));
  const result = await runReferralGroups({
    evaluate: page.evaluate,
    groups: [{ id: 'gone', roles: [ROLES[0].title, ROLES[2].title] }],
    waitForLinkMs: 50,
    pollMs: 10
  });
  eq('a missing role fails the group', result.ok, false);
  eq('with a reason a human can act on', result.failures[0].reason, 'selection_not_verified');
  eq('and nothing was published', result.captures.length, 0);
  eq('no link was generated', page.state.generated, 0);
}

{
  // The disabled button is the page's own guard. Pressing it with one role selected would be a bug
  // worth failing on, not a link worth keeping.
  const page = makePage(ROLES);
  const action = await page.evaluate(clickActionExpr());
  eq('a disabled action is refused', action.ok, false);
  eq('and named as such', action.reason, 'action_disabled');
  ok('with the label that was disabled', /select at least 2/i.test(action.label), action.label);
}

{
  const page = makePage(ROLES);
  page.window.__m1clip = `https://jobs.micro1.ai/post/${JOB}?referralCode=${CODE}`;
  const link = await page.evaluate(readGeneratedLinkExpr());
  eq('the clipboard is preferred over the DOM', link.strategy, 'clipboard-hook');

  page.window.__m1clip = null;
  const nothing = await page.evaluate(readGeneratedLinkExpr());
  eq('no link is a failure, not an empty string', nothing.ok, false);
}

// ─── Findings from the real dump that a hand-written fixture would have missed ───
{
  // 48 cards, 27 unique titles, 24 with checkboxes: the same role can appear twice, and only one
  // copy can be ticked. Collapsing must prefer the copy that can actually be selected.
  const snapshot = {
    ok: true,
    cards: [
      { title: 'Paralegal', pay: '$40 - $80/hour', refer: '$500', selectable: false },
      { title: 'Paralegal', pay: '$40 - $80/hour', refer: '$500', selectable: true },
      { title: 'Medicare Counselor', pay: '$30/hour', refer: '$500', selectable: false }
    ]
  };
  const parsed = parseAffiliateCards(snapshot);
  eq('duplicate titles collapse to one card', parsed.cards.length, 2);
  eq('and the surviving copy is the selectable one', parsed.cards[0].selectable, true);
  eq('the number dropped is reported', parsed.duplicates, 1);

  // A "pair" of one role with itself is the trap this prevents.
  const planned = planReferralGroups(parsed.cards, { size: 2, maxGroups: 3 });
  ok('no group pairs a role with itself',
    planned.groups.every((g) => new Set((g.roles || g.members || []).map((r) => r.title)).size > 1),
    JSON.stringify(planned.groups));
}

{
  // The pay value runs into the reward line when a card is read flat. Cheerio's text() proves it:
  // "$100 - $200/hourRefer and earn $500". The reader must cut at the reward.
  const page = makePage([{ title: 'Equity & Credit Research Expert', pay: '$100 - $200/hour', refer: '$500', openings: 15 }]);
  // Simulate the flattened read the real DOM produces for the pay line.
  page.cards[0].card.innerText = page.cards[0].card.innerText.replace('Pay: $100 - $200/hour\n', 'Pay: $100 - $200/hour');
  const snapshot = await page.evaluate(readAffiliateExpr());
  eq('the pay band is not polluted by the reward', snapshot.cards[0].pay, '$100 - $200/hour');
  eq('and the reward is still read separately', snapshot.cards[0].refer, '$500');
}

{
  // The live page nests the counter across spans, so a flat text read gives "0000 Roles selected".
  // The element-based read must win, because "0000 roles" is a number that was never on screen.
  const page = makePage(ROLES);
  page.state.bodyOverride = '0000 Roles selected\nSelect the opportunities you want to include in your link\n';
  page.document.querySelectorAll = ((original) => (sel) => {
    if (sel === 'span,div,p') return [{ textContent: '0 Roles selected' }];
    return original(sel);
  })(page.document.querySelectorAll.bind(page.document));

  const snapshot = await page.evaluate(readAffiliateExpr());
  eq('the counter comes from the element, not the flattened page', snapshot.counter, '0 Roles selected');
}

{
  // The planner's own output must be feedable straight into the executor: it emits `members`, and
  // a mismatch there would have been invisible until a live run.
  const page = makePage(ROLES);
  const cards = parseAffiliateCards({ ok: true, cards: ROLES.map((r) => ({ ...r, selectable: true })) }).cards;
  const planned = planReferralGroups(cards, { size: 2, maxGroups: 1 });
  ok('the planner produced a group', planned.groups.length === 1, String(planned.groups.length));

  const result = await runReferralGroups({
    evaluate: page.evaluate,
    groups: planned.groups,
    waitForLinkMs: 50,
    pollMs: 10
  });
  eq('the planner output runs without translation', result.ok, true);
  eq('both planned roles were captured', result.captures.length, 2);
  ok('and the group keeps the planner\'s own title', typeof result.captures[0].groupId === 'string'
    && result.captures[0].groupId.includes('+'), result.captures[0].groupId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
