// Hidden check for DOP-005. Deterministic by construction: it reads one object and
// returns numbers. No network, no clock, no filesystem, no randomness — the same
// answer file must score the same on every run, on any machine.
//
// The setting and its value are written here and never in question.md: the question
// has to be answerable from ./files, not from the marking script.

const SETTING = 'trust proxy';
const HOP = '1';

const text = (v) => String(v == null ? '' : v).toLowerCase();

// Each step is an outcome, worth points. A run earns the points of the outcomes it
// reaches, so a partial diagnosis lands in the middle instead of at zero.
export const STEPS = [
  {
    id: 'proxy-not-visitor',
    points: 2,
    kind: 'phrase',
    expect: 'says the stored ::1 is the in-instance proxy, not the visitor',
    check: (a) => {
      const s = text(a.culprit);
      return /(::1|loopback|localhost)/.test(s) && /(proxy|render|in-instance|reverse)/.test(s);
    },
  },
  {
    id: 'setting-named',
    points: 3,
    kind: 'phrase',
    expect: 'names the setting that decides how the address is resolved',
    check: (a) => text(JSON.stringify(a.fix || {})).includes(SETTING),
  },
  {
    id: 'hop-count',
    points: 3,
    kind: 'value',
    expect: 'gives the value as the hop count of one, not as a boolean',
    check: (a) => {
      const v = text(a.fix?.value).trim();
      if (!v || /true|false|yes|on\b/.test(v)) return false;
      return /^1$|hop count of 1|one hop|1 hop/.test(v);
    },
  },
  {
    id: 'rejects-true',
    points: 3,
    kind: 'phrase',
    expect: 'rejects the boolean form and says why it is unsafe',
    check: (a) => {
      const s = text(a.must_not);
      return /true/.test(s) && /(spoof|forg|leftmost|any hop|client-supplied)/.test(s);
    },
  },
  {
    id: 'ordering',
    points: 2,
    kind: 'phrase',
    expect: 'says the setting must sit before the middlewares that read the address',
    check: (a) => {
      const s = text(a.fix?.ordering);
      return s.includes('before') && /(express\.json|body parser|logger|middleware)/.test(s);
    },
  },
  {
    id: 'silent-symptom',
    points: 2,
    kind: 'phrase',
    expect: 'explains why a wrong-but-well-formed address read as normal for months',
    check: (a) => {
      const s = text(a.why_it_was_missed);
      return /(no error|nothing errored|well-formed|looked|looks|silently|plausible)/.test(s) &&
        /(::1|loopback|local|one place|one city)/.test(s);
    },
  },
  {
    id: 'browser-not-checker',
    points: 2,
    kind: 'phrase',
    expect: 'uses the traffic itself to prove the peer was a person, not a prober',
    check: (a) => {
      const s = text(a.evidence);
      return /(health|checker)/.test(s) && /(media|video|clip|analytics|track-visit)/.test(s);
    },
  },
  {
    id: 'does-not-fix',
    points: 2,
    kind: 'phrase',
    expect: 'says what it cannot identify (VPN, NAT, carrier) and what it leaves broken',
    check: (a) => {
      const s = text(a.does_not_fix);
      return /(vpn|nat|corporate|carrier)/.test(s) && /(favicon|media|bandwidth|40 mb)/.test(s);
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
