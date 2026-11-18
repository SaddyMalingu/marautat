#!/usr/bin/env node

/**
 * Package a DOP card into the upload layout a task platform expects (2026-11-18).
 *
 * A card in dop/tasks/<id>/ is the evidence, the golden answer, the near misses and
 * the grader. The platform wants a different folder: the prompt and its environment
 * mounted for the model (agent/, files/), the reference answers and the scored steps
 * kept in references/, and the grader NOT next to the question at all — otherwise a
 * model could read the marking script instead of doing the job.
 *
 * This does not invent content. Everything it writes comes from the card:
 *   agent/PROMPT.md        <- question.md
 *   agent/CONTEXT.md       <- generated: the environment, the file map, the output shape
 *   files/                 <- files/ verbatim
 *   references/gold.json   <- answer.json
 *   references/naive_*.json<- naive.json, near-miss-*.json (ticked per step in checks.md)
 *   references/checks.md   <- checks.md
 *   references/bands.json  <- the step ids, points and check kinds, read from grader.mjs
 *   PROVENANCE.md          <- provenance.md, so a reviewer can trace every claim
 *
 * Usage:
 *   node scripts/dop_package.mjs                    # package every card
 *   node scripts/dop_package.mjs 005-trusted-proxy-ip
 *   node scripts/dop_package.mjs --check            # validate, write nothing
 *   node scripts/dop_package.mjs --out=dist/sample  # different destination
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TASKS = path.join(ROOT, 'dop', 'tasks');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = path.resolve(ROOT, outArg ? outArg.slice('--out='.length) : path.join('dist', 'hashlist'));
const only = args.filter((a) => !a.startsWith('--'));

// Nothing in a packaged card may carry a credential, a phone number or a customer.
const REDACTION = [
  { name: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { name: 'M-Pesa / mobile number', re: /(?:\+?254|0)7\d{8}\b/g },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{12,}/g },
  { name: 'provider key', re: /\b(?:sk|gsk|xoxb|ghp|hf)_[A-Za-z0-9]{16,}/g },
  { name: 'Supabase URL', re: /https:\/\/[\w-]+\.supabase\.co/g },
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readText = (file) => fs.readFileSync(file, 'utf8');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push({ full, rel: path.relative(base, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
  }
  return out;
}

/** The answer shape, empty, so the model is told what to write without being told what. */
function shapeOf(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) out[k] = shapeOf(v);
    return out;
  }
  // Keep the type: a string placeholder where a number belongs tells the model to
  // write the wrong type, and a value check then fails for a reason the task never
  // asked it to think about.
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '';
}

function contextDoc(card, files, answer) {
  const rows = files.map((f) => {
    const first = readText(f.full).split('\n').find((l) => l.trim()) || '';
    const summary = first.replace(/\s+/g, ' ').trim().slice(0, 100).replace(/\|/g, '\\|');
    return '| `files/' + f.rel + '` | ' + f.bytes + ' B | ' + summary + ' |';
  }).join('\n');
  return [
    '# Environment',
    '',
    'You are working inside a card taken from a real engineering week. The folder you',
    'have is what the engineer had open at the time — excerpts of the application\'s own',
    'log and the notes taken while reading it. There is no network access and nothing to',
    'install.',
    '',
    '## Files',
    '',
    '| path | size | what it is |',
    '| --- | --- | --- |',
    rows,
    '',
    '## What to produce',
    '',
    'Write your answer to `./answer.json`. Every field must be present:',
    '',
    '```json',
    JSON.stringify(shapeOf(answer), null, 2),
    '```',
    '',
    '## How your answer is scored',
    '',
    'The scored steps and their points are in the task, not in this folder. They are',
    'checked either as **the value you give** or as **whether your sentence says the',
    'thing** — so write plain sentences with the numbers in them. Naming a component',
    'without saying why it is the cause scores low, and so does a fix that would make',
    'the same mistake in a different place.',
    '',
    'Nothing here is a puzzle: every fact you need is in `files/`.',
    '',
  ].join('\n');
}

