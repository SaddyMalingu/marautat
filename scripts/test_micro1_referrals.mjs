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
      // Two shapes, because the runner asks for both: the plain `button` list and the `button, [role="button"]` list
      // it uses now that a build renders the confirm control without a <button> (2026-11-18).
      if (sel === 'button' || sel === 'button, [role="button"]') return [action];
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

// ─── The worker asks for grouped capture (2026-11-16) ────────────────────────────────────────
{
  const { buildRunArgs } = await import('../utils/browserActor/runArgs.js');
  const micro = buildRunArgs({ relative: 'scripts/browser_actor_micro1.mjs', platform: 'micro1', tenantSlug: 'acme', runId: 'r1', limit: 40, api: 'https://x' });
  ok('a micro1 run asks for pairs', micro.includes('--groups'), micro.join(' '));
  eq('at micro1s minimum of two', micro[micro.indexOf('--group-size') + 1], '2');
  ok('and caps the pairs per run', Number(micro[micro.indexOf('--max-groups') + 1]) >= 1);
  // A parameter default of 5 shadowed this once, so every run asked for five pairs however the fallback was written.
  eq('twelve pairs per run by default', micro[micro.indexOf('--max-groups') + 1], '12');

  // Two phases, one worker: a run may ask to collect offers instead of minting links, because a role that was never
  // collected cannot be linked at all.
  const offers = buildRunArgs({ relative: 'scripts/browser_actor_micro1.mjs', platform: 'micro1', tenantSlug: 'acme', runId: 'r2', limit: 40, api: 'x', phase: 'offers' });
  ok('the offers phase collects per role', offers.includes('--per-role'), offers.join(' '));
  ok('and does not ask for pairs', !offers.includes('--groups'), offers.join(' '));
  ok('a run may opt out', !buildRunArgs({ relative: 'scripts/browser_actor_micro1.mjs', platform: 'micro1', tenantSlug: 'acme', runId: 'r1', limit: 40, api: 'x', group: false }).includes('--groups'));
  ok('turing is untouched by the micro1 flags', !buildRunArgs({ relative: 'scripts/browser_actor_referrals.mjs', platform: 'turing', tenantSlug: 'acme', runId: 'r1', limit: 40, api: 'x' }).includes('--groups'));
}

