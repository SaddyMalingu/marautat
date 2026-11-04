import { buildWorkerBundle } from './utils/browserActor/workerBundle.js';

const { entries, bytes } = buildWorkerBundle({ apiBase: 'https://alphadome.onrender.com', pairCode: null });
const find = (name) => entries.find((row) => row.name === name);
const text = (name) => {
  const entry = find(name);
  return entry ? Buffer.from(entry.data).toString('utf8') : '';
};
const listener = text('scripts/browser_actor_linkedin_listen.mjs');
const worker = text('scripts/browser_actor_worker.mjs');
console.log('files', entries.length, 'kb', Math.round(bytes / 1024));
console.log('listener present', listener.length > 1000);
console.log('listener has entry call at column 0', /^main\(\)\.catch\(/m.test(listener));
console.log('listener closes runs through finishOnce', /async function finishOnce/.test(listener) && !/[^e]\bfinish\(/.test(listener.replace(/finishOnce/g, '')));
console.log('listener has no nested function', listener.split('\n').filter((line) => /^\s+(async )?function [a-zA-Z]/.test(line)).length === 0);
console.log('worker refuses a missing runner', /if \(!script \|\| !fs\.existsSync\(script\)\)/.test(worker));
console.log('worker carries the child fault', /lastProblemLine\(tail\)/.test(worker));
