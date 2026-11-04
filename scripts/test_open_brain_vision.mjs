#!/usr/bin/env node

/**
 * Offline contract test for the Open Brain programme (2026-11-04):
 *   docs/forge/ALPHADOME_OPEN_BRAIN_VISION.md  — the narrative plan
 *   docs/forge/open_brain_phases.json          — the machine-readable KPIs
 *
 * Why this exists: the vision's whole selling position is "we show our work".
 * A strategy document that cites code that no longer exists, loses a KPI, or
 * drifts into claims nothing can verify is the exact failure the document warns
 * about (the transcript's "safety theater"). This test treats the plan as code.
 *
 * What it protects against:
 *   1) A phase quietly losing its measurable target, exit criteria or kill
 *      criterion, so "we are on track" becomes unfalsifiable.
 *   2) A `reusable` path being deleted or renamed while the plan still promises
 *      the buyer that capability exists today.
 *   3) Marketing overclaim creeping back in (guaranteed revenue, "AGI achieved").
 *   4) The doc and the JSON drifting apart (a phase in one, missing in the other).
 *   5) Distant horizons losing their entry gate, i.e. being announced instead
 *      of earned.
 *
 * Runs entirely offline — no keys, no database, no network.
 *
 * Usage: npm run test:open-brain-vision
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = path.join(ROOT, 'docs', 'forge', 'ALPHADOME_OPEN_BRAIN_VISION.md');
const JSON_PATH = path.join(ROOT, 'docs', 'forge', 'open_brain_phases.json');

let pass = 0;
let fail = 0;
const failures = [];

const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(chalk.green(`+ ${name}`));
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(chalk.red(`x ${name}${extra ? ' — ' + extra : ''}`));
  }
};

const nonEmpty = (v) => typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) && v.length > 0;
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------------------------------------------------------------------------
// 1. Files and parse
// ---------------------------------------------------------------------------
ok('the vision document exists', fs.existsSync(DOC_PATH), DOC_PATH);
ok('the phase registry exists', fs.existsSync(JSON_PATH), JSON_PATH);

const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
let registry = null;
try {
  registry = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  ok('the registry parses as JSON', true);
} catch (e) {
  ok('the registry parses as JSON', false, e.message);
}

// ---------------------------------------------------------------------------
// 2. Registry shape
// ---------------------------------------------------------------------------
if (registry) {
  ok('the registry names its version', nonEmpty(registry.version));
  ok('the registry is dated (ISO yyyy-mm-dd)', /^\d{4}-\d{2}-\d{2}$/.test(String(registry.as_of || '')));
  ok('the registry points back at the doc', registry.doc === 'docs/forge/ALPHADOME_OPEN_BRAIN_VISION.md');
  ok('the registry states a thesis', nonEmpty(registry.thesis));
  ok('the registry sets a KPI floor per phase', Number(registry.min_kpis_per_phase) >= 3);

  // -------------------------------------------------------------------------
  // 3. Doctrine — every rule must be measurable
  // -------------------------------------------------------------------------
  const doctrine = Array.isArray(registry.doctrine) ? registry.doctrine : [];
  ok('the charter has at least 5 rules', doctrine.length >= 5, `found ${doctrine.length}`);
  ok('every rule has an id, a rule text and a measure',
    doctrine.every((d) => nonEmpty(d.id) && nonEmpty(d.rule) && nonEmpty(d.measure)));
  ok('doctrine ids are unique', new Set(doctrine.map((d) => d.id)).size === doctrine.length);
  ok('every rule is also written in the doc',
    doctrine.every((d) => doc.includes(d.rule)),
    doctrine.filter((d) => !doc.includes(d.rule)).map((d) => d.id).join(', '));
}

// ---------------------------------------------------------------------------
// 4. Near phases — the revenue spine
// ---------------------------------------------------------------------------
const REQUIRED_PHASE_FIELDS = ['target_buyer', 'workflow', 'slice', 'revenue_impact', 'exit_criteria', 'kill_criteria'];
const REQUIRED_PHASE_LISTS = ['reusable', 'risks', 'objectives', 'tasks', 'kpis'];

if (registry && Array.isArray(registry.phases)) {
  const phases = registry.phases;
  ok('there are five near-term phases', phases.length === 5, `found ${phases.length}`);
  ok('phases are ordered P0..P4', phases.map((p) => p.id).join(',') === 'P0,P1,P2,P3,P4',
    phases.map((p) => p.id).join(','));

  for (const p of phases) {
    for (const field of REQUIRED_PHASE_FIELDS) {
      ok(`${p.id} states ${field}`, nonEmpty(p[field]));
    }
    for (const field of REQUIRED_PHASE_LISTS) {
      ok(`${p.id} has ${field}`, nonEmpty(p[field]));
    }
    ok(`${p.id} has ISO start and end dates`,
      /^\d{4}-\d{2}-\d{2}$/.test(p.window?.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(p.window?.end || ''));
    ok(`${p.id} ends after it starts`, new Date(p.window?.end) >= new Date(p.window?.start));

    const kpis = Array.isArray(p.kpis) ? p.kpis : [];
    ok(`${p.id} meets the KPI floor`, kpis.length >= registry.min_kpis_per_phase,
      `${kpis.length} < ${registry.min_kpis_per_phase}`);
    ok(`${p.id} KPIs each carry metric, baseline, target and source`,
      kpis.every((k) => nonEmpty(k.metric) && nonEmpty(k.baseline) && nonEmpty(k.target) && nonEmpty(k.source)));
    ok(`${p.id} KPIs are uniquely identified`, new Set(kpis.map((k) => k.id)).size === kpis.length);

    // The honesty guard: a phase may only promise reusable code that is still here.
    const missing = (p.reusable || []).filter((rel) => !exists(rel));
    ok(`${p.id} reuses only paths that still exist`, missing.length === 0, missing.join(', '));

    ok(`${p.id} appears in the doc by name`, doc.toLowerCase().includes(p.name.toLowerCase()), p.name);
    ok(`${p.id} start date appears in the doc`, doc.includes(p.window.start));
  }

  const starts = phases.map((p) => new Date(p.window.start).getTime());
  ok('phase windows run forwards in time', starts.every((t, i) => i === 0 || t > starts[i - 1]));

  const kpiIds = phases.flatMap((p) => (p.kpis || []).map((k) => k.id));
  ok('KPI ids are globally unique', new Set(kpiIds).size === kpiIds.length);
}

// ---------------------------------------------------------------------------
// 5. Distant horizons — claims must be earned, not announced
// ---------------------------------------------------------------------------
if (registry && Array.isArray(registry.horizons)) {
  const horizons = registry.horizons;
  ok('the distant layer is written as horizons', horizons.length >= 3, `found ${horizons.length}`);
  ok('horizons are ordered by year',
    horizons.every((h, i) => i === 0 || Number(h.year) >= Number(horizons[i - 1].year)));

  for (const h of horizons) {
    ok(`${h.id} names the narration beat it answers`, nonEmpty(h.narration_beat));
    ok(`${h.id} has a translation`, nonEmpty(h.translation));
    ok(`${h.id} has an entry gate`, nonEmpty(h.entry_gate));
    ok(`${h.id} states what it refuses`, nonEmpty(h.refuse));
    ok(`${h.id} states how it earns money`, nonEmpty(h.money));
    ok(`${h.id} appears in the doc by name`, doc.toLowerCase().includes(h.name.toLowerCase()), h.name);
  }
}

// ---------------------------------------------------------------------------
// 6. Refusals — the position is partly what we decline
// ---------------------------------------------------------------------------
if (registry && Array.isArray(registry.refusals)) {
  ok('the programme lists at least six refusals', registry.refusals.length >= 6,
    `found ${registry.refusals.length}`);
}

// ---------------------------------------------------------------------------
// 7. The doc must not overclaim
// ---------------------------------------------------------------------------
const BANNED = [
  'guaranteed revenue',
  'guaranteed return',
  'we have achieved agi',
  'replaces human judgment entirely',
  'fully autonomous money',
];
const composed = doc.toLowerCase();
for (const phrase of BANNED) {
  ok(`the doc avoids the claim "${phrase}"`, !composed.includes(phrase));
}

ok('the doc has no unfinished append marker', !doc.includes('<!-- APPEND -->'));
for (const heading of [
  '## 1. What the narration actually argues',
  '## 2. The vision',
  '## 3. Narration capability → Alphadome translation',
  '## 4. Near future',
  '## 5. Distant future',
  '## 6. The Open Brain Charter',
  '## 8. Risk register',
  '## 12. Next validation step',
]) {
  ok(`the doc keeps the section "${heading}"`, doc.includes(heading));
}
ok('the doc names the runnable proof it depends on', doc.includes('npm run proof:isolation'));
ok('the doc points at this test', doc.includes('npm run test:open-brain-vision'));

// ---------------------------------------------------------------------------
// 8. The test is wired into package.json (otherwise nobody runs it)
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('package.json exposes test:open-brain-vision',
  pkg.scripts && typeof pkg.scripts['test:open-brain-vision'] === 'string',
  'add "test:open-brain-vision": "node scripts/test_open_brain_vision.mjs"');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
if (fail === 0) {
  console.log(chalk.green(`Open Brain vision contract: ${pass} checks passed.`));
  process.exit(0);
}
console.log(chalk.red(`Open Brain vision contract: ${pass} passed, ${fail} failed.`));
for (const f of failures) console.log(chalk.red(`  - ${f}`));
process.exit(1);