{
  const {
    captureGroupsOnPage,
    parkedSurveyExpr,
    openBuilderExpr,
    readAffiliateExpr,
    clearSelectionExpr,
    selectRolesExpr,
    clickActionExpr,
    installClipboardHookExpr
  } = await import('../utils/browserActor/tasks/micro1Referrals.js');

  // A fake page: the survey reports which page it is, the card read returns the builder's cards, and the group
  // run returns one link shared by both roles — exactly micro1's own model.
  // Answer by *what was asked*, not by position: an aborted group skips calls, so counting desyncs.
  // The selection expression embeds the group's titles, so match its stable prefix instead.
  const selectPrefix = selectRolesExpr({ titles: ['__probe__'] }).split('__probe__')[0];
  // `readAffiliateExpr` is called at two limits (240 for planning, 1 as a state assertion), so match its prefix.
  const readPrefix = readAffiliateExpr({ limit: 240 }).split('240')[0];
  const fakePage = ({ page = 'builder', opensTo = null, opensAfter = 1, entry = null, cards = [], selectionOk = true, closeAfterCapture = false, link = 'https://jobs.micro1.ai/post/abc123?referralCode=42' } = {}) => {
    let clicks = 0;
    let entryIndex = 0;
    // The real popup closes once it has generated a link, which is what left groups two and three clicking cards on
    // the listing page (2026-11-16).
    let closed = false;
    const evaluateJson = async ({ expression }) => {
      if (expression === parkedSurveyExpr()) {
        // How many entry clicks it takes before the builder exists: one for the pill on the referral dashboard,
        // two when the engine first has to walk from the listing to that dashboard.
        const seen = closed ? 'listing' : (opensTo && clicks >= opensAfter ? opensTo : page);
        return { ok: true, page: seen, boxes: seen === 'builder' ? 4 : 0, cards: seen === 'builder' ? cards.length : 0 };
      }
      if (expression === openBuilderExpr()) {
        clicks += 1;
        closed = false;
        if (Array.isArray(entry)) return entry[Math.min(entryIndex++, entry.length - 1)];
        return entry || { ok: true, clicked: true, navigated: false, label: 'Your referral link', candidates: 2 };
      }
      if (String(expression).startsWith(readPrefix)) {
        return {
          ok: cards.length > 0,
          mode: 'builder',
          counter: '0 Roles selected',
          minimum: 2,
          action: { label: 'Select at least 2 roles', disabled: true },
          cards
        };
      }
      if (expression === installClipboardHookExpr()) return { ok: true };
      if (expression === clearSelectionExpr()) return { ok: true };
      if (String(expression).startsWith(selectPrefix)) {
        return selectionOk ? { ok: true, selected: [] } : { ok: false, reason: 'selection_not_verified' };
      }
      if (expression === clickActionExpr()) return { ok: true };
      if (expression === readGeneratedLinkExpr()) {
        if (closeAfterCapture) closed = true;
        return { ok: true, url: link, strategy: 'clipboard' };
      }
      return { ok: true, url: link, strategy: 'clipboard' };
    };
    return { evaluateJson };
  };

  const cards = [
    { title: 'Sales Rep A', family: 'sales', referValue: 50, payMax: 20 },
    { title: 'Sales Rep B', family: 'sales', referValue: 40, payMax: 18 },
    { title: 'Tutor C', family: 'tutor', referValue: 30, payMax: 12 },
    { title: 'Tutor D', family: 'tutor', referValue: 25, payMax: 10 }
  ];

  const onListing = await captureGroupsOnPage({ ...fakePage({ page: 'listing', cards }), size: 2, maxGroups: 5, openWaitMs: 60 });
  eq('on the listing it refuses instead of pretending', onListing.ok, false);
  // The reason names the click target, because a click that lands somewhere else (the search box, live on
  // 2026-11-16) used to read as a slow page rather than a wrong target.
  ok('and says which page it saw', /builder_did_not_open:listing/.test(onListing.reason || ''), onListing.reason);
  ok('and names what it clicked', /after clicking/.test(onListing.reason || ''), onListing.reason);
  eq('having captured nothing', onListing.captures.length, 0);

  // The real page: the roles become selectable only after the popup is opened. One click, then pairs.
  const openedFirst = await captureGroupsOnPage({ ...fakePage({ page: 'listing', opensTo: 'builder', cards }), size: 2, maxGroups: 5 });
  eq('it opens the popup and then captures', openedFirst.ok, true);
  eq('two pairs from four cards', openedFirst.groups, 2);
  eq('with a link on every role', openedFirst.captures.length, 4);

  const tooFew = await captureGroupsOnPage({ ...fakePage({ cards: [cards[0]] }), size: 2, maxGroups: 5 });
  eq('one role cannot form a group', tooFew.reason, 'builder_has_too_few_roles');

  const pairs = await captureGroupsOnPage({ ...fakePage({ cards }), size: 2, maxGroups: 5 });
  eq('four cards make two pairs', pairs.groups, 2);
  eq('each pair yields a capture per role', pairs.captures.length, 4);
  ok('both roles of a pair carry the SAME url',
    pairs.captures[0].referralUrl === pairs.captures[1].referralUrl, pairs.captures.slice(0, 2).map((c) => c.referralUrl));
  ok('with the group recorded, so the portal can explain the pairing', Boolean(pairs.captures[0].groupId));

  const capped = await captureGroupsOnPage({ ...fakePage({ cards }), size: 2, maxGroups: 1 });
  eq('maxGroups is honoured', capped.groups, 1);

  const unselectable = await captureGroupsOnPage({ ...fakePage({ cards, selectionOk: false }), size: 2, maxGroups: 5 });
  eq('a selection that does not take is a failure, not a link', unselectable.ok, false);
  eq('with nothing captured', unselectable.captures.length, 0);
  ok('and names the stage that failed', /selection/i.test(unselectable.reason || ''), unselectable.reason);

  // The entry pill lives on the referral dashboard and opens a MENU; the modal only opens from the menu's
  // "Link with specific expert opportunities" item. Three stages, and the engine has to walk them one per attempt.
  const twoStep = await captureGroupsOnPage({
    ...fakePage({
      page: 'listing',
      opensTo: 'builder',
      opensAfter: 3,
      entry: [
        { ok: true, navigated: true, stage: 'nav', waitMs: 20, label: 'Dashboard' },
        { ok: true, clicked: true, stage: 'pill', waitMs: 20, label: 'Your referral link' },
        { ok: true, clicked: true, stage: 'menu', waitMs: 20, label: 'Link with specific expert opportunities' }
      ],
      cards
    }),
    size: 2,
    maxGroups: 5,
    openWaitMs: 60
  });
  eq('it walks to the dashboard, clicks the pill, then the menu item', twoStep.ok, true);
  eq('and pairs once the modal opens', twoStep.groups, 2);

  // The state the live run was stuck in: the pill was clicked, no menu appeared, nothing else to do.
  const stuckAfterPill = await captureGroupsOnPage({
    ...fakePage({
      page: 'listing',
      entry: [
        { ok: true, clicked: true, stage: 'pill', waitMs: 20, label: 'Your referral link' },
        { ok: false, reason: 'no_builder_entry', controls: [{ tag: 'button', text: 'Your referral link' }] }
      ],
      cards
    }),
    size: 2,
    maxGroups: 5,
    openWaitMs: 60
  });
  eq('a menu that never appears stops the pass', stuckAfterPill.ok, false);
  ok('and says the pill was clicked', /no_builder_entry/.test(stuckAfterPill.reason || ''), stuckAfterPill.reason);

  // When there is nothing to click, the failure carries the page's own control labels: that is what turns the
  // next attempt into a one-line selector fix instead of another screenshot.
  const noEntry = await captureGroupsOnPage({
    ...fakePage({ page: 'listing', cards, entry: { ok: false, reason: 'no_builder_entry', controls: [{ tag: 'button', text: 'Your referral link' }] } }),
    size: 2,
    maxGroups: 5,
    openWaitMs: 60
  });
  eq('an entry it cannot find stops the pass', noEntry.ok, false);
  ok('naming the reason', /no_builder_entry/.test(noEntry.reason || ''), noEntry.reason);
  eq('and handing back the controls it saw', noEntry.controls.length, 1);
  eq('so the next attempt is a selector fix', noEntry.controls[0].text, 'Your referral link');

  // The live grid renders duplicates and carries no family field. The planner must see PARSED cards, or every card
  // lands in one "(none)" family and unrelated roles get paired — and the same pair gets planned twice (2026-11-16).
  const rawGrid = [
    { title: 'Spanish Language Expert (LATAM)', refer: '$100', pay: '$16 - $45/hour' },
    { title: 'Spanish Language Expert (LATAM)', refer: '$100', pay: '$16 - $45/hour' },
    { title: 'Spanish Language Expert (Mexico)', refer: '$100', pay: '$16 - $45/hour' },
    { title: 'AI Agent Tester', refer: '$100', pay: '$25 - $45/hour' }
  ];
  const fromRaw = await captureGroupsOnPage({ ...fakePage({ cards: rawGrid }), size: 2, maxGroups: 5 });
  eq('a duplicate card does not become a second pair of the same roles', fromRaw.groups, 1);
  eq('and the pair is the two Spanish roles', fromRaw.captures.length, 2);
  ok('never a Spanish role paired with an AI tester',
    !fromRaw.captures.some((capture) => /AI Agent Tester/i.test(capture.title)),
    fromRaw.captures.map((capture) => capture.title).join(' + '));

  // The reader's `selectable` flag is a guess from markup, and gating on it paired only 12 of 70 tickable cards.
  const unclassified = await captureGroupsOnPage({
    ...fakePage({ cards: cards.map((card) => ({ ...card, selectable: false })) }),
    size: 2,
    maxGroups: 5
  });
  eq('a card the reader cannot classify is still paired', unclassified.groups, 2);

  // The popup closes once it generates a link. Every later group must re-open it, or it ticks cards on the listing
  // page: the live run captured pair 1, then read `counter 2→?`, then found no action button at all (2026-11-16).
  const reopened = await captureGroupsOnPage({
    ...fakePage({ cards, closeAfterCapture: true }),
    size: 2,
    maxGroups: 5
  });
  eq('a pair that closes the popup does not stop the next pair', reopened.ok, true);
  eq('both pairs captured', reopened.groups, 2);
  eq('with a link on all four roles', reopened.captures.length, 4);
  eq('and one re-open per pair after the first', reopened.failures.length, 0);

  // A link minted for a role the tenant does not own has nowhere to go — four links died that way in one run. Pairing
  // is limited to the tenant's own offers, and an empty intersection is a named stop rather than a wasted run.
  const heldFixture = [
    { title: 'Spanish Language Expert (LATAM)', family: 'spanish', referValue: 100, payMax: 45 },
    { title: 'Spanish Language Expert (Mexico)', family: 'spanish', referValue: 100, payMax: 45 },
    { title: 'Mechanical Engineering Expert', family: 'mechanical', referValue: 90, payMax: 60 }
  ];
  const heldOnly = await captureGroupsOnPage({
    ...fakePage({ cards: heldFixture }),
    size: 2,
    maxGroups: 5,
    // Only two of the three are offers the tenant holds, and they are unrelated.
    knownTitles: ['Spanish Language Expert (LATAM)', 'Mechanical Engineering Expert']
  });
  eq('only held offers are paired', heldOnly.ok, false);
  eq('and the stop says why', heldOnly.reason, 'no_pairable_roles');

  // One held role is not a pair, and it is not `no_pairable_roles` either: the fix is the offers phase, because the
  // popup's other roles are not offers yet. Three re-mint runs were spent on that confusion on 2026-11-17.
  const singleHeld = await captureGroupsOnPage({
    ...fakePage({ cards: heldFixture }),
    size: 2,
    maxGroups: 5,
    knownTitles: ['Mechanical Engineering Expert']
  });
  eq('a popup with one held role cannot pair', singleHeld.reason, 'held_pool_too_small');
  eq('and it reports what the pool held', singleHeld.held, 1);
  eq('and how many roles are not collected yet', singleHeld.notCollected, 2);

  const pairOfHeld = await captureGroupsOnPage({
    ...fakePage({ cards: heldFixture }),
    size: 2,
    maxGroups: 5,
    knownTitles: ['Spanish Language Expert (LATAM)', 'Spanish Language Expert (Mexico)']
  });
  eq('the held pair is the one that gets a link', pairOfHeld.ok, true);
  eq('and it is that pair', pairOfHeld.groups, 1);

  const noneHeld = await captureGroupsOnPage({
    ...fakePage({ cards }),
    size: 2,
    maxGroups: 5,
    knownTitles: ['Something Else Entirely']
  });
  eq('a builder with none of your offers stops by name', noneHeld.reason, 'no_known_offers_in_builder');
}


