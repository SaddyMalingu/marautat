#!/usr/bin/env node

/**
 * Live AI key check — proves a provider key can *actually answer* before it is
 * deployed to the host.
 *
 * Why this exists (live 2026-10-23): the tier had four keys and none of them
 * could write a word — HuggingFace was out of credits (`402`, retired for the
 * process), Gemini's free tier was out of daily quota (`429` "You exceeded your
 * current quota"), and four of the five OpenRouter free slugs answered `429` /
 * `404`. Every tenant click ended `POST …/review 200 - 30975ms` with
 * "AI tier unavailable — copy unchanged": the code path was correct and the
 * accounts were dry. Rotating a key on Render used to be a guess — the only
 * feedback was the Writers tab or the host log. This script answers the one
 * question that matters *before* the deploy: does this key serve copy, and if
 * not, is it the key, the quota, or the model slug?
 *
 * It drives `ai()` from scripts/blogManager.js — the same walk that serves
 * Writers, Share, Review and WhatsApp replies — with one provider keyed at a
 * time. Nothing here re-implements a request, a model list or an error
 * classifier, so a verdict cannot drift from production (the lesson of
 * `54931a4`: a second copy of the provider list silently greyed out the
 * WhatsApp bot).
 *
 * Usage:
 *   npm run check:ai-key                     # probe every provider that has a key
 *   npm run check:ai-key -- --only=gemini    # probe one provider
 *   npm run check:ai-key -- --key GEMINI_API_KEY=AIza...   # no .env needed
 *   npm run check:ai-key -- --timeout=20000  # per-provider time box (default 30s)
 *
 * Keys are read from the environment, then from `.env` (gitignored), then from
 * `--key`. Exit codes: 0 = at least one provider answered, 1 = none did.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

dotenv.config({ path: path.join(root, '.env'), quiet: true });

// Keep in sync with the PROVIDERS list in scripts/blogManager.js. Only the env
// *names* are repeated here; the request shape, model walk, retirement and
// cooldown logic all come from blogManager.
const PROVIDERS = [
  { name: 'openrouter', label: 'OpenRouter', keys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'] },
  { name: 'gemini', label: 'Gemini', keys: ['GEMINI_API_KEY'] },
  { name: 'groq', label: 'Groq', keys: ['GROQ_API_KEY'] },
  { name: 'cerebras', label: 'Cerebras', keys: ['CEREBRAS_API_KEY'] },
  { name: 'openai', label: 'OpenAI', keys: ['OPENAI_API_KEY'] },
  { name: 'hf', label: 'HuggingFace', keys: ['HF_API_KEY', 'HF_API_KEY_WRITERS_FLOW'] },
];
const ALL_KEY_VARS = PROVIDERS.flatMap((p) => p.keys);

const DEFAULT_PROMPT = 'Reply with exactly one word: OK';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  if (at === -1) return null;
  const next = args[at + 1];
  return next && !next.startsWith('--') ? next : '';
}

const timeoutMs = Number(argValue('timeout')) || 30000;
const prompt = argValue('prompt') || DEFAULT_PROMPT;
const only = (argValue('only') || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// `--key NAME=VALUE` (or `--key=NAME=VALUE`) so a key can be tried without ever
// writing it to a file.
for (let i = 0; i < args.length; i += 1) {
  let pair = null;
  if (args[i].startsWith('--key=')) pair = args[i].slice(6);
  else if (args[i] === '--key' && args[i + 1] && args[i + 1].includes('=')) {
    pair = args[i + 1];
    i += 1;
  }
  if (pair && pair.includes('=')) {
    const [k, ...rest] = pair.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mask = (v) => (v.length <= 8 ? `${v.slice(0, 2)}…` : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`);

function keyFor(p) {
  return p.keys.map((k) => process.env[k]).find((v) => v && String(v).trim());
}

// One provider at a time: the walk reads keys lazily, so clearing the others is
// enough to make it try exactly this key. `value` is passed in because the
// caller already read it — re-reading after the clear would find nothing.
function setOnlyKey(p, value) {
  for (const k of ALL_KEY_VARS) delete process.env[k];
  const v = value || keyFor(p);
  if (v) process.env[p.keys[0]] = v;
}

/** Turn the chain's own error string into the fix a human should apply. */
function hintFor(text) {
  const t = String(text || '');
  if (/no remaining credits|insufficient.*(credit|balance)/i.test(t)) {
    return 'account is out of credits — buy credits or use another provider';
  }
  if (/(^|\D)402(\D|$)/.test(t)) return 'key valid, account out of credits (402) — top up or use another provider';
  if (/(^|\D)(401|403)(\D|$)|unauthor|invalid.*(token|key)|pass a valid api key|api[_ ]?key[_ ]?(not valid|invalid)|not authorized/i.test(t)) {
    return 'key rejected (401/403 or invalid) — regenerate it in the provider console';
  }
  if (/exceeded your current quota|check your plan and billing|RESOURCE_EXHAUSTED/i.test(t)) {
    return 'daily free-tier quota spent — wait for the reset window, add credits, or use another provider';
  }
  if (/rate-limited upstream|too many requests|(^|\D)429(\D|$)/i.test(t)) {
    return 'rate-limited — the key itself is fine, retry in a minute';
  }
  if (/unavailable for free|(^|\D)404(\D|$)/i.test(t)) {
    return 'model slug retired/unknown — not a key problem; the walk advances to the next slug';
  }
  if (/time box|zero bytes|ECONNRESET|ETIMEDOUT|timeout|aborted/i.test(t)) {
    return 'no answer inside the time box — upstream is queueing; the key was never judged';
  }
  if (/no AI provider key configured|cooling down/i.test(t)) return 'no usable key in this process';
  return 'unclassified failure — read the provider body above';
}

