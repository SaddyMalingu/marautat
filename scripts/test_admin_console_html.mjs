// Regression test for the super-admin console document.
//
// Evidence (live, 2026-10-25): /admin served 255 KB whose first visible text was
// `Governance & Security -- RBAC, Audit, Policy, Session Security Refresh async
// function fetchGovernance() { ... }`. 144 lines of markup plus its <script> sat
// ABOVE <!DOCTYPE html>, so the doctype arrived late, the browser fell into quirks
// mode, and the orphaned handlers rendered as page copy. Every other suite passed:
// nothing in the repo read this file's structure, so nothing noticed.
//
// The same shift also silently deleted three cards (governance, revenue lab, tenant
// success) while their fetch handlers survived, which is only visible as a
// getElementById() with no element to find. This test checks the document itself:
// doctype position, tag balance, every referenced id, the widget wiring, the single
// filter owner, and that no CSS custom property is used without being defined.
//
//   node scripts/test_admin_console_html.mjs            (checks admin/dashboard.html)
//   node scripts/test_admin_console_html.mjs --file=x.html
import fs from 'fs';

const fileArg = (process.argv.find((a) => a.startsWith('--file=')) || '').slice(7) || 'admin/dashboard.html';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

if (!fs.existsSync(fileArg)) {
  console.log('FAIL  ' + fileArg + ' exists');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

const html = fs.readFileSync(fileArg, 'utf8');
const lines = html.split(/\r?\n/);
const count = (re) => (html.match(re) || []).length;

ok('the document is not empty', html.trim().length > 1000, html.length + ' chars');

// ---- 1. The quirks-mode / raw-source defect ----
const firstLine = (lines[0] || '').replace(/^\uFEFF/, '').trim();
ok('line 1 is the doctype', /^<!DOCTYPE html>$/i.test(firstLine), JSON.stringify(firstLine.slice(0, 90)));

const iDoctype = html.search(/<!DOCTYPE html>/i);
const iHtml = html.search(/<html[\s>]/i);
ok('the doctype precedes <html>', iDoctype > -1 && iHtml > -1 && iDoctype < iHtml, 'doctype@' + iDoctype + ' html@' + iHtml);

const above = iDoctype > -1 ? html.slice(0, iDoctype).trim() : html.slice(0, 200);
ok('nothing at all sits above the doctype', above.length === 0, JSON.stringify(above.slice(0, 120)));

// ---- 2. Tag balance: an unbalanced stray close is what silently ate the cards ----
// Anchored at the start of a line: the inline script also holds `/<body[^>]*>/i`
// (the SPA fragment loader), which is a string, not an element.
ok('<html> appears exactly once', count(/^<html[\s>]/gim) === 1, count(/^<html[\s>]/gim) + ' found');
ok('<head> and </head> balance', count(/<head[\s>]/gi) === count(/<\/head>/gi), count(/<head[\s>]/gi) + '/' + count(/<\/head>/gi));
ok('exactly one <body> element', count(/^<body[\s>]/gim) === 1, count(/^<body[\s>]/gim) + ' found');
ok('<script> tags balance', count(/<script\b/gi) === count(/<\/script>/gi), count(/<script\b/gi) + '/' + count(/<\/script>/gi));
ok('<style> tags balance', count(/<style\b/gi) === count(/<\/style>/gi), count(/<style\b/gi) + '/' + count(/<\/style>/gi));
ok('<div> tags balance', count(/<div\b/gi) === count(/<\/div>/gi), count(/<div\b/gi) + '/' + count(/<\/div>/gi));

// ---- 3. Every element the script reaches for is actually in the document ----
const referenced = new Set();
for (const m of html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) referenced.add(m[1]);
const declared = new Set();
for (const m of html.matchAll(/\bid=["']([A-Za-z][\w-]*)["']/g)) declared.add(m[1]);
const missingIds = [...referenced].filter((id) => !declared.has(id));
ok('all ' + referenced.size + ' ids used by getElementById are declared',
  missingIds.length === 0, missingIds.slice(0, 10).join(', '));

// ---- 4. The three cards lost by the shift are rendered and wired ----
const loaders = ['loadGovernanceWidget', 'loadRevenueLabWidget', 'loadTenantSuccessWidget'];
// The widget batch closes at four-space indentation; its inner blocks close deeper,
// so the first `\n    }` after the signature is the end of this function.
const iBatch = html.indexOf('function loadDashboardWidgets');
const iBatchEnd = iBatch > -1 ? html.indexOf('\n    }', iBatch) : -1;
const wiring = iBatch > -1 && iBatchEnd > iBatch ? html.slice(iBatch, iBatchEnd) : '';
ok('loadDashboardWidgets exists', wiring.length > 0);
for (const fn of loaders) {
  ok(fn + ' is defined', new RegExp('function\\s+' + fn + '\\s*\\(').test(html));
  ok(fn + '() is called from loadDashboardWidgets',
    new RegExp(fn + '\\s*\\(').test(wiring), wiring ? 'not referenced in the widget batch' : 'no widget batch');
}

// ---- 5. One owner for the discovery filter, chips instead of a select ----
const filterOwners = count(/function\s+setDiscoveryFilter\s*\(/g);
ok('exactly one setDiscoveryFilter owner', filterOwners === 1, filterOwners + ' definitions');
ok('the discovery filter is no longer a <select>', !/<select[^>]*id=["']discoveryFilter["']/i.test(html));
// The chips, the click delegate and the owner must agree on one attribute name; a
// rename in any one of the three silently stops filtering.
const chips = count(/data-disc-filter="/g);
ok('the filter chips carry data-disc-filter', chips >= 3, chips + ' chips');
ok('a chip click is routed through the single owner',
  /closest\('\[data-disc-filter\]'\)/.test(html) && /setDiscoveryFilter\(chip\.dataset\.discFilter\)/.test(html));

// ---- 6. No CSS custom property is used without being defined ----
// A token deleted by a refactor renders as `var(--x)` -> invalid, and the browser
// drops the whole declaration instead of the one value.
const defined = new Set([...html.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase()));
const used = new Set([...html.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase()));
const undefinedTokens = [...used].filter((t) => !defined.has(t));
ok('all ' + used.size + ' css tokens used are defined',
  undefinedTokens.length === 0, undefinedTokens.join(', '));

console.log('\n' + lines.length + ' lines, ' + html.length + ' chars, ' + referenced.size + ' ids, ' +
  used.size + ' css tokens');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
