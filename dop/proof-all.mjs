// Runs every DOP task's proof. Green here means: each golden answer scores 1.0,
// each near miss stays under 0.3, and every grader is offline-pure and repeatable.
//
// Run: npm run dop:proof

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS = path.join(HERE, 'tasks');

const dirs = fs.existsSync(TASKS)
  ? fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

let failed = 0;
let ran = 0;

for (const name of dirs.sort()) {
  const proof = path.join(TASKS, name, 'proof.mjs');
  if (!fs.existsSync(proof)) {
    console.log('SKIP  ' + name + ' (no proof.mjs)');
    continue;
  }
  console.log('\n=== ' + name + ' ===');
  const r = spawnSync(process.execPath, [proof], { stdio: 'inherit' });
  ran++;
  if (r.status !== 0) failed++;
}

console.log('\nDOP proof: ' + (ran - failed) + '/' + ran + ' task(s) green');
process.exit(failed || !ran ? 1 : 0);
