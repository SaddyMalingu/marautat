// Functional verification: a real visitor must not be recorded as ::1, and
// /favicon.ico must not answer 404 on a demo visit.
//
// Evidence (Render log, 2026-10-24T03:54-03:55):
//   [PAGE] Landing page loaded by ::1 at 2026-10-24T03:55:36.216Z
//   ... 40 MB of range requests + POST /api/kassangas/track-visit from the same peer
// A health checker does not fetch ten videos and POST analytics: that peer was a
// browser, so every visitor's `ip`/`source_ip` column read ::1. The fix is one
// `app.set('trust proxy', 1)`; this test extracts the REAL line and the REAL
// /favicon.ico handler out of server.js and exercises both over HTTP, so it fails
// if either is removed, weakened to `true` (spoofable), or reordered after the
// request logger.
import http from 'http';
import fs from 'fs';
import path from 'path';
import express from 'express';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---- 1. Source assertions against the real server.js ----
const server = fs.readFileSync('server.js', 'utf8');

const trustLine = (server.match(/^app\.set\('trust proxy', [^)]+\);$/m) || [])[0] || '';
ok('server.js sets trust proxy', trustLine.length > 0);
ok('trust proxy is the literal hop count 1, not `true`',
  /^app\.set\('trust proxy', 1\);$/.test(trustLine), trustLine);

const iTrust = trustLine ? server.indexOf(trustLine) : -1;
const iJson = server.indexOf('app.use(express.json(');
const iLogger = server.search(/app\.use\(\(req, res, next\) => \{\r?\n\s*const start = Date\.now\(\);/);
ok('trust proxy is set before express.json() parses the first body',
  iTrust > -1 && iJson > -1 && iTrust < iJson, 'trust=' + iTrust + ' json=' + iJson);
ok('trust proxy is set before the request logger writes req.ip',
  iTrust > -1 && iLogger > -1 && iTrust < iLogger, 'trust=' + iTrust + ' logger=' + iLogger);

const iFav = server.indexOf("app.get('/favicon.ico'");
ok('server.js answers /favicon.ico instead of letting express.static 404 it', iFav > -1);
const favClose = iFav > -1 ? server.slice(iFav).search(/\r?\n\}\);\r?\n/) : -1;
const favSrc = iFav > -1 && favClose > -1 ? server.slice(iFav, iFav + favClose + 5) : '';
ok('favicon handler sends the brand mark with a cache header',
  /favicon\.svg/.test(favSrc) && /Cache-Control/.test(favSrc), favSrc.split(/\r?\n/)[0] || 'handler not found');

const faviconFile = path.join('public', 'favicon.svg');
ok('public/favicon.svg exists and is an SVG', fs.existsSync(faviconFile) && fs.readFileSync(faviconFile, 'utf8').trimStart().startsWith('<svg'));
ok('favicon.svg stays small enough to fetch on every first visit',
  fs.existsSync(faviconFile) && fs.statSync(faviconFile).size < 4096,
  fs.existsSync(faviconFile) ? fs.statSync(faviconFile).size + ' bytes' : 'missing');

const indexHtml = fs.readFileSync('index.html', 'utf8');
ok('landing page declares the icon, so a browser never even asks for /favicon.ico',
  /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/.test(indexHtml));

// ---- 2. Functional: the real trust-proxy line resolves the forwarded client ----
// Both handlers are wrapped the same way server.js uses them, inside a scope that
// owns `app`, so the source text is exercised as written.
const publicDir = path.join(process.cwd(), 'public');
function makeApp(source) {
  const app = express();
  eval(source);
  return app;
}

const ipApp = makeApp(trustLine);
ipApp.get('/whoami', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
const ipSrv = ipApp.listen(0, '127.0.0.1');
await new Promise((r) => ipSrv.once('listening', r));
const ipBase = 'http://127.0.0.1:' + ipSrv.address().port;

const whoami = (xff) => new Promise((resolve, reject) => {
  const req = http.get(ipBase + '/whoami', { headers: xff ? { 'x-forwarded-for': xff } : {} }, (r) => {
    let body = '';
    r.on('data', (c) => body += c);
    r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject);
});

const proxied = await whoami('203.0.113.9');
ok('a Render-proxied request is attributed to the visitor, not the local proxy',
  proxied.body.ip === '203.0.113.9', 'req.ip=' + proxied.body.ip);
ok('req.ips carries exactly the one visitor hop', Array.isArray(proxied.body.ips) && proxied.body.ips.length === 1, JSON.stringify(proxied.body.ips));

// `1` trusts one hop: a client that prepends its own forged entry cannot move req.ip
const spoofed = await whoami('1.2.3.4, 203.0.113.9');
ok('a forged X-Forwarded-For prefix cannot impersonate another visitor',
  spoofed.body.ip === '203.0.113.9', 'req.ip=' + spoofed.body.ip);

// ---- 3. Functional: the real handler serves the icon ----
const favApp = makeApp(favSrc);
const favSrv = favApp.listen(0, '127.0.0.1');
await new Promise((r) => favSrv.once('listening', r));
const favBase = 'http://127.0.0.1:' + favSrv.address().port;

const favicon = await new Promise((resolve, reject) => {
  const req = http.get(favBase + '/favicon.ico', (r) => {
    let body = '';
    r.on('data', (c) => body += c);
    r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'] || '', cache: r.headers['cache-control'] || '', body }));
  });
  req.on('error', reject);
});

ok('/favicon.ico answers 200', favicon.status === 200, 'status=' + favicon.status);
ok('/favicon.ico serves SVG', favicon.type.includes('image/svg+xml'), favicon.type);
ok('/favicon.ico is cacheable for a week', /max-age=604800/.test(favicon.cache), favicon.cache);
ok('/favicon.ico body is the brand mark', favicon.body.trimStart().startsWith('<svg'), favicon.body.slice(0, 20));

ipSrv.close();
favSrv.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