// ─── Related roles only, and links that credit somebody (2026-11-16) ─────────────────────────
{
  const { planReferralGroups, referralAttribution } = await import('../utils/browserActor/tasks/micro1Referrals.js');

  // The tenant's own words: grouping must not seem spammy. Two unrelated roles in one recommendation do.
  const unrelated = planReferralGroups([
    { title: 'Legal Expert (Employment)', family: 'legal', referValue: 90, payMax: 40 },
    { title: 'Game Developer (Godot)', family: 'game', referValue: 80, payMax: 35 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  eq('unrelated singletons are not paired', unrelated.groups.length, 0);
  eq('and both are reported unpairable', unrelated.skipped.length, 2);
  ok('with a reason a tenant can read', /partner/i.test(unrelated.skipped[0].reason || ''), unrelated.skipped[0].reason);

  const related = planReferralGroups([
    { title: 'Legal Expert (Employment)', family: 'legal', referValue: 90, payMax: 40 },
    { title: 'Legal Expert (Antitrust)', family: 'legal', referValue: 85, payMax: 38 },
    { title: 'Game Developer (Godot)', family: 'game', referValue: 80, payMax: 35 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  eq('a related pair still forms', related.groups.length, 1);
  eq('from the two legal roles', related.groups[0].family, 'legal');
  eq('and the odd one out waits instead of being forced in', related.skipped.length, 1);

  // Attribution: what makes a click credit the tenant at all.
  eq('a referral parameter counts', referralAttribution('https://jobs.micro1.ai/post/abc?referralCode=42'), 'param');
  eq('an invite path counts', referralAttribution('https://micro1.ai/invite/abc123xyz'), 'path');
  eq('an unrecognised query is kept but flagged', referralAttribution('https://micro1.ai/post/abc?foo=1'), 'unknown');
  eq('a bare link credits nobody', referralAttribution('https://jobs.micro1.ai/post/abc123'), 'none');
  eq('and nothing is not a link', referralAttribution(''), 'none');
}

// ─── Same field is the second tier (2026-11-16) ──────────────────────────────────────────────
//
// The tenant's rule: software engineering is software engineering, even when it is dressed as ML, full-stack or
// back-end — and the same holds for law, medicine and languages. Families keep the tightest pairs; the field tier
// makes the rest payable without pairing anything that shares nothing.
{
  const { planReferralGroups, roleField } = await import('../utils/browserActor/tasks/micro1Referrals.js');

  eq('full-stack is software', roleField('Full Stack Developer'), 'tech');
  eq('back-end is software', roleField('Back-End Engineer'), 'tech');
  eq('ML is software dressed differently', roleField('Machine Learning Researcher'), 'tech');
  eq('so is an AI tester', roleField('AI Agent Tester'), 'tech');
  eq('law is law', roleField('Legal Expert (Antitrust & Competition Law)'), 'legal');
  eq('medicine is medicine', roleField('Hematology Physician'), 'health');
  eq('languages are languages', roleField('Spanish Language Expert (Mexico)'), 'language');
  eq('e-commerce data is commerce, not data engineering', roleField('E-commerce Data & Catalog Specialist'), 'commerce');
  eq('a commercial underwriter is finance', roleField('Senior Commercial Underwriter'), 'finance');
  // The live catalogue's engineering titles, which the first taxonomy missed — and an unplaced title can never pair.
  eq('hardware is engineering', roleField('Hardware Expert'), 'tech');
  eq('aerodynamics is engineering', roleField('Aerodynamics Expert'), 'tech');
  eq('STEM is engineering', roleField('STEM Expert'), 'tech');
  eq('a PhysioNet competitor is engineering', roleField('PhysioNet Competitor (Biomedical Signal Processing & ML)'), 'tech');

  const engineering = planReferralGroups([
    { title: 'STEM Expert', referValue: 1000, payMax: 120 },
    { title: 'Hardware Expert', referValue: 1000, payMax: 120 },
    { title: 'Aerodynamics Expert', referValue: 1000, payMax: 120 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  ok('three singleton engineering roles still form a pair', engineering.groups.length >= 1, `${engineering.groups.length}`);
  eq('through the field tier', engineering.groups[0].basis, 'field');

  // Two roles that a first-token family made strangers.
  const loose = planReferralGroups([
    { title: 'Machine Learning Researcher', referValue: 500, payMax: 120 },
    { title: 'Applied Scientists — Machine Learning', referValue: 500, payMax: 120 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  eq('roles in one field pair up', loose.groups.length, 1);
  eq('and say the pairing came from the field tier', loose.groups[0].basis, 'field');
  eq('naming the field, so it can be audited', loose.groups[0].field, 'tech');

  // Families still win, because a tighter pair is a better recommendation.
  const strict = planReferralGroups([
    { title: 'Spanish Language Expert (LATAM)', referValue: 100, payMax: 45 },
    { title: 'Spanish Language Expert (Mexico)', referValue: 100, payMax: 45 },
    { title: 'Portuguese Language Expert (Brazil)', referValue: 100, payMax: 45 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  eq('the same-language pair is taken first', strict.groups[0].basis, 'family');
  eq('and the third language waits for a partner', strict.skipped.length, 1);

  // The line that must not move: two roles sharing nothing stay apart.
  const disjoint = planReferralGroups([
    { title: 'Legal Expert (Employment)', referValue: 100, payMax: 40 },
    { title: 'Ground Combat & Special Operations SME', referValue: 100, payMax: 90 }
  ], { size: 2, maxGroups: 5, allowMixed: false });
  eq('a legal expert and a combat instructor are not a pair', disjoint.groups.length, 0);
  eq('both are reported unpairable', disjoint.skipped.length, 2);
}

{
  // A link that credits nobody is refused by the engine rather than stored: that is the failure that cost months.
  const { runReferralGroups } = await import('../utils/browserActor/tasks/micro1Referrals.js');
  const bare = 'https://jobs.micro1.ai/post/abc123';
  const evaluate = async (expression) => {
    const source = String(expression);
    if (/m1clip|data-clipboard|input,textarea/.test(source)) return { ok: true, url: bare, strategy: 'clipboard' };
    // The engine now asserts the popup state before each pair, so the fake has to answer that read too.
    if (source.includes('job-card') && /Pay:/.test(source)) return { ok: true, mode: 'builder', counter: '0 Roles selected', cards: [{ title: 'Legal A' }] };
    return { ok: true, selected: ['Legal A', 'Legal B'], counter: '2 selected' };
  };
  const run = await runReferralGroups({ evaluate, groups: [{ title: 'legal pair', members: ['Legal A', 'Legal B'] }], waitForLinkMs: 20, pollMs: 5 });
  eq('a link without attribution is a failure', run.failures[0]?.reason, 'link_without_attribution');
  eq('and is not published', run.captures.length, 0);
}

{
  // The live run of 2026-11-16 never called the group engine at all: the flags existed and nothing used them.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../scripts/browser_actor_micro1.mjs', import.meta.url), 'utf8');
  const moduleSrc = fs.readFileSync(new URL('../utils/browserActor/tasks/micro1Referrals.js', import.meta.url), 'utf8');
  ok('the runner actually calls the group engine', /captureGroupsOnPage\(\{/.test(src));
  ok('pairing is the default, with --per-role as the opt-out', /flag\('per-role'/.test(src));
  ok('roles with no related partner are named, not silently dropped', /no_related_partner/.test(src));
  ok('a pair shares one link and says who with', /sharedWith: pair\.sharedWith/.test(src));
  // The entry is the pill on the referral dashboard; the first live attempt looked for a label that page does
  // not have and stopped with "no_builder_entry".
  ok('the entry names the real pill', /your referral link/i.test(moduleSrc));
  ok('and can walk to the referral page when it is not on the current one', /navigated: true/.test(moduleSrc));
  // The pill opens a dropdown; its items are not <button>s, and the modal only opens from the "specific" item.
  ok('the menu item is matchable', /role="menuitem"/.test(moduleSrc));
  ok('and is clicked after the pill opens the menu', /stage === 'menu'/.test(moduleSrc));
  ok('only the innermost label is clicked', /el\.contains\(other\)/.test(moduleSrc));
  // 67 imported roles were excluded from pairing once, then 48 more whose URL credited nobody — the dead links are the
  // population this phase exists to replace.
  ok('roles imported without a payable link stay pairable', /referralAttribution\(offer\.referral_url\) !== 'none'/.test(src));
  ok('pairs outside the run window still get their link', /outside this run's window/.test(src));
  ok('a page with no entry reports its own controls', /controls: openedAtStart\.controls/.test(moduleSrc));
  // The select expressions are async; without awaitPromise CDP hands back a pending Promise, which deserialises to
  // undefined — every selection then "failed" while the page was never read (2026-11-16).
  ok('the runner awaits promises in the page', /awaitPromise: true/.test(src));
  ok('and grants the clipboard permission up front', /Browser\.grantPermissions/.test(src));
  ok('bringing the page to the front so clicks land', /Page\.bringToFront/.test(src));
  // Raw cards carry no family, so planning must go through the parser that assigns one and drops duplicates.
  ok('pairing plans from parsed cards', /parseAffiliateCards\(read\)/.test(moduleSrc));
}

// ─── Every injected expression must at least parse (2026-11-16) ──────────────────────────────
//
// These strings are evaluated in the tenant's browser, so a stray backtick or a duplicated identifier is invisible
// to `node --check` and only shows up as a silent no-op on a live run. Parsing them here costs nothing.
{
  const mod = await import('../utils/browserActor/tasks/micro1Referrals.js');
  const expressions = {
    readAffiliateExpr: mod.readAffiliateExpr({ limit: 5 }),
    selectRolesExpr: mod.selectRolesExpr({ titles: ['A', 'B'] }),
    clearSelectionExpr: mod.clearSelectionExpr(),
    clickActionExpr: mod.clickActionExpr(),
    openBuilderExpr: mod.openBuilderExpr(),
    parkedSurveyExpr: mod.parkedSurveyExpr(),
    readGeneratedLinkExpr: mod.readGeneratedLinkExpr(),
    installClipboardHookExpr: mod.installClipboardHookExpr()
  };
  for (const [name, expression] of Object.entries(expressions)) {
    let parsed = true;
    let message = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function(expression);
    } catch (error) {
      parsed = false;
      message = error.message;
    }
    ok(`${name} parses as JavaScript`, parsed, message);
  }

  // The tick ladder, and the page's own counter as proof.
  const select = mod.selectRolesExpr({ titles: ['A'] });
  ok('the tick walks a ladder: control, label, corner', /press\(target\)/.test(select)
    && /card\.querySelector\('label'\)/.test(select)
    && /cornerTarget\(card\)/.test(select));
  ok('and waits for the page to confirm each tick', /waitTicked\(card, 800\)/.test(select));
  ok('with the counter before and after', /counterBefore = counterNow\(\)/.test(select) && /counterAfter = counterNow\(\)/.test(select));
  ok('and accepts the counter as proof', /counterAfter - counterBefore >= wanted\.length/.test(select));
  ok('the untick path uses the same ladder', /cornerTarget\(card\)/.test(mod.clearSelectionExpr()));
  ok('the action button is never the header pill', /your referral link/i.test(mod.clickActionExpr()));

  // The clipboard hook must NOT touch the real clipboard: calling the native writeText is what raises Chrome's
  // permission bubble, which a worker cannot click and which steals the page's clicks (2026-11-16).
  const hook = mod.installClipboardHookExpr();
  ok('the clipboard hook keeps the value in the page', /window\.__m1clip = String/.test(hook));
  ok('and never calls the real clipboard', !/original\(text\)/.test(hook) && !/\.bind\(navigator\.clipboard\)/.test(hook));
  ok('answering the page as if the copy succeeded', /return Promise\.resolve\(\)/.test(hook));
  ok('and reading back what was copied', /navigator\.clipboard\.readText/.test(hook));

  // Tickability is decided by the ladder, not by a markup guess.
  ok('the reader accepts an ARIA checkbox', /\[role="checkbox"\], \[aria-checked\]/.test(mod.readAffiliateExpr({ limit: 3 })));
  ok('and so does the page survey', /\[role="checkbox"\], \[aria-checked\]/.test(mod.parkedSurveyExpr()));
  ok('a card with no input is still attempted', !/if \(!box\) \{ missed\.push/.test(select));
}

// ─── A group link has to survive the portal (2026-11-16) ─────────────────────────────────────
//
// The run minted four attributed links and the portal answered "no usable captures": the sanitizer required a job id,
// and a paired link has none — it belongs to the pair, not to one posting.
{
  const { sanitizeAgentCaptures } = await import('../routes/agentRuns.js');
  const kept = sanitizeAgentCaptures([{
    title: 'Spanish Language Expert (LATAM)',
    referralUrl: 'https://refer.micro1.ai/referral/jobs?referralCode=98fb722e&linkId=9c3cf025&utm_source=referral',
    groupId: 'spanish pair',
    sharedWith: ['Spanish Language Expert (Mexico)'],
    attribution: 'param'
  }]);
  eq('a group capture with no job id survives sanitising', kept.length, 1);
  eq('and keeps the pair it belongs to', kept[0].groupId, 'spanish pair');
  eq('and its partner', kept[0].sharedWith[0], 'Spanish Language Expert (Mexico)');
  eq('a capture with neither id nor link is still dropped', sanitizeAgentCaptures([{ title: 'lonely' }]).length, 0);
  eq('and so is one with no title', sanitizeAgentCaptures([{ referralUrl: 'https://x.example' }]).length, 0);
}

{
  const { applyCaptureUpdates } = await import('../utils/browserActor/applyCaptures.js');
  const writes = [];
  // A Supabase builder is chainable: `.eq().eq().is().select()`. The stub has to be, or the compare-and-set path
  // (which filters on the dead value as well as the id) cannot be exercised at all.
  const makeBuilder = (row) => {
    const builder = {
      eq: () => builder,
      is: () => builder,
      select: async () => { writes.push(row); return { data: [{ id: 'o1', title: 'x' }], error: null }; }
    };
    return builder;
  };
  const supabase = { from: () => ({ update: (row) => makeBuilder(row) }) };
  const offers = [{ id: 'o1', title: 'Spanish Language Expert (LATAM)', referral_url: null, external_id: null, description: null }];
  let verifyCalls = 0;
  const result = await applyCaptureUpdates({
    supabase,
    offers,
    captures: [{
      title: 'Spanish Language Expert (LATAM)',
      referralUrl: 'https://refer.micro1.ai/referral/jobs?referralCode=abc&linkId=def',
      groupId: 'spanish pair',
      sharedWith: ['Spanish Language Expert (Mexico)']
    }],
    // A group link cannot pass this; if it is called at all, the group path was missed.
    verify: async () => { verifyCalls += 1; return { ok: false, status: 0 }; }
  });
  eq('a group link is not title-verified', verifyCalls, 0);
  eq('and is written onto the existing offer', result.links.updated, 1);
  ok('with the URL exactly as captured', /referralCode=abc/.test(writes[0]?.referral_url || ''), writes[0]?.referral_url);
  eq('and the verdict says why it was accepted', result.links.verification[0]?.verdict, 'group');

  // Attribution is the check that still applies: a pair link with no code credits nobody.
  const bare = await applyCaptureUpdates({
    supabase,
    offers,
    apply: false,
    captures: [{ title: 'Spanish Language Expert (LATAM)', referralUrl: 'https://refer.micro1.ai/referral/jobs', groupId: 'p' }],
    verify: async () => ({ ok: false })
  });
  eq('a group link with no attribution is refused', bare.links.planned, 0);
  ok('and says why', (bare.links.skipped || []).some((row) => /attribution/.test(row.reason || '')), JSON.stringify(bare.links.skipped));

  // The builder and the listing render the same role differently, and an exact-title join skipped exactly the offers
  // the tenant already holds — the 259 that need links.
  const punctuated = await applyCaptureUpdates({
    supabase,
    offers: [{ id: 'o2', title: 'Ecommerce Data and Catalog Specialist', referral_url: null, external_id: null, description: null }],
    apply: false,
    captures: [{
      title: 'E-commerce Data & Catalog Specialist',
      referralUrl: 'https://refer.micro1.ai/referral/jobs?referralCode=abc',
      groupId: 'commerce pair'
    }],
    verify: async () => ({ ok: false })
  });
  // A link that credits nobody is refused; a link that credits somebody is replaced only if... never. And a row whose
  // URL pays nothing is exactly what this phase exists to replace — the tenant's 259 dead offers (2026-11-16).
  const deadLink = await applyCaptureUpdates({
    supabase,
    offers: [{ id: 'o3', title: 'Spanish Language Expert (Spain)', referral_url: 'https://jobs.micro1.ai/post/aaaabbbbccccdddd', external_id: null, description: null }],
    captures: [{
      title: 'Spanish Language Expert (Spain)',
      referralUrl: 'https://refer.micro1.ai/referral/jobs?referralCode=abc',
      groupId: 'spanish pair'
    }],
    verify: async () => ({ ok: false })
  });
  eq('an unpayable link is replaced with a payable one', deadLink.links.updated, 1);
  eq('and the old value is the compare-and-set', deadLink.links.verification[0]?.replaced, true);

  const liveLink = await applyCaptureUpdates({
    supabase,
    offers: [{ id: 'o4', title: 'Spanish Language Expert (Mexico)', referral_url: 'https://refer.micro1.ai/referral/jobs?referralCode=someone-else', external_id: null, description: null }],
    captures: [{
      title: 'Spanish Language Expert (Mexico)',
      referralUrl: 'https://refer.micro1.ai/referral/jobs?referralCode=abc',
      groupId: 'spanish pair'
    }],
    verify: async () => ({ ok: false })
  });
  eq('a working referral is never overwritten', liveLink.links.planned, 0);
  ok('and says which rule stopped it', (liveLink.links.skipped || []).some((row) => row.reason === 'already_has_link'), JSON.stringify(liveLink.links.skipped));
}

  // A pair of the tenant's own offers survives every layer of the portal (2026-11-16).
  {
    const { titleKey } = await import('../utils/browserActor/tasks/micro1Referrals.js');
    eq('the planner and the attach step share one title key',
      titleKey('E-commerce Data & Catalog Specialist'), titleKey('Ecommerce Data and Catalog Specialist'));
    ok('and different roles do not collide',
      titleKey('Legal Expert (Employment)') !== titleKey('Legal Expert (Antitrust)'),
      `${titleKey('Legal Expert (Employment)')} / ${titleKey('Legal Expert (Antitrust)')}`);
  }

  // The number the business runs on: how many offers can earn, and how the rest fail.
  {
    const { readCoverage } = await import('../utils/browserActor/applyCaptures.js');
    const rows = [
      { id: '1', title: 'Payable', external_id: 'micro1:a', description: 'x'.repeat(400), referral_url: 'https://refer.micro1.ai/referral/jobs?referralCode=abc', deleted_at: null },
      { id: '2', title: 'Dead', external_id: 'micro1:b', description: 'x'.repeat(400), referral_url: 'https://jobs.micro1.ai/post/abcdef', deleted_at: null },
      { id: '3', title: 'Unlinked', external_id: 'micro1:c', description: 'x'.repeat(400), referral_url: null, deleted_at: null },
      { id: '4', title: 'Deleted', external_id: 'micro1:d', description: null, referral_url: null, deleted_at: '2026-01-01' }
    ];
    const supabase = {
      from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) })
    };
    const coverage = await readCoverage(supabase, 'tenant');
    eq('a payable link is counted as payable', coverage.links.payable, 1);
    eq('a link that credits nobody is counted separately', coverage.links.unpayable, 1);
    eq('a role without a link is counted too', coverage.links.unlinked, 1);
    eq('and deleted rows are not counted at all', coverage.links.total, 3);
  }

  /**
   * The popup renders the same cards as the listing, and opening it does not unmount the listing (2026-11-18).
   *
   * A live re-mint run read 84 cards — 72 listing rows with no control, and the popup's rows behind them. The tick took
   * the first title match, which was the listing copy, pressed nothing, and 10 of 12 pairs died as
   * `selection_not_verified`. Two rows that resolved inside the popup ticked fine, which is what made the pattern
   * visible. The fix is to act on the copies inside the fixed-position overlay.
   */
  {
    const mod = await import('../utils/browserActor/tasks/micro1Referrals.js');
    const state = { listingPresses: 0, modalPresses: 0 };

    const makeCard = (title, { box = null, overlay = null } = {}) => ({
      parentElement: overlay,
      outerHTML: `<div data-testid="job-card">${title}</div>`,
      querySelector: (sel) => (sel === 'h2' ? { innerText: title } : (sel === 'input[type="checkbox"]' ? box : null)),
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      scrollIntoView: () => {},
      click: () => { state.listingPresses += 1; }
    });

    // The grid's copy of the role: present, titled, and with nothing to tick.
    const listingCopy = makeCard('Legal Research Attorney');
    // The popup's copy: the same title, inside a fixed overlay, carrying the checkbox.
    const overlay = { parentElement: null, __position: 'fixed' };
    const modalBox = {
      checked: false,
      click() { state.modalPresses += 1; this.checked = true; }
    };
    const popupCopy = makeCard('Legal Research Attorney', { box: modalBox, overlay });

    const document = {
      querySelectorAll(sel) {
        if (sel === '[data-testid="job-card"]') return [listingCopy, popupCopy];
        return [];
      },
      body: { innerText: '0 Roles selected' }
    };
    const window = { getComputedStyle: (node) => ({ position: node?.__position || 'static' }) };
    const location = { href: 'https://refer.micro1.ai/opportunities' };
    const evaluate = async (expression) => JSON.parse(
      await new Function('document', 'window', 'navigator', 'location', `return ${expression};`)(
        document, window, {}, location
      )
    );

    const result = await evaluate(mod.selectRolesExpr({ titles: ['Legal Research Attorney'], settleMs: 0 }));
    eq('the tick presses the popup copy of a role, not the listing copy behind it', state.modalPresses, 1);
    eq('and never presses the listing card', state.listingPresses, 0);
    eq('which is what makes the selection verifiable', result.ok, true);
    eq('and it says how it ticked', result.ticks[0]?.method, 'box');
  }

  // ─── One URL, one opinion (2026-11-18) ────────────────────────────────────────
  //
  // A live offers run reported "imported 23 draft offer(s) (23 with a verified link)" and then 23 × "link skipped …
  // wrong_host" for those same rows: the insert path accepted `jobs.micro1.ai` and the backfill planner judged it against
  // Turing's host. The proof is the difference the source makes.
  {
    const { applyCaptureUpdates } = await import('../utils/browserActor/applyCaptures.js');
    const offer = {
      id: 'm1',
      title: 'Quantitative Rates Researcher',
      referral_url: null,
      external_id: 'micro1:c8cdec0c-76b7-40ae-9764-fb170200408a',
      description: null
    };
    const capture = {
      title: offer.title,
      jobId: 'c8cdec0c-76b7-40ae-9764-fb170200408a',
      externalId: offer.external_id,
      referralUrl: 'https://jobs.micro1.ai/post/c8cdec0c-76b7-40ae-9764-fb170200408a?referralCode=98fb722e&utm_source=referral'
    };
    const writes = [];
    const supabase = {
      from: () => ({
        update: (row) => ({
          eq: () => ({ is: () => ({ select: async () => { writes.push(row); return { data: [{ id: 'm1' }], error: null }; } }) })
        })
      })
    };
    const verify = async () => ({ verdict: 'match' });

    const judgedAsTuring = await applyCaptureUpdates({ supabase, offers: [offer], captures: [capture], verify });
    eq('without a source, a micro1 link is refused by the Turing host rule', judgedAsTuring.links.planned, 0);
    ok('and the refusal is named', (judgedAsTuring.links.skipped || []).some((row) => row.reason === 'wrong_host'),
      JSON.stringify(judgedAsTuring.links.skipped));

    const judgedAsMicro1 = await applyCaptureUpdates({ supabase, offers: [offer], captures: [capture], verify, sourceSlug: 'micro1' });
    eq('with the source, the same link is accepted', judgedAsMicro1.links.planned, 1);
    eq('and written to the offer that had no link', judgedAsMicro1.links.updated, 1);
    eq('a per-role link is stored verbatim', writes[0]?.referral_url, capture.referralUrl);
  }

  /**
   * The popup renders only the rows in view (2026-11-18).
   *
   * The live read found 12 controls for 72 titles it could see, so a pair further down the list has nothing to press
   * until the list is scrolled. Bounded scrolling is the difference between "2 of 12 pairs" and the rest of the popup.
   */
  {
    const mod = await import('../utils/browserActor/tasks/micro1Referrals.js');
    const state = { presses: 0 };
    const overlay = { parentElement: null, __position: 'fixed', scrollTop: 0, scrollHeight: 400, clientHeight: 100 };

    const makeRow = (title) => {
      const box = { checked: false, click() { state.presses += 1; this.checked = true; } };
      return {
        parentElement: overlay,
        outerHTML: `<div data-testid="job-card">${title}</div>`,
        querySelector: (sel) => (sel === 'h2' ? { innerText: title } : (sel === 'input[type="checkbox"]' ? box : null)),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        scrollIntoView: () => {}
      };
    };
    const first = makeRow('Passport Specialist');
    const later = makeRow('Passport Acceptance Agent');

    const document = {
      // Only the rows that have been scrolled into view exist to be found — which is what a rendered list looks like.
      querySelectorAll: (sel) => (sel === '[data-testid="job-card"]'
        ? (overlay.scrollTop > 0 ? [first, later] : [first])
        : []),
      body: { innerText: '0 Roles selected' }
    };
    const window = { getComputedStyle: (node) => ({ position: node?.__position || 'static' }) };
    const evaluate = async (expression) => JSON.parse(
      await new Function('document', 'window', 'navigator', 'location', `return ${expression};`)(
        document, window, {}, { href: 'https://refer.micro1.ai/opportunities' }
      )
    );

    const result = await evaluate(mod.selectRolesExpr({ titles: ['Passport Acceptance Agent'], settleMs: 0 }));
    eq('a role below the fold is scrolled to and ticked', state.presses, 1);
    eq('the scroll actually happened', overlay.scrollTop > 0, true);
    eq('and the pair is verified after scrolling', result.ok, true);
  }

  /**
   * The planner must read the popup, not the listing behind it (2026-11-18).
   *
   * A run reported "Member of Technical Staff, Forward Deployed (US Gov)" as missing: the title was in the tenant's
   * offers and in the listing grid, but not among the popup's rows, so a pair was planned with nothing to tick. Reading
   * every card on the page is what caused it; only the fixed-position overlay is in front of the tenant.
   */
  {
    const mod = await import('../utils/browserActor/tasks/micro1Referrals.js');
    const makeCard = (title, overlay) => ({
      parentElement: overlay,
      innerText: title,
      querySelector: (sel) => (sel === 'h2' ? { innerText: title } : null),
      querySelectorAll: () => []
    });
    const overlay = { parentElement: null, __position: 'fixed' };
    const listingOnly = makeCard('Member of Technical Staff, Forward Deployed (US Gov)', null);
    const popupRow = makeCard('Legal Research Attorney', overlay);
    const window = { getComputedStyle: (node) => ({ position: node?.__position || 'static' }) };
    const location = { href: 'https://refer.micro1.ai/referral/jobs' };
    const read = async (cards) => JSON.parse(await new Function('document', 'window', 'location',
      `return ${mod.readAffiliateExpr({ limit: 10 })};`)({
      querySelectorAll: (sel) => (sel === '[data-testid="job-card"]' ? cards : []),
      body: { innerText: '0 Roles selected' },
      title: 'Your referral link'
    }, window, location));

    const inPopup = await read([listingOnly, popupRow]);
    eq('the reader returns the popup row', inPopup.cards.map((c) => c.title).join('|'), 'Legal Research Attorney');
    eq('and leaves the listing-only title out, so it can never be planned',
      inPopup.cards.some((c) => /Forward Deployed/.test(c.title)), false);

    // With no overlay the page draws its own grid, and every card is in front — the referral dashboard itself.
    const onPage = await read([makeCard('Quantitative Rates Researcher', null)]);
    eq('a page with no popup still reads its grid', onPage.cards.map((c) => c.title).join('|'), 'Quantitative Rates Researcher');
  }

  // A pair that ticked both roles and found no button: the page's own controls are the only useful diagnosis.
  {
    const mod = await import('../utils/browserActor/tasks/micro1Referrals.js');
    const document = {
      querySelectorAll: (sel) => (sel === 'button, [role="button"]'
        ? [{ innerText: 'Close modal', click: () => {} }, { innerText: 'Copy invite link for 2 roles', click: () => {} }]
        : [])
    };
    const action = JSON.parse(await new Function('document', `return ${mod.clickActionExpr()};`)(document));
    eq('a button named in the page is clicked', action.ok, true);
    eq('and its label is reported', action.label, 'Copy invite link for 2 roles');

    const bare = JSON.parse(await new Function('document', `return ${mod.clickActionExpr()};`)({ querySelectorAll: () => [] }));
    eq('with no button the reason is named', bare.reason, 'no_action_button');
    ok('and the controls that were on the page come with it', Array.isArray(bare.labels));
  }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
