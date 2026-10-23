// Proof for DOP-001. Enforces the contract in dop/README.md on this task:
//   golden = 1.0, every near miss < 0.3, the same answer scores the same three
//   times, the grader is offline-pure, and the question does not hand over the
//   answer's decisive token.
//
// Run: node dop/tasks/001-silent-ai-slug/proof.mjs   (or npm run dop:proof)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade } from './grader.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const readText = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

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
const naive = readJson('naive.json');
const nearMiss2 = readJson('near-miss-2.json');
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

// 2. A capable colleague's first answer must land clearly below the pass mark.
for (const [name, answer] of [['naive.json', naive], ['near-miss-2.json', nearMiss2]]) {
  check(name + ' scores below 0.300', () => {
    const r = grade(answer);
    must(r.score < 0.3, name + ' scored ' + r.score.toFixed(3) + ' — too close to the answer');
    return r.score.toFixed(3);
  });
}

// 3. Same answer, same score: three runs, identical step outcomes. This is what
//    "pin versions, avoid timing and network calls" means in practice.
for (const [name, answer] of [['answer.json', golden], ['naive.json', naive]]) {
  check(name + ' scores identically three times', () => {
    const runs = [grade(answer), grade(answer), grade(answer)].map((r) => JSON.stringify(r));
    must(new Set(runs).size === 1, 'scores drifted between runs');
    return 'stable';
  });
}

// 4. The grader itself must not reach the network, the clock or the environment,
//    so a run tomorrow on another machine cannot differ from this one.
check('grader.mjs is offline-pure', () => {
  const forbidden = /fetch\s*\(|https?:\/\/|Date\.now|Math\.random|process\.env/;
  const hit = graderSource.match(forbidden);
  must(!hit, 'grader.mjs contains ' + (hit && hit[0]) + ' — the score could drift');
  return 'no network, no clock, no env';
});

// 5. Hard to cheat: the prompt must be answerable from ./files, not from the
//    decisive token. Evidence may contain the slug; the question may not.
check('question.md does not leak the decisive values', () => {
  const leaks = ['nvidia/nemotron-3.5-lightning', '8000', 'two empty'].filter((t) =>
    question.toLowerCase().includes(t.toLowerCase()));
  must(leaks.length === 0, 'question.md contains ' + leaks.join(', '));
  return 'clean';
});

// 6. The evidence has to be there for the task to be solvable at all.
check('files/ carries the evidence the question points at', () => {
  const log = readText(path.join('files', 'production-log-2026-10-23.txt'));
  must(/aborted after 13\.1s/.test(log) && /nemotron-3\.5-lightning/.test(log),
    'log excerpt lost the timings or the slug');
  return 'log + provider notes';
});

function table(title, answer) {
  const r = grade(answer);
  console.log('\n' + title + '  →  ' + r.earned + '/' + r.total + '  (' + r.score.toFixed(3) + ')');
  for (const s of r.steps) {
    console.log('  ' + (s.ok ? 'PASS' : 'FAIL') + '  ' + String(s.points).padStart(2) + 'pt  ' + s.id);
  }
}

console.log('');
console.log('DOP-001 · silent AI slug');
console.log('');
table('golden (answer.json)', golden);
table('naive (naive.json)', naive);
table('near miss 2 (near-miss-2.json)', nearMiss2);

console.log('\nSummary: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
