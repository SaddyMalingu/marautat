/**
 * Choosing which MoreLogin profile a runner drives (2026-11-13)
 *
 * The policy lives in `utils/browserActor/localProfile.js` and is shared by the tenant worker and the task
 * runners, so this suite is the only place it needs proving. What matters is that it never *guesses*
 * between two plausible profiles: running as the wrong account is the one mistake this subsystem must not
 * make, and a wrong guess is invisible until somebody's data appears under somebody else's name.
 *
 *   node scripts/test_local_profile.mjs
 */
import { chooseLocalProfile, describeProfileChoices, tenantTokens } from '../utils/browserActor/localProfile.js';

let pass = 0;
const failures = [];
function eq(what, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass += 1; return; }
  failures.push(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(what, value, detail) {
  if (value) { pass += 1; return; }
  failures.push(`${what}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

const ada = { envId: '6190000000000001', envName: 'acme-ke', groupName: 'tenants' };
const bob = { envId: '6190000000000002', envName: 'other-client', groupName: 'tenants' };
const plain = { envId: '6190000000000003', envName: null, groupName: null };

// ─── The order: explicit, then one, then the one that names the tenant ───────────────────────
{
  const given = chooseLocalProfile({ items: [ada, bob], explicitEnvId: '6190000000000009', tenantSlug: 'acme' });
  eq('an explicit id is taken as given', given.envId, '6190000000000009');
  eq('and marked as configured', given.why, 'configured');
  eq('it does not need to be in the list', chooseLocalProfile({ items: [], explicitEnvId: ' 42 ' }).envId, '42');

  const none = chooseLocalProfile({ items: [] });
  eq('no profiles is its own answer', none.envId, null);
  eq('and says so', none.why, 'no_profiles');

  const single = chooseLocalProfile({ items: [plain] });
  eq('one profile needs no decision', single.envId, '6190000000000003');
  eq('with a reason', single.why, 'only one profile');

  const named = chooseLocalProfile({ items: [ada, bob], tenantSlug: 'acme' });
  eq('the profile named after the tenant wins', named.envId, '6190000000000001');
  eq('and says why', named.why, 'named after the tenant');
  eq('its label comes along', named.envName, 'acme-ke');
}

// ─── Ambiguity is refused, never resolved by order ──────────────────────────────────────────
{
  const twin = { envId: '6190000000000004', envName: 'acme-ug', groupName: 'tenants' };
  const ambiguous = chooseLocalProfile({ items: [ada, twin], tenantSlug: 'acme' });
  eq('two profiles both naming the tenant is not a choice', ambiguous.envId, null);
  eq('both are offered instead', ambiguous.candidates.length, 2);
  eq('so the person can pick one', ambiguous.why, 'several profiles');

  const unrelated = chooseLocalProfile({ items: [ada, bob], tenantSlug: 'zenith' });
  eq('a tenant with no matching profile is not guessed', unrelated.envId, null);
  eq('and both are listed', unrelated.candidates.length, 2);

  // A slug of short words carries no signal; do not match on "ac".
  const shortSlug = chooseLocalProfile({ items: [ada, bob], tenantSlug: 'ac' });
  eq('a slug with no usable word does not match anything', shortSlug.envId, null);
  eq('tenantTokens keeps only words worth matching', tenantTokens('ac me-ke'), []);
  eq('and keeps the long ones', tenantTokens('acme ke'), ['acme']);
}

// ─── Items without an id are not profiles ───────────────────────────────────────────────────
{
  const junk = chooseLocalProfile({ items: [{ envName: 'broken' }, null, { envId: '' }, ada] });
  eq('an item with no envId is ignored', junk.envId, '6190000000000001');
  eq('and leaves one real candidate', junk.why, 'only one profile');
}

// ─── What a person reads ────────────────────────────────────────────────────────────────────
{
  const mask = (id) => `…${String(id).slice(-4)}`;
  const lines = describeProfileChoices([{ ...ada, running: true }, plain], mask);
  eq('one line per profile', lines.length, 2);
  ok('the name is shown', /"acme-ke"/.test(lines[0]), lines[0]);
  ok('the group is shown', /tenants/.test(lines[0]), lines[0]);
  ok('the id is masked', /…0001/.test(lines[0]) && !/6190000000000001/.test(lines[0]), lines[0]);
  ok('a running profile says so', /\(running\)/.test(lines[0]), lines[0]);
  ok('an unnamed profile has a label', /\(no name\)/.test(lines[1]), lines[1]);

  // The masker is optional: callers that have not imported it still get a readable line.
  const raw = describeProfileChoices([ada]);
  ok('without a masker the id is still shown', /6190000000000001/.test(raw[0]), raw[0]);
  eq('and no line is produced for nothing', describeProfileChoices([]).length, 0);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}
