#!/usr/bin/env node

/**
 * Fill the ChatterApply application, then hand the live page to a human (2026-11-13)
 *
 * The whole point is the last part: when this stops, the browser is **still open, still on the step it
 * stopped at**, so the person can take over without starting again. So — unlike every other script in
 * this folder — it does **not** close the profile when it finishes. Closing is opt-in with `--close`.
 *
 * Per step: read the fields on screen, match them to the profile by label, write the ones it
 * recognises, verify each write landed, click Next, verify the page actually moved on. It stops at
 * step 15 (the human's) and in front of the typing test (which measures the applicant, not the
 * machine), and it never clicks anything that submits.
 *
 *   # see what the page asks for and what the profile covers — touches nothing
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --profile ca-profile.json --dry-run
 *
 *   # drive the form, stop before the typing test / step 15
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --profile ca-profile.json
 *
 *   # record the current step's fields (the fast way to build the profile)
 *   node scripts/browser_actor_chatterapply.mjs --tenant malingu-ventures --discover
 *
 * Flags:
 *   --profile <file>   json of profile values keyed by the app's question ids
 *   --set key=value    repeatable; overrides one profile value without editing the file
 *   --list-profiles    print the MoreLogin profiles on this computer, ids masked, and stop
 *   --env-id <id>      drive this profile instead of whatever the portal has mapped to the tenant
 *   --map              read every screen from step 1 and record it to --map-out, typing nothing
 *   --map-out <path>   where --map writes (default tmp_chatterapply/funnel.json)
 *   --map-no-answers   do not even click options; the map stops at the first question that blocks Next
 *   --rewind           press Previous back to step 1 before doing anything else
 *   --discover         read the step on screen, write it to --out, stop (keeps the page open)
 *   --dry-run          read + plan, never fill or click
 *   --include-typing   let the agent take the typing test too (off by default: see chatterApply.js)
 *   --open             navigate to the apply URL first (default: use whatever tab is already there)
 *   --headful          show the browser window
 *   --close            close the MoreLogin profile on exit (default: leave it running and open)
 *   --out <path>       where --discover writes its json (default tmp_chatterapply/step.json)
 */
