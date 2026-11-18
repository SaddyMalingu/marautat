// Proof for DOP-004. Enforces the contract in dop/README.md on this task:
//   golden = 1.0, every near miss < 0.3, the same answer scores the same three
//   times, the grader is offline-pure, and the question does not hand over the
//   answer's decisive tokens.
//
// Run: node dop/tasks/004-env-var-spellings/proof.mjs   (or npm run dop:proof)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade } from './grader.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const readText = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

const NEAR_MISSES = ['naive.json', 'near-miss-2.json', 'near-miss-3.json'];

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log('PASS  ' + name + (detail ? '  — ' + detail : ''));
  } catch (err) {
    failed++;
    console.log('FAIL  ' + name + '  — ' + err.message);
  }
}

const must = (cond, message) => { if (!cond) throw new Error(message); };

const golden = readJson('answer.json');
const nearMisses = NEAR_MISSES.map((name) => [name, readJson(name)]);
const graderSource = readText('grader.mjs');
const question = readText('question.md');

// 1. The golden answer must be a full score. A task whose own correct answer
//    cannot score 1.0 has a broken check, not a hard task.
check('golden answer scores 1.000', () => {
  const r = grade(golden);
  must(r.score === 1, 'golden scored ' + r.score.toFixed(3) + '; failing steps: ' +
    r.steps.filter((s) => !s.ok).map((s) => s.id).join(', '));
  return r.earned + '/' + r.total + ' points';
});

// 2. Every capable-colleague answer must land clearly below the pass mark.
for (const [name, answer] of nearMisses) {
  check(name + ' scores below 0.300', () => {
    const r = grade(answer);
    must(r.score < 0.3, name + ' scored ' + r.score.toFixed(3) + ' — too close to the answer');
    return r.score.toFixed(3) + '  (' + r.steps.filter((s) => s.ok).map((s) => s.id).join(', ') + ')';
  });
}

// 3. Same answer, same score: three runs, identical step outcomes.
for (const [name, answer] of [['answer.json', golden], ...nearMisses]) {
  check(name + ' scores identically three times', () => {
    const runs = [grade(answer), grade(answer), grade(answer)].map((r) => JSON.stringify(r));
    must(new Set(runs).size === 1, 'scores drifted between runs');
    return 'stable';
  });
}

// 4. The grader itself must not reach the network, the clock or the environment.
check('grader.mjs is offline-pure', () => {
  const forbidden = /fetch\s*\(|https?:\/\/|Date\.now|Math\.random|process\.env/;
  const hit = graderSource.match(forbidden);
  must(!hit, 'grader.mjs contains ' + (hit && hit[0]) + ' — the score could drift');
  return 'no network, no clock, no env';
});

// 5. Hard to cheat: the prompt must be answerable from ./files, not from the
//    decisive tokens. Evidence may contain them; the question may not.
check('question.md does not leak the decisive values', () => {
  const leaks = ['grok_api_key', 'open_router_api_key', 'keyfrom', 'allowlist', 'resolver']
    .filter((t) => question.toLowerCase().includes(t.toLowerCase()));
  must(leaks.length === 0, 'question.md contains ' + leaks.join(', '));
  return 'clean';
});

// 6. The evidence has to be there for the task to be solvable at all.
check('files/ carries the evidence the question points at', () => {
  const boot = readText(path.join('files', 'boot-log-2026-10-23.txt'));
  must(/openrouter=false/.test(boot) && /groq=false/.test(boot),
    'the boot excerpt lost the two false readings');
  const names = readText(path.join('files', 'render-env-names-2026-10-23.txt'));
  must(/GROK_API_KEY/.test(names) && /OPEN_ROUTER_API_KEY/.test(names) && /GROQ_API_KEY/.test(names),
    'the environment list lost the two spellings or the canonical one that is absent');
  return 'boot line + environment names + prior notes';
});

// 7. The task must still separate answers: golden perfect, best near miss well
//    under half. A task where everything scores alike teaches nothing.
check('the task separates the answer from the near misses', () => {
  const best = Math.max(...nearMisses.map(([, a]) => grade(a).score));
  must(best < 0.5, 'best near miss already at ' + best.toFixed(3));
  return 'golden 1.000 vs best near miss ' + best.toFixed(3);
});

function table(title, answer) {
  const r = grade(answer);
  console.log('\n' + title + '  →  ' + r.earned + '/' + r.total + '  (' + r.score.toFixed(3) + ')');
  for (const s of r.steps) {
    console.log('  ' + (s.ok ? 'PASS' : 'FAIL') + '  ' + String(s.points).padStart(2) + 'pt  ' + s.id);
  }
}

console.log('');
console.log('DOP-004 · keys that are present and unreadable');
console.log('');
table('golden (answer.json)', golden);
for (const [name, answer] of nearMisses) table(name, answer);

console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
