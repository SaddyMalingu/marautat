// Hidden check for DOP-001. Deterministic by construction: it reads one object and
// returns numbers. No network, no clock, no filesystem, no randomness — the same
// answer file must score the same on every run, on any machine.
//
// The slug is deliberately written as a value here and never in question.md: the
// question has to be answerable from ./files, not from the marking script.

const SLUG = 'nvidia/nemotron-3.5-lightning:free';

const text = (v) => String(v == null ? '' : v).toLowerCase();
const inRange = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi;
};

// Each step is an outcome, worth points. A run earns the points of the outcomes it
// reaches; a partial diagnosis therefore scores in the middle instead of zero.
export const STEPS = [
  {
    id: 'culprit',
    points: 3,
    expect: 'names nvidia/nemotron-3.5-lightning:free as the slug the click waited on',
    check: (a) => text(a.culprit).includes(SLUG),
  },
  {
    id: 'zero-bytes',
    points: 2,
    expect: 'says the attempts sent no bytes, rather than returning an error status',
    check: (a) => /(zero|no|0)\s*(bytes|byte)/.test(text(a.evidence)),
  },
  {
    id: '404-vs-silent',
    points: 2,
    expect: 'contrasts the already-handled 404 with a slug that accepts and says nothing',
    check: (a) => {
      const s = text(a.why_it_was_missed);
      return s.includes('404') && /(no bytes|zero bytes|silent|nothing)/.test(s);
    },
  },
  {
    id: 'threshold',
    points: 3,
    expect: 'retires after two empty boxes: not one (a hiccup) and not never',
    check: (a) => Number(a.fix?.retire_after_empty_boxes) === 2,
  },
  {
    id: 'probe',
    points: 2,
    expect: 'the attempt after a strike is a short probe (~8s), not another full timeout',
    check: (a) => inRange(a.fix?.probe_timebox_ms, 7500, 8500),
  },
  {
    id: 'scope',
    points: 2,
    expect: 'the drop lasts for the process and re-probes after a deploy',
    check: (a) => {
      const s = text(a.fix?.scope);
      return /process/.test(s) && !/global|shared|forever/.test(s);
    },
  },
  {
    id: 'trickling',
    points: 3,
    expect: 'keeps a slow upstream that did send bytes out of the strike count',
    check: (a) => {
      const s = text(a.must_not_retire);
      return s.includes('bytes') && /(trickl|slow)/.test(s);
    },
  },
  {
    id: 'does-not-fix',
    points: 2,
    expect: 'says the change only removes the wait; output still needs credits/quota',
    check: (a) => /(credit|quota|billing|key)/.test(text(a.does_not_fix)),
  },
];

export const TOTAL = STEPS.reduce((n, s) => n + s.points, 0);

export function grade(answer) {
  const a = answer && typeof answer === 'object' ? answer : {};
  const steps = STEPS.map((s) => {
    let earned = 0;
    let ok = false;
    try { ok = !!s.check(a); } catch { ok = false; }
    if (ok) earned = s.points;
    return { id: s.id, points: s.points, earned, ok, expect: s.expect };
  });
  const earned = steps.reduce((n, s) => n + s.earned, 0);
  return { earned, total: TOTAL, score: earned / TOTAL, steps, complete: steps.every((s) => s.ok) };
}

// CLI: node grader.mjs <answer.json> — prints the step table, exits 1 if not perfect.
const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('grader.mjs');
if (invoked) {
  const fs = await import('node:fs');
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node grader.mjs <answer.json>');
    process.exit(2);
  }
  const result = grade(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const s of result.steps) {
    console.log((s.ok ? 'PASS' : 'FAIL') + '  ' + String(s.points).padStart(2) + 'pt  ' + s.id +
      (s.ok ? '' : '  <- expected: ' + s.expect));
  }
  console.log('\nscore ' + result.score.toFixed(3) + '  (' + result.earned + '/' + result.total + ' points)');
  process.exit(result.complete ? 0 : 1);
}