try { await import('dotenv/config'); } catch { /* the tenant bundle has no node_modules */ }
import fs from 'node:fs';
import path from 'node:path';
import { createMoreloginClient } from '../utils/browserActor/moreloginClient.js';
import { createBrowserRuntime } from '../utils/browserActor/runtime.js';
import { resolveDebugTarget, CdpSession } from '../utils/browserActor/cdp.js';
import { maskEnvId } from '../utils/browserActor/identity.js';
import { resolveRunnerIdentity } from '../utils/tenantRunnerIdentity.js';
import { chooseLocalProfile, describeProfileChoices } from '../utils/browserActor/localProfile.js';
import {
  CHATTER_APPLY,
  describeOutcome,
  fileInputExpr,
  mapFunnel,
  optionPointExpr,
  readStepExpr,
  rewindToStart,
  runApplication
} from '../utils/browserActor/tasks/chatterApply.js';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--')) return argv[at + 1];
  return argv.includes(`--${name}`) ? true : fallback;
}
/** Every `--set key=value`, because one flag can carry only one pair. */
function collectSets() {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--set') continue;
    const pair = argv[i + 1];
    if (!pair || pair.startsWith('--')) continue;
    const at = pair.indexOf('=');
    if (at < 1) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

const tenant = flag('tenant');
const discover = flag('discover', null) !== null;
const dryRun = flag('dry-run', null) !== null;
const includeTyping = flag('include-typing', null) !== null;
const shouldOpen = flag('open', null) !== null;
const closeWhenDone = flag('close', null) !== null;
const headless = flag('headful', null) === null;
const outPath = path.resolve(String(flag('out', 'tmp_chatterapply/step.json')));
const targetUrl = String(flag('url', CHATTER_APPLY.applyUrl));
/** The desk photo the application requires. A path, checked here so a typo fails before the browser. */
const deskPhoto = flag('desk-photo');
const typingWpm = Number(flag('typing-wpm', 70)) || 70;
/** Which profile to drive: given, remembered locally, or discovered from MoreLogin on this machine. */
const explicitEnvId = flag('env-id', process.env.ML_ENV_ID || null);
const listOnly = flag('list-profiles', null) !== null;
/** Read-only funnel mapping: walk to step 1, then read every screen forward and record it. */
const mapOnly = flag('map', null) !== null;
const dumpOnly = flag('dump', null) !== null;
const mapOut = path.resolve(String(flag('map-out', 'tmp_chatterapply/funnel.json')));

if (!tenant && !explicitEnvId && !listOnly) {
  console.error('usage: --tenant <slug> [--profile <file>] [--set key=value]… [--dry-run] [--discover]');
  console.error('       --list-profiles        show the MoreLogin profiles on this computer (ids masked)');
  console.error('       --env-id <profileId>   drive this profile instead of the portal\'s mapping');
  process.exit(1);
}

/** Read the profile: a json file, then `--set` overrides on top, then the desk photo if given. */
function readProfile() {
  const file = flag('profile');
  let base = {};
  if (typeof file === 'string' && file) {
    const resolved = path.resolve(file);
    try {
      base = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (error) {
      console.error(`could not read ${resolved}: ${error.message}`);
      process.exit(1);
    }
  }
  const profile = { ...base, ...collectSets() };
  if (typeof deskPhoto === 'string' && deskPhoto) {
    const resolved = path.resolve(deskPhoto);
    if (!fs.existsSync(resolved)) {
      // Failing here is kinder than failing at the upload screen with the form half done.
      console.error(`--desk-photo not found: ${resolved}`);
      process.exit(1);
    }
    profile.deskPhoto = resolved;
  }
  return profile;
}

/**
 * One CDP round trip. Each call re-resolves the target, which costs a little and buys the thing that
 * matters here: the page surviving a dialog, a frame rebuild or a devtools reconnect mid-form.
 */
async function evaluateJson({ wsUrl = null, host, port, expression, awaitPromise = false }) {
  const target = wsUrl || (await resolveDebugTarget({ host, port })).pageWsUrl;
  const session = await sessionOn(target);
  try {
    const result = await session.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: Boolean(awaitPromise) },
      { timeoutMs: awaitPromise ? 120_000 : 30_000 }
    );
    if (result?.exceptionDetails) {
      const message = result.exceptionDetails.text || 'evaluate threw';
      const detail = result.exceptionDetails.exception?.description || '';
      throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
    }
    const raw = result?.result?.value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } finally {
    session.close();
  }
}

/**
 * Which tab the runner drives, pinned once instead of re-resolved per call.
 *
 * The mapping run of 2026-11-14 exposed this: MoreLogin came back with several tabs open, the script
 * navigated one and then read another, and the "application" it mapped was **Reddit**. Nothing was clicked
 * that mattered only by luck. So the tab is chosen once, by URL, and every later call uses that same
 * target — and if it is not on the site we think, the run stops instead of reading something else.
 */
async function listPageTargets({ host, port }) {
  try {
    const res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
    const list = await res.json();
    return (Array.isArray(list) ? list : [])
      .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      .map((t) => ({ id: t.id, url: String(t.url || ''), wsUrl: t.webSocketDebuggerUrl }));
  } catch {
    return [];
  }
}

/** Prefer a tab already on the target site; otherwise take the first page. */
async function pinPage({ host, port, want = /chatterapply\.com/i }) {
  const pages = await listPageTargets({ host, port });
  const chosen = pages.find((p) => want.test(p.url)) || pages[0] || null;
  return chosen ? { ...chosen, pages } : { wsUrl: null, url: '', pages };
}

async function sessionOn(wsUrl) {
  return CdpSession.open({ wsUrl, timeoutMs: 10_000 });
}

async function navigateTarget({ wsUrl, url }) {
  const session = await sessionOn(wsUrl);
  try {
    await session.send('Page.enable', {}, { timeoutMs: 5_000 });
    await session.send('Page.navigate', { url }, { timeoutMs: 20_000 });
  } finally {
    session.close();
  }
}

