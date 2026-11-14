#!/usr/bin/env node

/**
 * Regenerate the live ChatterApply funnel from the form bundle (2026-11-14)
 *
 * Why: the app prints "Step 14 of 21" while sitting on the Typing Test, and the bundle's step array holds 11
 * screens carrying 22 questions. Read as screens it looked wrong; read as **questions** it matches exactly —
 * 22 minus the Proof-of-Work question this applicant is skipped past = the 21 the page counts.
 *
 * Reading is deliberate: fetch the shell, fetch the one bundle it loads, parse the first `steps:[...]` array
 * by pattern (never eval remote code), and write `utils/browserActor/tasks/chatterApplyFunnel.js`.
 *
 *   node scripts/chatterapply_funnel_map.mjs            # refresh the module
 *   node scripts/chatterapply_funnel_map.mjs --print    # just show the numbered funnel
 */
import fs from 'node:fs';

const FORM = 'https://chatterapply.com/apply/form/';
const OUT = 'utils/browserActor/tasks/chatterApplyFunnel.js';
const printOnly = process.argv.includes('--print');
const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const skipFlag = process.argv.indexOf('--skip');
const SKIPPED = new Set(skipFlag > 0 && process.argv[skipFlag + 1]
  ? String(process.argv[skipFlag + 1]).split(',')
  : ['proofOfWork']);

function matchBracket(source, openAt) {
  const open = source[openAt];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quote = null;
  for (let i = openAt; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) return source.slice(openAt, i + 1); }
  }
  return null;
}

function readQuestion(text, from) {
  const body = matchBracket(text, from) || text.slice(from, from + 300);
  const pick = (re) => (body.match(re) || [])[1] || null;
  const optionsRaw = pick(/options:\[([^\]]*)\]/);
  const validationRaw = pick(/validation:(\{[^}]*\})/);
  let validation = null;
  if (validationRaw) {
    try { validation = JSON.parse(validationRaw.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')); } catch { validation = null; }
  }
  const options = optionsRaw
    ? optionsRaw.split(',').map((o) => o.trim().replace(/^"|"$/g, '')).filter(Boolean)
    : null;
  return {
    id: pick(/id:"([a-zA-Z_]+)"/),
    type: pick(/type:"([a-z_]+)"/),
    label: pick(/label:"((?:[^"\\]|\\.)*)"/),
    description: pick(/description:"((?:[^"\\]|\\.)*)"/),
    required: /required:!0/.test(body),
    ...(options ? { options } : {}),
    ...(validation ? { validation } : {})
  };
}

const shell = await (await fetch(FORM, { headers })).text();
const scriptSrc = (shell.match(/<script[^>]*\ssrc="([^"]+)"/) || [])[1];
if (!scriptSrc) throw new Error('the form shell loaded no script');
const bundleUrl = new URL(scriptSrc, new URL(FORM)).toString();
const bundle = await (await fetch(bundleUrl, { headers })).text();
console.error(`bundle: ${bundleUrl} (${bundle.length} bytes)`);

// Funnel A is the one that starts at the welcome screen — the flow this applicant is in.
const anchor = bundle.indexOf('steps:[{id:"welcome"');
if (anchor < 0) throw new Error('the welcome step array was not found in the bundle');
const literal = matchBracket(bundle, bundle.indexOf('[', anchor));

const screens = [];
for (const screenMatch of literal.matchAll(/\{id:"([a-z_]+)",title:"([^"]*)",questions:\[/g)) {
  const questionsLiteral = matchBracket(literal, screenMatch.index + screenMatch[0].length - 1) || '[]';
  const questions = [];
  for (const questionMatch of questionsLiteral.matchAll(/\{id:"([a-zA-Z_]+)",type:"([a-z_]+)"/g)) {
    const question = readQuestion(questionsLiteral, questionMatch.index);
    if (question.id) questions.push(question);
  }
  screens.push({ id: screenMatch[1], title: screenMatch[2], questions });
}

let number = 0;
const numbered = screens.map((screen) => ({
  ...screen,
  questions: screen.questions.map((question) => {
    if (SKIPPED.has(question.id)) return { ...question, step: null, skipped: true };
    number += 1;
    return { ...question, step: number };
  })
}));

const total = screens.reduce((n, s) => n + s.questions.length, 0);
console.error(`screens: ${numbered.length} · questions: ${total} · displayed steps: ${number}`);

if (printOnly) {
  for (const screen of numbered) {
    console.log(`${screen.id} — ${screen.title}`);
    for (const q of screen.questions) {
      const bits = [q.skipped ? '(skipped)' : `#${q.step}`, q.id, `(${q.type})`,
        q.label ? `"${q.label.slice(0, 60)}"` : '', q.required ? 'required' : 'optional'];
      if (q.options) bits.push(`[${q.options.join('/')}]`);
      if (q.validation) bits.push(JSON.stringify(q.validation));
      console.log('   ' + bits.filter(Boolean).join(' '));
    }
  }
  process.exit(0);
}

const moduleSource = `/**
 * The live ChatterApply funnel, as the app itself numbers it (2026-11-14)
 *
 * The page prints "Step 14 of 21" on the Typing Test, and the bundle's array holds 11 screens carrying 22
 * questions. Read as questions rather than screens it matches exactly: 22 minus the Proof-of-Work question
 * this applicant is skipped past = the 21 the page counts.
 *
 * That is also why the tenant's "step 8: No" looked meaningless — it is the answer to question 8, "Have you
 * worked with OnlyFans before?".
 *
 * Generated by scripts/chatterapply_funnel_map.mjs. Do not hand-edit; re-run that.
 */
export const LIVE_STEP_COUNT = ${number};

export const LIVE_FUNNEL = Object.freeze(${JSON.stringify(numbered, null, 2)});

/** A displayed step -> { screen, question }, or null. */
export function questionByStep(step) {
  const wanted = Number(step);
  for (const screen of LIVE_FUNNEL) {
    for (const question of screen.questions) {
      if (question.step === wanted) return { screen, question };
    }
  }
  return null;
}

/** Every question in display order, skipped ones excluded. */
export function liveQuestions() {
  return LIVE_FUNNEL.flatMap((screen) => screen.questions
    .filter((question) => question.step !== null)
    .map((question) => ({ ...question, screen: screen.id, screenTitle: screen.title })));
}
`;
fs.writeFileSync(OUT, moduleSource, 'utf8');
console.error(`wrote ${OUT}`);

