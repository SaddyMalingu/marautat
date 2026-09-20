// Functional verification: blog page views served from disk must reach analytics
// exactly once. Extracts the REAL middleware text out of server.js so this test
// fails if the ordering or the __pvTracked guard ever regresses.
import http from 'http';
import fs from 'fs';
import path from 'path';
import express from 'express';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---- 1. Source-order assertions against the real server.js ----
const server = fs.readFileSync('server.js', 'utf8');
const iTrack = server.indexOf('// Track blog page views that are served straight from disk.');
const iStatic = server.indexOf("app.use(express.static(publicDir, { index: false }));");
ok('server.js has the static-hook comment', iTrack > -1);
ok('tracking hook is registered BEFORE express.static', iTrack > -1 && iStatic > -1 && iTrack < iStatic,
  'iTrack=' + iTrack + ' iStatic=' + iStatic);
ok('hook sets req.__pvTracked before importing analytics', /req\.__pvTracked = true/.test(server));
ok('/blog/:slug route respects the __pvTracked guard', /if \(!req\.__pvTracked\) \{[\s\S]{0,220}trackPageView\('\/blog\/' \+ cleanSlug, req\)/.test(server));

// ---- 2. Functional test: real middleware + real static + real analytics ----
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url.includes('analytics_page_views') && req.method === 'POST') {
      try { received.push(JSON.parse(body)); } catch (e) { received.push({ parse_error: e.message, body }); }
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// Point the real analytics module at the mock, with a local-looking forwarded IP
// so getLocation() short-circuits without calling ip-api.com.
process.env.SUPABASE_URL = 'http://127.0.0.1:' + mockPort;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
delete process.env.VITE_SUPABASE_URL;
await import('./utils/analytics.js');

// Isolated blog dir with one real post file
const blogDir = path.join(process.cwd(), 'tmp_blog_static_test');
fs.mkdirSync(blogDir, { recursive: true });
fs.writeFileSync(path.join(blogDir, 'test-post.html'), '<h1>Test Post</h1>', 'utf8');

// Extract the real hook source and register it on a replica app
const hookStart = iTrack;
const hookEnd = iStatic;
let hookSrc = server.slice(hookStart, hookEnd);
hookSrc = hookSrc.slice(hookSrc.indexOf('app.use('), hookSrc.lastIndexOf('});') + 3);
ok('extracted real hook source', hookSrc.includes('__pvTracked') && hookSrc.includes('trackPageView'), hookSrc.slice(0, 60));

const app = express();
eval(hookSrc);
app.use(express.static(blogDir, { index: false }));
let routeHits = 0;
app.get('/blog/:slug', async (req, res) => {
  if (!req.__pvTracked) { routeHits++; const { trackPageView } = await import('./utils/analytics.js'); trackPageView('/blog/' + req.params.slug, req); }
  res.send('route');
});

const srv = app.listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const get = (p) => new Promise((resolve) => http.get(base + p, { headers: { 'x-forwarded-for': '127.0.0.1' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }));

const s1 = await get('/blog/test-post.html');
await new Promise(r => setTimeout(r, 400));
ok('static file served 200', s1 === 200, 'status=' + s1);
ok('static-served blog view WAS tracked', received.length === 1, 'inserts=' + received.length);
ok('tracked path strips .html and keeps /blog prefix', received[0]?.page_path === '/blog/test-post', JSON.stringify(received[0]?.page_path));
ok('payload carries geo columns + session key', received[0] && 'country' in received[0] && 'region' in received[0] && 'city' in received[0] && 'session_id' in received[0]);

await get('/blog/test-post.html');
await new Promise(r => setTimeout(r, 400));
ok('second view tracked once (no double count)', received.length === 2, 'inserts=' + received.length);

// File missing on disk -> static calls next() -> route runs; hook already tracked it
const s3 = await get('/blog/missing-post.html');
await new Promise(r => setTimeout(r, 400));
ok('missing post falls through to route', s3 === 200 && routeHits === 0, 'status=' + s3 + ' routeHits=' + routeHits);
ok('missing post counted exactly once', received.length === 3, 'inserts=' + received.length);
ok('no insert recorded for /blog index via this hook', received.every(r => r.page_path !== '/blog'), JSON.stringify(received.map(r => r.page_path)));

srv.close(); mock.close();
fs.rmSync(blogDir, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