function provenanceDoc(cardDir, id) {
  const p = path.join(cardDir, 'provenance.md');
  if (!fs.existsSync(p)) {
    return '# Provenance\n\nNo provenance.md in this card. Add one before uploading: a reviewer must be able to trace every claim to a dated commit or log.\n';
  }
  return readText(p);
}


function scanRedaction(files) {
  const hits = [];
  for (const f of files) {
    if (!/\.(md|txt|json|mjs|js)$/i.test(f.full)) continue;
    const body = readText(f.full);
    for (const rule of REDACTION) {
      const m = body.match(rule.re);
      if (m) hits.push(f.rel + ' → ' + rule.name + ' (' + m[0].slice(0, 24) + ')');
    }
  }
  return hits;
}

async function packageCard(id) {
  const cardDir = path.join(TASKS, id);
  const required = ['question.md', 'answer.json', 'naive.json', 'grader.mjs', 'proof.mjs', 'checks.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(cardDir, f)));
  if (missing.length) throw new Error(id + ' is missing ' + missing.join(', '));
  if (!fs.existsSync(path.join(cardDir, 'files'))) throw new Error(id + ' has no files/ directory');

  // 1. The card has to pass its own proof before it is packed. A card whose golden
  //    answer cannot score 1.0, or whose near miss scores like the answer, is not a
  //    product yet.
  const proof = spawnSync(process.execPath, [path.join(cardDir, 'proof.mjs')], { encoding: 'utf8' });
  if (proof.status !== 0) {
    throw new Error(id + ' proof failed:\n' + String(proof.stdout || proof.stderr || '').trim());
  }

  // 2. Read the step bands out of the grader itself, so the reference copy cannot
  //    drift from the thing that actually scores a run.
  const grader = await import(pathToFileURL(path.join(cardDir, 'grader.mjs')).href);
  const STEPS = grader.STEPS || [];
  const TOTAL = grader.TOTAL;
  if (!STEPS.length || !Number.isFinite(TOTAL)) throw new Error(id + ' grader exports no STEPS/TOTAL');

  const answer = readJson(path.join(cardDir, 'answer.json'));
  const nearMisses = fs.readdirSync(cardDir)
    .filter((f) => /^(naive|near-miss-\d+)\.json$/.test(f))
    .sort();
  const scores = Object.fromEntries(
    [['answer.json', answer], ...nearMisses.map((f) => [f, readJson(path.join(cardDir, f))])]
      .map(([f, a]) => [f, grader.grade(a).score])
  );

  const evidence = walk(path.join(cardDir, 'files'));
  const dest = path.join(OUT, id);
  const written = [];

  const write = (rel, body) => {
    const full = path.join(dest, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
    written.push({ full, rel, bytes: Buffer.byteLength(body) });
  };

  if (!checkOnly) {
    fs.rmSync(dest, { recursive: true, force: true });

    // The prompt, as the job arrived. The answer-file request stays: it is how the
    // model is told what to write, and it names no value.
    write('agent/PROMPT.md', readText(path.join(cardDir, 'question.md')));
    write('agent/CONTEXT.md', contextDoc(id, evidence, answer));

    for (const f of evidence) write('files/' + f.rel, readText(f.full));

    write('references/gold.json', JSON.stringify(answer, null, 2) + '\n');
    nearMisses.forEach((f, i) => {
      const label = i === 0 ? 'naive_a' : 'naive_' + String.fromCharCode(97 + i);
      write('references/' + label + '.json', JSON.stringify(readJson(path.join(cardDir, f)), null, 2) + '\n');
    });
    write('references/checks.md', readText(path.join(cardDir, 'checks.md')));
    write('references/bands.json', JSON.stringify({
      task: id,
      points_total: TOTAL,
      steps: STEPS.map((s) => ({ id: s.id, points: s.points, kind: s.kind || 'phrase', expect: s.expect })),
    }, null, 2) + '\n');
    write('PROVENANCE.md', provenanceDoc(cardDir, id));
    write('README.md', packReadme(id));
  }

  // 3. The packaged folder must not contain the marking script, and must not carry
  //    a credential, a phone number or a customer.
  const packaged = checkOnly ? [] : walk(dest);
  const graderLeak = packaged.filter((f) => /grader\.(mjs|js)$/.test(f.rel));
  if (graderLeak.length) throw new Error(id + ': grader was mounted next to the question');
  const redactionHits = scanRedaction(packaged);
  if (redactionHits.length) throw new Error(id + ': redaction scan failed — ' + redactionHits.join('; '));

  const nearMissScores = nearMisses.map((f) => scores[f]);
  const worstNearMiss = nearMissScores.length ? Math.max(...nearMissScores) : 0;
  if (scores['answer.json'] !== 1) throw new Error(id + ': golden is not 1.000');
  if (worstNearMiss >= 0.3) throw new Error(id + ': best near miss is ' + worstNearMiss.toFixed(3) + ' (must be < 0.300)');

  return {
    id,
    steps: STEPS.length,
    points: TOTAL,
    golden: scores['answer.json'],
    near_misses: nearMisses.length,
    best_near_miss: worstNearMiss,
    files: evidence.length,
    packaged_bytes: packaged.reduce((n, f) => n + f.bytes, 0),
    written: written.length,
  };
}

function packReadme(id) {
  return [
    '# ' + id + ' — packaged for upload',
    '',
    'Generated by `npm run dop:package`. Do not edit this folder by hand; edit',
    '`dop/tasks/' + id + '/` and re-run.',
    '',
    '| part | goes to |',
    '| --- | --- |',
    '| `agent/PROMPT.md` | the prompt the model gets |',
    '| `agent/CONTEXT.md` | the environment description |',
    '| `files/` | the files the task needs |',
    '| `references/gold.json` | the golden set answer |',
    '| `references/naive_*.json` | the realistic wrong answers, ticked per step |',
    '| `references/checks.md` | the scored steps, as outcomes with points |',
    '| `references/bands.json` | the same steps as data: id, points, check kind |',
    '| `PROVENANCE.md` | the trace from claim to commit, for the reviewer |',
    '',
    'The grader is deliberately **not** in this folder. It stays in',
    '`dop/tasks/' + id + '/grader.mjs` and is entered in the platform\'s own check',
    'builder, so a model cannot read the marking script.',
    '',
  ].join('\n');
}

const names = fs.existsSync(TASKS)
  ? fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  : [];
const targets = only.length ? only : names;

if (!targets.length) {
  console.error('No cards in dop/tasks/. Nothing to package.');
  process.exit(1);
}

const rows = [];
let failed = 0;
for (const id of targets) {
  try {
    rows.push(await packageCard(id));
  } catch (err) {
    failed++;
    console.log('FAIL  ' + id + '  — ' + String(err.message).split('\n')[0]);
  }
}

if (!checkOnly && rows.length) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    _comment: 'Generated by scripts/dop_package.mjs. One row per packaged card, with the numbers the data-set form asks for: records, files, period, owner.',
    generated: new Date().toISOString().slice(0, 10),
    source: 'dop/tasks',
    tasks: rows,
    totals: {
      tasks: rows.length,
      records: rows.length,
      evidence_files: rows.reduce((n, r) => n + r.files, 0),
      bytes: rows.reduce((n, r) => n + r.packaged_bytes, 0),
      points: rows.reduce((n, r) => n + r.points, 0),
    },
  }, null, 2) + '\n', 'utf8');
}

console.log('');
console.log(checkOnly ? 'DOP package check' : 'DOP package → ' + path.relative(ROOT, OUT));
console.log('');
console.log('  task                            steps  pts  golden  best-naive  files   bytes');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(32) +
    String(r.steps).padStart(4) +
    String(r.points).padStart(5) +
    r.golden.toFixed(3).padStart(8) +
    r.best_near_miss.toFixed(3).padStart(12) +
    String(r.files).padStart(7) +
    String(r.packaged_bytes).padStart(8));
}
console.log('\n' + (rows.length - failed) + '/' + targets.length + ' card(s) packaged' + (failed ? ', ' + failed + ' failed' : ''));
process.exit(failed ? 1 : 0);
