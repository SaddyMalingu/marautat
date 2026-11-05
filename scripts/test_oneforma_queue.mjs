/**
 * OneForma queue ranking (2026-11-05)
 *
 * This is the demo asset, so the tests are the demo: given a contributor's certifications
 * and open projects, the agent must say what to do first and why, and must never do it.
 * The last block is about that boundary — a ranking that grew a `submit` step would be the
 * one change that makes this unusable for a real OneForma demo.
 */
import { rankOneFormaQueue } from '../utils/oneFormaQueue.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail) {
  if (condition) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function cert(overrides) {
  return { name: 'Cert', category: null, questions: null, timeLimit: null, requiredScore: null, lastScore: null, state: 'todo', ...overrides };
}

function project(overrides) {
  return { project: 'Project', category: null, rate: null, status: 'Open', deadline: null, ...overrides };
}

const NOW = new Date('2026-11-05T09:00:00Z');

// ─── A passed certification is not an action ───────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [
      cert({ name: 'Translation Basics', state: 'passed', requiredScore: '60', lastScore: '95' }),
      cert({ name: 'Search Evaluation', state: 'todo', requiredScore: '80' })
    ],
    now: NOW
  });
  eq('the passed certification is not queued', result.actions.length, 1);
  eq('it is reported as why', result.skipped[0].reason, 'already_passed');
  eq('the open certification leads', result.actions[0].title, 'Search Evaluation');
  ok('and the headline names it', /Search Evaluation/.test(result.headline), result.headline);
}

// ─── Finishing beats starting ──────────────────────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [
      cert({ name: 'Fresh One', state: 'todo' }),
      cert({ name: 'Half Done', state: 'in_progress' })
    ],
    now: NOW
  });
  eq('an in-progress certification outranks an untouched one', result.actions[0].title, 'Half Done');
  ok('and says why in terms of cost', /one sitting/.test(result.actions[0].reasons.join(' ')));
}

// ─── A near miss is the cheapest win ───────────────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [
      cert({ name: 'Near Miss', state: 'not_passed', requiredScore: '70', lastScore: '66' }),
      cert({ name: 'Far Off', state: 'not_passed', requiredScore: '90', lastScore: '40' })
    ],
    now: NOW
  });
  eq('a four-point miss leads', result.actions[0].title, 'Near Miss');
  eq('the gap is reported as a number', result.actions[0].gap, 4);
  ok('the reason states both scores',
    /66/.test(result.actions[0].reasons.join(' ')) && /70/.test(result.actions[0].reasons.join(' ')));
  eq('a retake is the action, not a first attempt', result.actions[0].action, 'retake');
  ok('the wide gap still queues', result.actions.some((a) => a.title === 'Far Off'));
}

// ─── Prep is the product ───────────────────────────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [cert({ name: 'Search Evaluation', questions: 40, timeLimit: '60 minutes', requiredScore: '80/100', lastScore: '72/100' })],
    now: NOW
  });
  const prep = result.actions[0].prep.join(' | ');
  ok('prep carries the question count', /40 questions/.test(prep), prep);
  ok('prep converts the time limit to minutes', /60 minutes/.test(prep), prep);
  ok('prep states the pass mark with its denominator', /80\/100/.test(prep), prep);
  ok('prep states the last attempt', /72\/100/.test(prep), prep);
  ok('prep ends with the human pressing the button', /you take the test and submit it/.test(prep), prep);
}

{
  const result = rankOneFormaQueue({ certifications: [cert({ timeLimit: '2 hours', questions: 10 })], now: NOW });
  ok('an hour-denominated limit becomes minutes', /120 minutes/.test(result.actions[0].prep.join(' ')),
    result.actions[0].prep.join(' '));
}



// ─── Projects ──────────────────────────────────────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [],
    projects: [
      project({ project: 'Cheap Work', rate: '18/hr' }),
      project({ project: 'Expensive Work', rate: '120/hr' })
    ],
    now: NOW
  });
  eq('the better-paid project leads', result.actions[0].title, 'Expensive Work');
  eq('the rate is parsed to a number', result.actions[0].rate, 120);
  ok('the reason quotes the rate as published', /120\/hr/.test(result.actions[0].reasons.join(' ')));
}

{
  const result = rankOneFormaQueue({
    certifications: [],
    projects: [project({ project: 'Closing Soon', rate: '20/hr', deadline: '2026-11-06' })],
    now: NOW
  });
  eq('the days left is computed', result.actions[0].daysLeft, 1);
  ok('a closing project says so', /closes in 1 day/.test(result.actions[0].reasons.join(' ')));
}

{
  const result = rankOneFormaQueue({
    certifications: [],
    projects: [project({ project: 'Stale', rate: '20/hr', deadline: '2026-10-01' })],
    now: NOW
  });
  ok('a passed deadline is a warning, not a boost', /deadline has passed/.test(result.actions[0].prep.join(' ')));
  ok('and it does not add urgency points', !/closes in/.test(result.actions[0].reasons.join(' ')));
}

{
  const result = rankOneFormaQueue({ certifications: [], projects: [project({ project: '', rate: '20/hr' })], now: NOW });
  eq('an untitled project is refused', result.actions.length, 0);
  eq('and reported', result.skipped[0].reason, 'untitled_project');
}

// ─── The boundary ──────────────────────────────────────────────────────────
{
  const result = rankOneFormaQueue({
    certifications: [cert({ name: 'Search Evaluation' }), cert({ name: 'Photo Work', state: 'in_progress' })],
    projects: [project({ project: 'Search Relevance', rate: '18/hr' })],
    now: NOW
  });
  // Every action must end with a step a person performs. This is the assertion that keeps
  // the module usable for a real demo: the agent prepares, the human submits.
  const allEndWithHuman = result.actions.every((a) => /^you /.test(a.prep[a.prep.length - 1]));
  ok('every action ends with a step the contributor performs', allEndWithHuman,
    JSON.stringify(result.actions.map((a) => a.prep[a.prep.length - 1])));
  ok('no action carries a submit verdict', result.actions.every((a) => !('submit' in a) && !('submitted' in a)));
  eq('limits still apply to a mixed queue', rankOneFormaQueue({
    certifications: [cert({ name: 'A' }), cert({ name: 'B' })], projects: [], now: NOW, limit: 1
  }).actions.length, 1);
}

{
  const empty = rankOneFormaQueue({ certifications: [], projects: [], now: NOW });
  eq('an empty queue says nothing is queued', empty.actions.length, 0);
  eq('and the headline is honest about it', empty.headline,
    'Nothing to do: every certification is passed and no projects are open');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
