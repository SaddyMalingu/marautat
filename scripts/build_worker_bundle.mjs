#!/usr/bin/env node

/**
 * Build the tenant worker zip locally (2026-11-02)
 *
 * The portal serves this from `/tenant/blogger/browser-access/worker-bundle`, so this script
 * exists for the two times you need the file without a tenant session: inspecting what a
 * tenant receives, and handing a pilot one by hand.
 *
 * It writes exactly what the route serves — same builder, same files — because a support
 * artifact that differs from the shipped one is worse than no artifact.
 *
 *   node scripts/build_worker_bundle.mjs --out tmp/alphadome-worker.zip
 *   node scripts/build_worker_bundle.mjs --api https://alphadome.onrender.com --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkerBundle } from '../utils/browserActor/workerBundle.js';
import { listZipEntries } from '../utils/zipStore.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}

const api = String(flag('api', 'https://alphadome.onrender.com')).replace(/\/+$/, '');
const out = path.resolve(String(flag('out', 'tmp/alphadome-worker.zip')));
const listOnly = flag('list', null) !== null;

let built;
try {
  built = buildWorkerBundle({ apiBase: api });
} catch (error) {
  console.error(`could not build the worker: ${error.message}`);
  process.exit(1);
}

if (listOnly) {
  for (const entry of listZipEntries(built.zip)) {
    console.log(`${String(entry.size).padStart(7)}  ${entry.name}`);
  }
  console.log(`\n${built.entries.length} files, ${Math.round(built.bytes / 1024)} kb, portal=${api}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, built.zip);
console.log(`wrote ${out}`);
console.log(`${built.entries.length} files, ${Math.round(built.bytes / 1024)} kb, portal=${api}`);
console.log('nothing secret is inside it: no token, no key, no .env, no node_modules.');
