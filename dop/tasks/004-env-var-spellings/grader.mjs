// Hidden check for DOP-004. Deterministic by construction: it reads one object and
// returns numbers. No network, no clock, no filesystem, no randomness — the same
// answer file must score the same on every run, on any machine.
//
// The two spellings and the matching rule are written here and never in question.md:
// the question has to be answerable from ./files, not from the marking script.

const INVISIBLE = ['grok_api_key', 'open_router_api_key'];

const text = (v) => String(v == null ? '' : v).toLowerCase();
const list = (v) => (Array.isArray(v) ? v.map((x) => text(x).trim()) : []);

// Each step is an outcome, worth points. A run earns the points of the outcomes it
// reaches, so a partial diagnosis lands in the middle instead of at zero.
export const STEPS = [
  {
    id: 'names-both',
    points: 3,
    kind: 'value',
    expect: 'names both keys the app cannot see, spelled as the host has them',
    check: (a) => {
      const l = list(a.invisible_keys);
      return INVISIBLE.every((n) => l.includes(n));
    },
  },
  {
    id: 'present-not-missing',
    points: 2,
    kind: 'phrase',
    expect: 'says the keys are there with values, so this is not provisioning',
    check: (a) => /\b(present|non-empty)\b|with values?|has a value|\bset\b/.test(text(a.evidence)),
  },
  {
    id: 'silent-absence',
    points: 2,
    kind: 'phrase',
    expect: 'explains why a present key read as missing instead of failing loudly',
    check: (a) => {
      const s = text(a.why_it_was_missed);
      return /(absent|missing|not an error|nothing failed|no error|quietly|silently)/.test(s) &&
        /(boot|log|lookup|two different|differ|disagree)/.test(s);
    },
  },
  {
    id: 'one-place',
    points: 3,
    kind: 'phrase',
    expect: 'puts the name decision in one resolver shared by the walk, the log and the probe',
    check: (a) => {
      const s = text(a.fix?.one_place);
      return /(one|single)\b/.test(s) && /(resolver|helper|function|place|lookup)/.test(s) &&
        /(boot|log|probe|startup)/.test(s);
    },
  },
  {
    id: 'canonical-first',
    points: 2,
    kind: 'value',
    expect: 'tries the preferred spelling first rather than treating all names equally',
    check: (a) => a.fix?.canonical_first === true,
  },
  {
    id: 'exact-not-fuzzy',
    points: 3,
    kind: 'phrase',
    expect: 'accepts an exact allowlist of spellings, not a normalised comparison',
    check: (a) => /(allowlist|exact|explicit|enumerat)/.test(text(a.fix?.match_rule)),
  },
  {
    id: 'probe-names-var',
    points: 2,
    kind: 'phrase',
    expect: 'the probe reports which variable was read, with the value masked',
    check: (a) => {
      const s = text(a.fix?.probe_reports);
      return /(mask|redact)/.test(s) && /(variable|var\b|name)/.test(s);
    },
  },
  {
    id: 'bounded',
    points: 2,
    kind: 'phrase',
    expect: 'rejects fuzzy/lookalike matching and refuses to log the secret',
    check: (a) => {
      const s = text(a.must_not);
      return /(fuzzy|substring|lookalike|prefix)/.test(s) && /(value|secret|log)/.test(s);
    },
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
    return { id: s.id, points: s.points, earned, ok, kind: s.kind, expect: s.expect };
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
