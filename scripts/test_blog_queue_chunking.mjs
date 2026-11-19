// Regression guard for the 2026-11-18 cron failure (2026-11-19).
//
// The cron died with `reading blog_posts: Bad Request — coverage is unknown` and no
// Postgres message, because `.in('opportunity_id', ids)` had grown to 696 uuids — a
// ~25 KB URL that the gateway refused before PostgREST parsed it. The fix reads the
// ids in chunks. This asserts the shape in the real source, the same way
// test_site_hygiene.mjs asserts the real `trust proxy` line: if someone puts the
// single unbounded `.in(...)` back, this fails.
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const src = fs.readFileSync('scripts/blog_queue.mjs', 'utf8');

// 1. The chunk loop exists, with a batch size that can be overridden for a host.
ok('blog_queue reads blog_posts in chunks',
  /for\s*\(\s*let\s+at\s*=\s*0;\s*at\s*<\s*ids\.length;\s*at\s*\+=\s*CHUNK\s*\)/.test(src));
ok('the chunk size is configurable, defaulting to 40',
  /BLOG_QUEUE_IDS_PER_QUERY\s*\|\|\s*40/.test(src));

// 2. The old failure shape must not come back: one `.in(` fed the whole id array.
ok('no unbounded .in(\'opportunity_id\', ids)',
  !/\.in\(\s*'opportunity_id'\s*,\s*ids\s*\)/.test(src));

// 3. The ids are deduped, so a duplicated offer cannot double the URL twice over.
ok('ids are de-duplicated before the read',
  /new Set\(\(offers \|\| \[\]\)\.map\(\(o\) => o\.id\)\.filter\(Boolean\)\)/.test(src));

// 4. A failure must still refuse to plan rather than assume "nothing is written".
ok('a read failure still refuses to plan',
  /coverage is unknown, refusing to plan/.test(src));
ok('the error carries status and the filter sample',
  /postErr\.status/.test(src) && /id\(s\) in this request/.test(src));

// 5. And the probe that separates "list too long" from "column is wrong".
ok('a single-id probe distinguishes size from schema',
  /probing blog_posts/.test(src));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
