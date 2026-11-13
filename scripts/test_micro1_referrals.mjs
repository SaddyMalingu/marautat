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
  parseRefereeValue
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

{
  eq('the family ignores seniority words', roleFamily('AI Quality Analyst (Personalization) - Hindi'), 'quality');
  eq('an empty title has no family', roleFamily(''), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