/**
 * A click the page cannot ignore.
 *
 * The age screen proved that a dispatched `click` (and a full synthetic pointer sequence) does nothing here:
 * `A Yes` was "clicked", `Next` stayed disabled, the same question returned. `Input.dispatchMouseEvent` goes
 * through the browser's input pipeline, so the page receives the event it would get from a real mouse.
 */
async function trustedClick({ wsUrl, x, y }) {
  const session = await sessionOn(wsUrl);
  try {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, { timeoutMs: 5_000 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, { timeoutMs: 5_000 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, { timeoutMs: 5_000 });
  } finally {
    session.close();
  }
}

/** Click one option by trusted input, and report the label the page offered. */
async function clickOptionTrusted({ wsUrl, choice }) {
  const point = await evaluateJson({ wsUrl, expression: optionPointExpr({ option: choice.option }) });
  if (!point?.ok) return { ok: false, reason: point?.reason || 'option_point_not_found', choice };
  try {
    await trustedClick({ wsUrl, x: point.x, y: point.y });
    return { ok: true, label: point.label, trusted: true, at: { x: point.x, y: point.y } };
  } catch (error) {
    return { ok: false, reason: error?.message || 'trusted_click_failed', choice };
  }
}

/**
 * Everything the frame actually contains, for when the reader and the page disagree.
 *
 * Written after the age screen kept reporting "Are you 18+?" while the step counter advanced: either the app
 * keeps earlier screens mounted, or the reader is picking the wrong element. This answers that in one run.
 */
const DUMP_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const frames = Array.from(document.querySelectorAll('iframe'));
  const frame = frames.find((f) => /apply\\/form|chatterapply/i.test(String(f.getAttribute('src') || '')));
  const doc = frame ? frame.contentDocument : document;
  if (!doc) return JSON.stringify({ ok: false, reason: 'no_document' });
  const vis = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const style = (doc.defaultView || window).getComputedStyle(el);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none');
  };
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, legend'))
    .map((el, i) => ({ i, text: clean(el.innerText || el.textContent).slice(0, 90), visible: vis(el) }))
    .filter((h) => h.text);
  const inputs = Array.from(doc.querySelectorAll('input, select, textarea'))
    .map((el, i) => ({
      i,
      tag: el.tagName.toLowerCase(),
      type: String(el.getAttribute('type') || ''),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      value: clean(el.value).slice(0, 40),
      visible: vis(el)
    }));
  const buttons = Array.from(doc.querySelectorAll('button, [role="button"]'))
    .map((el, i) => ({ i, label: clean(el.innerText || el.textContent).slice(0, 40), visible: vis(el), disabled: el.disabled === true }))
    .filter((b) => b.label);
  return JSON.stringify({
    ok: true,
    frameSrc: frame ? String(frame.getAttribute('src')) : null,
    frameRect: frame ? frame.getBoundingClientRect().toJSON() : null,
    readyState: doc.readyState,
    bodyChars: String(doc.body ? doc.body.innerText : '').length,
    headings,
    inputs,
    buttons,
    // What is actually on top at each button's centre — the difference between "the click missed" and
    // "something is covering the button".
    buttonHitTest: Array.from(doc.querySelectorAll('button, [role="button"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = doc.elementFromPoint ? doc.elementFromPoint(cx, cy) : null;
      return {
        label: clean(el.innerText || el.textContent).slice(0, 30),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitText: hit ? clean(hit.innerText || hit.textContent).slice(0, 40) : null,
        hitIsButton: hit === el,
        hitInside: Boolean(hit && el.contains && el.contains(hit))
      };
    }),
    stepMarkers: Array.from(doc.querySelectorAll('[class*="step"], [data-step], [aria-current]'))
      .slice(0, 12)
      .map((el) => ({ tag: el.tagName.toLowerCase(), text: clean(el.innerText || el.textContent).slice(0, 40) }))
  });
})()`;

async function urlOfTarget({ wsUrl }) {
  const session = await sessionOn(wsUrl);
  try {
    const result = await session.send(
      'Runtime.evaluate',
      { expression: 'String(location.href)', returnByValue: true },
      { timeoutMs: 5_000 }
    );
    return String(result?.result?.value || '');
  } catch {
    return '';
  } finally {
    session.close();
  }
}


/**
 * Attach a real file to the form's file input.
 *
 * A file input's value cannot be set from page script at all, so this is the one place the runner needs
 * more than `Runtime.evaluate`: the element is located by expression, handed over as an objectId, and the
 * browser protocol puts the file into it. `change` then fires exactly as it does for a human, which is
 * what react-dropzone listens for.
 */
async function attachFile({ wsUrl = null, host, port, upload }) {
  const target = wsUrl || (await resolveDebugTarget({ host, port })).pageWsUrl;
  const session = await sessionOn(target);
  try {
    const located = await session.send(
      'Runtime.evaluate',
      { expression: fileInputExpr({ name: upload.name, id: upload.id }), returnByValue: false },
      { timeoutMs: 10_000 }
    );
    const objectId = located?.result?.objectId;
    if (!objectId) return { ok: false, detail: 'no_file_input_on_page' };

    await session.send('DOM.setFileInputFiles', { files: [upload.path], objectId }, { timeoutMs: 20_000 });

    // Proven, not assumed: ask the element itself how many files it now holds.
    const check = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { return this.files ? this.files.length : 0; }',
      returnByValue: true
    }, { timeoutMs: 5_000 });
    const count = check?.result?.value;
    console.error(`  attached ${path.basename(upload.path)} -> ${upload.label || upload.name || 'file input'} (${count} file(s))`);
    return { ok: Number(count) > 0, files: count ?? null, detail: Number(count) > 0 ? null : 'file_not_held' };
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  } finally {
    session.close();
  }
}

/**
 * Wait until the form has actually **rendered**, not merely until a frame exists.
 *
 * The first live run (2026-11-14) proved the frame is same-origin and readable — and returned an empty
 * snapshot, because the iframe's document had a `<body>` but the React app had not mounted yet. "A frame
 * with a body" is not "a form", so readiness now requires content: fields, headings, or real text.
 */
function formRendered(snapshot) {
  if (!snapshot?.ok) return false;
  const fields = (snapshot.fields || []).length;
  const headings = (snapshot.headings || []).length;
  const text = String(snapshot.text || '').trim().length;
  return fields > 0 || headings > 0 || text > 20;
}

/** What the top document's frames look like, for when nothing renders. */
const FRAME_DIAGNOSTIC_EXPR = `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    readyState: document.readyState,
    title: clean(document.title),
    topText: clean(document.body ? document.body.innerText : '').slice(0, 160),
    frames: Array.from(document.querySelectorAll('iframe')).map((frame) => {
      let readable = false;
      let bodyChars = 0;
      let title = null;
      try {
        const doc = frame.contentDocument;
        readable = Boolean(doc);
        bodyChars = doc && doc.body ? String(doc.body.innerText || '').length : 0;
        title = doc ? doc.title : null;
      } catch (error) {
        readable = false;
      }
      return { src: String(frame.getAttribute('src') || ''), readable, bodyChars, title };
    })
  });
})()`;

async function waitForForm({ wsUrl, maxMs = 45_000 }) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < maxMs) {
    last = await evaluateJson({ wsUrl, expression: readStepExpr({ includeValues: false }) });
    // Cross-origin will never become readable by waiting: stop at once and say why.
    if (last?.reason === 'cross_origin_frame') return { ok: false, reason: 'cross_origin_frame', snapshot: last };
    if (formRendered(last)) return { ok: true, waitedMs: Date.now() - startedAt, snapshot: last };
    await new Promise((r) => setTimeout(r, 750));
  }
  return { ok: false, reason: 'form_rendered_nothing', waitedMs: Date.now() - startedAt, snapshot: last };
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}


/**
 * Which browser to drive, answered by the machine when the portal cannot answer.
 *
 * `resolveRunnerIdentity` is the right first question — it knows about a sealed key, a hosted map and what
 * a previous worker reported. But on a laptop where MoreLogin already holds the key, it refuses
 * (`profile_unmapped`) while the answer is one `ml-cli env list` away. So the fallback is the same policy
 * the worker uses: explicit id → ask MoreLogin → single/named profile wins → otherwise show the list.
 */
async function resolveIdentity() {
  const explicit = typeof explicitEnvId === 'string' ? explicitEnvId.trim() : '';
  const localRuntime = () => createBrowserRuntime({ client: createMoreloginClient({}) });

  if (listOnly) {
    const listed = await localRuntime().listProfiles({ pageNo: 1, pageSize: 50 });
    const items = (listed.items || []).filter((item) => item.envId);
    console.log(JSON.stringify({
      ok: true,
      count: items.length,
      profiles: items.map((item) => ({
        envId: maskEnvId(String(item.envId)),
        envName: item.envName || null,
        groupName: item.groupName || null,
        running: Boolean(item.running)
      })),
      note: 'Ids are masked. Use --env-id <id> with the full value from the MoreLogin app; nobody needs to paste it here.'
    }, null, 2));
    return null;
  }

  if (explicit) {
    return { envId: explicit, runtime: 'local', apiKey: null, label: null, source: 'configured' };
  }

  try {
    return await resolveRunnerIdentity({ tenantSlug: tenant });
  } catch (error) {
    if (error?.code !== 'profile_unmapped' && error?.type !== 'profile_unmapped') throw error;
    console.error(`the portal has no browser mapped to "${tenant}" — asking MoreLogin on this computer`);
  }

  const listed = await localRuntime().listProfiles({ pageNo: 1, pageSize: 50 });
  const items = (listed.items || []).filter((item) => item.envId);
  const choice = chooseLocalProfile({ items, tenantSlug: tenant });
  if (!choice.envId) {
    console.error(choice.why === 'no_profiles'
      ? 'MoreLogin is running but has no profiles here — create one and sign in inside it.'
      : `MoreLogin has ${items.length} profiles here, so I cannot tell which is yours:`);
    for (const line of describeProfileChoices(items, maskEnvId)) console.error(line);
    console.error('Re-run with the one you use: --env-id <profileId>');
    return null;
  }
  console.error(`using ${choice.envName ? `"${choice.envName}" ` : ''}${maskEnvId(choice.envId)} (${choice.why})`);
  return { envId: choice.envId, runtime: 'local', apiKey: null, label: choice.envName, source: 'local-discovery' };
}

async function main() {
  const profile = readProfile();
  const identity = await resolveIdentity();
  if (!identity) return;
  console.error(`tenant=${tenant || '(none)'} profile=${maskEnvId(identity.envId)} source=${identity.source} headless=${headless}`);

  const runtime = createBrowserRuntime({
    client: createMoreloginClient(identity.apiKey ? { apiKey: identity.apiKey } : {})
  });
  const started = await runtime.startProfile(identity.envId, { runtime: identity.runtime, headless });
  if (!started.debugPort) {
    console.error(`profile not ready (status=${started.status}); retry shortly`);
    process.exit(1);
  }
  console.error(`attached on port ${started.debugPort}`);
  const connection = { host: started.host, port: started.debugPort };

  let outcome = null;
  let leaveOpen = false;
  try {
    // Pin the tab first. Re-resolving the target per call is what let the mapping run navigate one tab and
    // read another — and then report Reddit as the application form.
    let page = await pinPage(connection);
    console.error(`tab: ${page.url || '(none)'}${page.pages.length > 1 ? ` (${page.pages.length} tabs open)` : ''}`);
    if (!page.wsUrl) {
      outcome = { ok: false, reason: 'no_tab', detail: 'the profile has no page target', keepOpen: true };
      leaveOpen = true;
      writeJson(outPath, { outcome });
      console.log(JSON.stringify({ ...outcome, out: outPath }, null, 2));
      return;
    }

    const onTarget = /chatterapply\.com/i.test(page.url);
    if (shouldOpen || !onTarget) {
      // Navigating destroys a half-filled form, so it happens only when the tab is elsewhere or asked for.
      console.error(`opening ${targetUrl} (the form itself is an iframe inside this page)`);
      await navigateTarget({ wsUrl: page.wsUrl, url: targetUrl });
      await new Promise((r) => setTimeout(r, 2500));
      const again = await pinPage(connection);
      page = again.wsUrl ? { ...again } : page;
    } else {
      console.error('reusing the tab that is already on the form — no navigation, so nothing is lost');
    }

    // Prove it, once, before anything is read or clicked.
    let liveUrl = await urlOfTarget({ wsUrl: page.wsUrl });
    if (!/chatterapply\.com/i.test(liveUrl)) {
      const repinned = await pinPage(connection);
      if (repinned.wsUrl && repinned.wsUrl !== page.wsUrl) {
        page = repinned;
        liveUrl = await urlOfTarget({ wsUrl: page.wsUrl });
      }
    }
    if (!/chatterapply\.com/i.test(liveUrl)) {
      outcome = {
        ok: false,
        reason: 'wrong_tab',
        detail: 'the pinned tab is not on chatterapply.com, so nothing was read or clicked',
        liveUrl,
        tabs: page.pages.map((p) => p.url).slice(0, 8),
        keepOpen: true
      };
      leaveOpen = true;
      writeJson(outPath, { outcome });
      console.log(JSON.stringify({ ...outcome, out: outPath }, null, 2));
      return;
    }
    console.error(`driving tab ${liveUrl}`);

    const ready = await waitForForm({ wsUrl: page.wsUrl, maxMs: 45_000 });
    if (!ready.ok) {
      // Say what the frames actually look like: "rendered nothing" is not actionable on its own.
      let diagnostic = null;
      try { diagnostic = await evaluateJson({ wsUrl: page.wsUrl, expression: FRAME_DIAGNOSTIC_EXPR }); } catch { /* best effort */ }
      outcome = {
        ok: false,
        reason: ready.reason,
        waitedMs: ready.waitedMs ?? null,
        detail: ready.snapshot?.detail || null,
        frameSrc: ready.snapshot?.frameSrc || null,
        diagnostic,
        keepOpen: true
      };
      leaveOpen = true;
      writeJson(outPath, { outcome, snapshot: ready.snapshot || null });
      console.log(JSON.stringify({ ...outcome, out: outPath }, null, 2));
      return;
    }
    console.error(`form rendered after ${ready.waitedMs}ms (mode=${ready.snapshot.mode || 'n/a'})`);

    if (discover) {
      writeJson(outPath, { when: new Date().toISOString(), url: targetUrl, snapshot: ready.snapshot });
      leaveOpen = true;
      console.log(JSON.stringify({
        ok: true,
        discovered: outPath,
        step: ready.snapshot.step,
        headings: ready.snapshot.headings,
        fields: (ready.snapshot.fields || []).map((f) => ({
          label: f.label, name: f.name, type: f.type, required: f.required, options: f.options
        })),
        buttons: (ready.snapshot.buttons || []).map((b) => b.label),
        keepOpen: true
      }, null, 2));
      return;
    }

    if (dumpOnly) {
      // What the page really contains, when the reader and the page disagree.
      const dump = await evaluateJson({ wsUrl: page.wsUrl, expression: DUMP_EXPR });
      const domOut = mapOut.replace(/funnel\.json$/i, 'dom.json');
      writeJson(domOut, { when: new Date().toISOString(), dump });
      leaveOpen = true;
      console.log(JSON.stringify({ ok: Boolean(dump?.ok), dom: domOut, dump }, null, 2));
      return;
    }

    if (mapOnly) {
      // Read every screen and record it. Nothing is typed; the only clicks are Next and, where the app
      // refuses to move without one, the answer already in the profile.
      const back = await rewindToStart({
        evaluate: (expression) => evaluateJson({ wsUrl: page.wsUrl, expression }),
        log: (entry) => console.error(`  rewind ${entry.from ?? '?'} — "${entry.button}"`)
      });
      console.error(`rewind: ${back.ok ? (back.pressed ? `back at step ${back.at ?? '?'}` : `already at ${back.at ?? 'the first screen'}`) : back.reason} after ${back.pressed} press(es)`);

      const mapped = await mapFunnel({
        evaluate: (expression, options = {}) => evaluateJson({ wsUrl: page.wsUrl, expression, ...options }),
        clickOption: (choice) => clickOptionTrusted({ wsUrl: page.wsUrl, choice }),
        profile,
        options: { includeTyping, typingWpm, answerChoices: flag('map-no-answers', null) === null },
        log: (entry) => console.error(
          `  map${entry.step ? ` step ${entry.step}` : ''}`
          + `${entry.heading ? ` "${entry.heading}"` : ''}`
          + `${entry.fields !== undefined ? ` · ${entry.fields} field(s)` : ''}`
          + `${entry.buttons ? ` · ${entry.buttons.join(' | ')}` : ''}`
          + `${entry.options ? ` · chose ${entry.options.join(',')}` : ''}`
        )
      });

      writeJson(mapOut, {
        when: new Date().toISOString(),
        url: targetUrl,
        rewind: back,
        result: { ok: mapped.ok, reason: mapped.reason || null, at: mapped.at ?? null, detail: mapped.detail || null },
        stepCount: mapped.steps.length,
        steps: mapped.steps
      });
      leaveOpen = true;
      console.log(JSON.stringify({
        ok: mapped.ok,
        mapped: mapOut,
        stepCount: mapped.steps.length,
        stopped: { reason: mapped.reason || null, at: mapped.at ?? null, detail: mapped.detail || null },
        screens: mapped.steps.map((s) => ({
          step: s.step,
          heading: s.heading,
          fields: s.fields.length,
          fieldLabels: s.fields.map((f) => f.label || f.name || f.type).slice(0, 6),
          buttons: s.buttons.map((b) => b.label),
          advancedBy: s.advancedBy
        })),
        keepOpen: true
      }, null, 2));
      return;
    }

    outcome = await runApplication({
      // `awaitPromise` matters for the typing pass, which paces keystrokes over real time.
      evaluate: (expression, options = {}) => evaluateJson({ wsUrl: page.wsUrl, expression, ...options }),
      attachFile: (upload) => attachFile({ wsUrl: page.wsUrl, upload }),
      clickOption: (choice) => clickOptionTrusted({ wsUrl: page.wsUrl, choice }),
      profile,
      options: {
        dryRun,
        includeTyping,
        typingWpm
      },
      log: (entry) => console.error(
        `  ${entry.event}${entry.step ? ` step ${entry.step}` : ''}${entry.screen ? ` [${entry.screen}]` : ''}`
        + ` — ${entry.action || entry.reason || ''}`
        + `${entry.button ? ` "${entry.button}"` : ''}`
        + `${entry.applied ? ` (+${entry.applied})` : ''}`
        + `${entry.picked ? ` (${entry.picked}/${entry.total} chosen)` : ''}`
        + `${entry.attached ? ` (${entry.attached}/${entry.total} attached)` : ''}`
        + `${entry.moved === false ? ' (did not move)' : ''}`
      )
    });
    leaveOpen = outcome.keepOpen !== false;

    writeJson(outPath, { when: new Date().toISOString(), url: targetUrl, profileKeys: Object.keys(profile), outcome });
    console.log(JSON.stringify({
      ok: outcome.ok,
      handoff: Boolean(outcome.handoff),
      stoppedAt: outcome.step ?? null,
      reason: outcome.reason || null,
      message: describeOutcome(outcome),
      steps: (outcome.steps || []).map((s) => ({
        step: s.step,
        heading: (s.headings || [])[0] || null,
        fields: (s.fields || []).length,
        filled: (s.planned || []).length,
        unresolved: (s.unresolved || []).map((u) => u.label)
      })),
      needsValues: outcome.needsValues || [],
      failures: outcome.failures || [],
      transcript: outPath,
      keepOpen: leaveOpen
    }, null, 2));
  } finally {
    if (closeWhenDone) {
      try { await runtime.closeProfile(identity.envId); } catch { /* already gone */ }
      console.error('profile closed (--close)');
    } else {
      console.error(leaveOpen
        ? 'browser left OPEN on purpose — take over from here, and close the profile yourself when done.'
        : 'browser left open; pass --close to shut the profile down when the run ends.');
    }
  }
}

main().catch((error) => {
  console.error(`failed: ${error?.message || error}`);
  process.exit(1);
});