const result = { ok: [], failed: [], skipped: [] };
function line(status, text) {
  if (status === 'ok') return chalk.green(`+ ${text}`);
  if (status === 'skip') return chalk.yellow(`- ${text}`);
  return chalk.red(`x ${text}`);
}

// ---------------------------------------------------------------------------
// Probe one provider through the production walk
// ---------------------------------------------------------------------------
// blogManager.js creates a Supabase client at import time. This check never
// touches the DB (ai() only posts to the provider), so satisfy the import with
// placeholders when the local .env has no Supabase credentials.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = process.env.SB_URL || 'http://127.0.0.1:1';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY || 'local-key-check';
}

const { ai, getLastAiError, resetRetiredModels } = await import('./blogManager.js');

console.log(chalk.blue(`i Blog AI keys — probing ${only.length ? only.join(', ') : 'every keyed provider'}`));
for (const p of PROVIDERS) {
  const v = keyFor(p);
  console.log(`  ${p.label.padEnd(12)} ${v ? chalk.green(mask(String(v).trim())) : chalk.gray('(no key)')}`);
}
console.log(chalk.gray(`i one prompt per provider, ${timeoutMs}ms box each, through scripts/blogManager.js ai()`));
console.log('');

const targets = PROVIDERS.filter((p) => !only.length || only.includes(p.name));

for (const p of targets) {
  const value = keyFor(p);
  if (!value) {
    result.skipped.push(p.name);
    console.log(line('skip', `${p.label}: no key — set ${p.keys[0]}`));
    continue;
  }
  setOnlyKey(p, value);
  resetRetiredModels();
  const started = Date.now();
  let out = null;
  let threw = '';
  try {
    out = await ai(prompt, Date.now() + timeoutMs);
  } catch (e) {
    threw = e && e.message ? e.message : String(e);
  }
  const ms = Date.now() - started;
  const error = getLastAiError() || threw || '';
  if (out) {
    result.ok.push({ name: p.name, ms });
    console.log(line('ok', `${p.label}: SERVED in ${(ms / 1000).toFixed(1)}s — ${JSON.stringify(out.slice(0, 40))}`));
  } else {
    result.failed.push({ name: p.name, error });
    console.log(line('fail', `${p.label}: no copy in ${(ms / 1000).toFixed(1)}s`));
    if (error) console.log(chalk.gray(`    chain said: ${error.slice(0, 300)}`));
    console.log(chalk.gray(`    fix: ${hintFor(error)}`));
  }
}

console.log('');
if (result.ok.length) {
  const best = result.ok.slice().sort((a, b) => a.ms - b.ms)[0];
  const p = PROVIDERS.find((x) => x.name === best.name);
  console.log(chalk.green(`Summary: ${result.ok.length}/${targets.length} keyed provider(s) answered copy.`));
  console.log(chalk.green(`Fastest: ${p.label} (${(best.ms / 1000).toFixed(1)}s) via ${p.keys[0]}.`));
  console.log('Next: add that key on Render → Environment, then Manual Deploy (auto-deploy is off),');
  console.log('then click Review on the Writers tab and confirm the response body says mode:"polished".');
  process.exit(0);
}

console.log(chalk.red(`Summary: no keyed provider answered${result.skipped.length ? ` (${result.skipped.length} had no key at all)` : ''}.`));
console.log('');
console.log('Existing key on the host? Render → Environment → reveal the var, then:');
console.log('  npm run check:ai-key -- --only=<provider> --key <VAR>=<value>');
console.log('');
console.log('No key anywhere (docs/MULTITENANT_AI_JOBS_RUNBOOK.md): a Google AI Studio key is');
console.log('free and needs no card — https://aistudio.google.com/apikey');
console.log('  1. create the key in AI Studio');
console.log('  2. put it in .env (gitignored):  GEMINI_API_KEY=AIza...');
console.log('  3. re-run:  npm run check:ai-key -- --only=gemini');
console.log('  4. only after it says SERVED, add the same var on Render → Environment and Manual Deploy');
console.log('');
console.log('Add a second, independent free tier (docs/MULTITENANT_AI_JOBS_RUNBOOK.md):');
console.log('  Groq      https://console.groq.com/keys    -> GROQ_API_KEY     (fastest, rate-limited)');
console.log('  Cerebras  https://cloud.cerebras.ai        -> CEREBRAS_API_KEY (smallest free quota)');
console.log('  Gemini    https://aistudio.google.com/apikey -> GEMINI_API_KEY (daily quota, per project)');
console.log('Each one is another pool: a quota on one is now a detour, not a dry tier.');
console.log('');
console.log(chalk.gray('A quota 429 resets at midnight Pacific (10:00 EAT) and belongs to the Google'));
console.log(chalk.gray('Cloud project, not the key: a new key in the same project changes nothing.'));
process.exit(1);
