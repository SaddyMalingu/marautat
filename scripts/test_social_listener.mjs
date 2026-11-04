#!/usr/bin/env node

/**
 * The listener, executed rather than grepped (2026-11-04)
 *
 * Why this file exists at all: the first version of `browser_actor_linkedin_listen.mjs` had its
 * `main()` spliced **inside** `postPosts`, with the entry call inside it too. `node --check`
 * passed (the braces balanced), every string assertion in every suite passed, and the script did
 * nothing at all — it defined functions and exited 0. The worker reported "capture exited 0; the
 * run row records the outcome" while the portal showed a run that never called `/context`.
 *
 * So this suite runs the real script against a real (fake) portal and asserts what it *did*:
 *
 *   1. it asks for `/context` at all — the regression that silence cannot pass;
 *   2. it closes the run even when the profile cannot start, so the tenant reads a reason instead
 *      of watching "running" until they cancel.
 *
 * The profile cannot start on this machine (no MoreLogin/ml-cli), which is exactly the case that
 * used to hang. When it *can* start, the same assertions hold: the run still ends.
 *
 * Usage: npm run test:listener
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass += 1; console.log(`PASS  ${label}`); } else { fail += 1; console.log(`FAIL  ${label}`); }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok(label, same);
}

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'browser_actor_social_listen.mjs');

/** A portal that answers the four calls the listener is allowed to make. */
function fakePortal({ queries = 2, platform = 'linkedin' } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = req.url || '';
      calls.push({ method: req.method, url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (url.endsWith('/context')) {
        res.end(JSON.stringify({
          ok: true,
          run: { id: 'r1', status: 'running', platform, limit: queries },
          tenant: { slug: 'malingu-ventures', name: 'Malingu Ventures' },
          // An envId that cannot exist, so the profile start fails fast and deterministically.
          identity: { envId: '000000000000000000', runtime: 'local', source: 'worker' },
          sourceSlug: 'linkedin',
          known: [],
          queries: Array.from({ length: queries }, (_, i) => ({ intentId: 'vehicle_purchase', phrase: `looking for a car ${i}` }))
        }));
        return;
      }
      if (url.endsWith('/signals')) { res.end(JSON.stringify({ ok: true, stored: 1, duplicates: 0, dropped: {} })); return; }
      if (url.endsWith('/progress')) { res.end(JSON.stringify({ ok: true })); return; }
      if (url.endsWith('/finish')) { res.end(JSON.stringify({ ok: true })); return; }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    });
  });
  return {
    calls,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Run the listener to completion, with a ceiling so a hang is a failure, not a hung suite. */
function runListener({ api, platform = 'linkedin', args = [], timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--agent-api', api, '--run-id', 'r1', '--platform', platform, ...args], {
      env: { ...process.env, TENANT_WORKER_TOKEN: 'wkr_test_token' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 'timeout', output });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// ---------------------------------------------------------------------------
// 1. It starts at all: `/context` is the proof
// ---------------------------------------------------------------------------

{
  const portal = fakePortal({ queries: 2 });
  const api = await portal.listen();
  try {
    const result = await runListener({ api, args: ['--queries', '2'] });
    const urls = portal.calls.map((call) => call.url.replace(/^\/api\/agent\/runs\/r1/, ''));
    ok('the listener asked the portal for its context', urls.includes('/context'));
    eq('and asked for it before anything else', urls[0], '/context');
    ok('it reached the context and named the profile', /listen: tenant=malingu-ventures/.test(result.output));
    ok('a run whose profile cannot start is closed, not left running', urls.includes('/finish'));

    const finished = portal.calls.find((call) => call.url.endsWith('/finish'));
    eq('closed as failed', finished?.body?.status, 'failed');
    ok('with a reason the tenant can act on',
      /profile would not start|debug port|MoreLogin/i.test(String(finished?.body?.message || '')));
    eq('and it exits non-zero so the worker knows', result.code === 0, false);
    ok('nothing was posted as a signal, because nothing was read', !urls.includes('/signals'));
  } finally {
    await portal.close();
  }
}

// ---------------------------------------------------------------------------
// 2. A refused context still closes the run
// ---------------------------------------------------------------------------

{
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.statusCode = 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'No browser is mapped to tenant "acme"' }));
  });
  const api = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  try {
    const result = await runListener({ api, args: ['--queries', '1'], timeoutMs: 20_000 });
    ok('a refused context is reported, not swallowed', /context refused/.test(result.output));
    ok('and the run is closed anyway, so the tenant is not stuck',
      calls.some((url) => String(url).endsWith('/finish')));
    eq('with a non-zero exit', result.code === 0, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 3. Every network goes through the same door, and a network we cannot read is refused
// ---------------------------------------------------------------------------

{
  const portal = fakePortal({ queries: 1, platform: 'x' });
  const api = await portal.listen();
  try {
    // X, not LinkedIn: the dispatch has to reach the same script with a different description.
    const result = await runListener({ api, platform: 'x', args: ['--queries', '1'] });
    ok('a run for another network names that network', /platform=x/.test(result.output));
    ok('and still asks the portal for context', portal.calls.some((call) => call.url.endsWith('/context')));
  } finally {
    await portal.close();
  }
}

{
  // The 12:10 run: the worker claimed a YouTube run and the child started the LinkedIn listener.
  // Driving the wrong site under someone else's run is worse than stopping, so it stops.
  const portal = fakePortal({ queries: 1, platform: 'youtube' });
  const api = await portal.listen();
  try {
    const result = await runListener({ api, platform: 'linkedin', args: ['--queries', '1'] });
    const finished = portal.calls.find((call) => call.url.endsWith('/finish'));
    ok('a listener started for the wrong network notices', /this run is for youtube/.test(result.output));
    eq('and closes the run instead of reading the wrong site', finished?.body?.status, 'failed');
    eq('flagging the mismatch on the run', finished?.body?.detail?.mismatch, true);
    eq('with a non-zero exit', result.code === 0, false);
  } finally {
    await portal.close();
  }
}

{
  const portal = fakePortal({ queries: 1 });
  const api = await portal.listen();
  try {
    const result = await runListener({ api, platform: 'myspace', args: ['--queries', '1'], timeoutMs: 15_000 });
    ok('an unknown network is refused outright', /unknown social platform "myspace"/.test(result.output));
    eq('with a non-zero exit', result.code === 0, false);
    eq('and without touching the portal', portal.calls.length, 0);
    ok('naming the networks that do work', /linkedin, x, facebook, reddit, youtube/.test(result.output));
  } finally {
    await portal.close();
  }
}

// ---------------------------------------------------------------------------
// 4. The shape that caused all of this cannot come back
// ---------------------------------------------------------------------------

{
  const source = fs.readFileSync(script, 'utf8');
  const lines = source.split('\n').map((line) => line.replace(/\r$/, ''));
  // The entry call must be a top-level statement, and the last one: that is what "the script
  // does something when run" means. Splicing `main()` inside another function passed every
  // string test and every syntax check, so the shape itself is asserted here.
  const entryAt = lines.findIndex((line) => line.startsWith('main().catch('));
  ok('the entry call is at column 0', entryAt > 0);
  // The entry call ends at the first `});` that returns to column 0 after it.
  const closeAt = lines.findIndex((line, index) => index > entryAt && line === '});');
  ok('and it is closed', closeAt > entryAt);
  const afterEntry = lines.slice(closeAt + 1).filter((line) => line.trim() && !/^(\/\/|\*|\/\*)/.test(line.trim()));
  eq('with nothing after it but a comment or a blank line', afterEntry.length, 0);
  ok('main() is a top-level declaration', /^async function main\(\) \{/m.test(source));
  const nested = lines.filter((line) => /^\s+(async )?function [a-zA-Z]/.test(line));
  eq('no function is declared inside another', nested.length, 0);
  ok('every run-closing path goes through finishOnce', !/\bfinish\(/.test(source.replace(/finishOnce/g, '')));

  // The same shape, for every other runner: one splice was enough to cost a day.
  for (const name of ['browser_actor_referrals.mjs', 'browser_actor_micro1.mjs']) {
    const other = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    const otherLines = other.split('\n').map((line) => line.replace(/\r$/, ''));
    eq(`${name} declares no nested functions`,
      otherLines.filter((line) => /^\s+(async )?function [a-zA-Z]/.test(line)).length, 0);
    ok(`${name} calls its entry point at the top level`,
      otherLines.some((line) => /^(main|run)\(\)\.catch\(/.test(line)));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

