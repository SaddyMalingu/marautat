// Qualification test for the tenant portal's responsive shell.
//
// The portal is the surface a merchant opens on a phone in a shop, but its shell
// was written for one 1440px desktop: a permanent 240px column above 768px, a
// drawer below it that opened with no scrim, no Escape key, no scroll lock and no
// way to close except by picking a section, 30 nav rows with no search, tables that
// scrolled the whole document sideways, sub-16px inputs that made iOS zoom, and no
// deep link — so Back left the portal and a reload forgot the section.
//
// This test holds the new behaviour in place, statically, plus a compile check of
// every inline script block, and re-asserts the Scan to Pay QR guarantees so a
// responsive rewrite cannot quietly regress that screen either.
//
//   node scripts/test_tenant_portal_mobile.mjs
import fs from 'fs';
import vm from 'vm';

const file = 'admin/tenant_dashboard.html';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

if (!fs.existsSync(file)) {
  console.log('FAIL  ' + file + ' exists');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

const html = fs.readFileSync(file, 'utf8');
const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1];
// The inline scripts, minus the <script src> tags.
const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const js = scripts.join('\n');
const count = (re, hay = html) => (hay.match(re) || []).length;

// ---- 1. It has to be a real mobile document -------------------------------
ok('the viewport meta is mobile-first',
  /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1"/i.test(html));
ok('pinch zoom is not disabled (WCAG 1.4.4)',
  !/user-scalable\s*=\s*no/i.test(html) && !/maximum-scale\s*=\s*1(?!\.)/i.test(html));

// ---- 2. The stylesheet is structurally sound ------------------------------
const openBraces = count(/\{/g, style), closeBraces = count(/\}/g, style);
ok('the stylesheet braces balance', openBraces === closeBraces, openBraces + '/' + closeBraces);
ok('the stylesheet is not empty', style.length > 2000, style.length + ' chars');
ok('media queries all open a block', count(/@media[^{]*\{/g, style) === count(/@media/g, style),
  count(/@media[^{]*\{/g, style) + ' of ' + count(/@media/g, style));

// ---- 3. One breakpoint owns the drawer ------------------------------------
ok('the drawer breakpoint is 1023px', /@media \(max-width: 1023px\)/.test(style));
ok('the old 767px shell media query is gone', !/@media \(max-width: 767px\)\s*\{[^}]*\.app-shell/.test(style));
ok('the sidebar is hidden only inside the drawer breakpoint',
  !/(^|\n)\s*\.sidebar\s*\{[^}]*display:\s*none/.test(style));
ok('the open drawer is fixed, capped and above the content',
  /\.sidebar\.open\s*\{[^}]*position:\s*fixed/.test(style) &&
  /\.sidebar\.open\s*\{[^}]*width:\s*min\(84vw,\s*300px\)/.test(style) &&
  /\.sidebar\.open\s*\{[^}]*z-index:\s*220/.test(style));
ok('the rail is sticky on desktop and scrolls on its own',
  /@media \(min-width: 1024px\)[\s\S]{0,260}\.sidebar\s*\{[^}]*position:\s*sticky/.test(style) &&
  /\.sidebar\s*\{[^}]*overflow-y:\s*auto/.test(style));
ok('the hamburger only shows where the drawer exists',
  /@media \(max-width: 1023px\)\s*\{\s*\.topbar-menu-btn\s*\{\s*display:\s*inline-flex/.test(style));

// ---- 4. The drawer can always be closed -----------------------------------
ok('a scrim element exists in the markup', /<div class="nav-scrim" id="navScrim"/.test(html));
ok('the scrim is styled and sits under the drawer, over the page',
  /\.nav-scrim\s*\{[^}]*position:\s*fixed/.test(style) &&
  /\.nav-scrim\s*\{[^}]*z-index:\s*210/.test(style) &&
  /\.nav-scrim\.show\s*\{[^}]*display:\s*block/.test(style));
ok('tapping the scrim closes the drawer',
  /const scrim = document\.getElementById\('navScrim'\);\s*\n\s*if \(scrim\) scrim\.addEventListener\('click', \(\) => closeNav\(true\)\)/.test(js));
ok('Escape closes the drawer',
  /ev\.key === 'Escape'[\s\S]{0,90}closeNav\(true\)/.test(js));
ok('a leftward flick closes the drawer',
  /touchstart/.test(js) && /dx < -45 && dy < 40/.test(js) && /passive: true/.test(js));
ok('the page behind the drawer cannot scroll',
  /body\.nav-open\s*\{\s*overflow:\s*hidden/.test(style));
ok('the WhatsApp bubble steps aside for the drawer',
  /body\.nav-open #floating-wa\s*\{\s*display:\s*none/.test(style));
ok('picking a section closes the drawer', /closeNav\(false\);/.test(js) &&
  /function go\(sec, opts\)[\s\S]{0,700}closeNav\(false\);/.test(js));
ok('the drawer button reports its state to assistive tech',
  /id="menuBtn"[^>]*aria-expanded="false"[^>]*aria-controls="sidebar"/.test(html) &&
  /setAttribute\('aria-expanded', 'true'\)/.test(js) &&
  /setAttribute\('aria-expanded', 'false'\)/.test(js));

// ---- 5. Thirty rows, one search box ---------------------------------------
ok('the drawer has a section filter', /<input id="navFilter" class="nav-filter" type="search"/.test(html));
ok('the filter is wired to the input event',
  /filter\.addEventListener\('input', \(\) => applyNavFilter\(filter\.value\)\)/.test(js));
ok('filtered rows are hidden by a class, not by rewriting the DOM',
  /\.nav-hidden\s*\{\s*display:\s*none !important/.test(style) &&
  /classList\.toggle\('nav-hidden', !hit\)/.test(js));
ok('empty groups disappear with their rows',
  /querySelectorAll\('#sidebar \.sidebar-label'\)/.test(js) &&
  /label\.classList\.toggle\('nav-hidden', !shown\)/.test(js));
ok('an empty result says so', /id="navEmpty"/.test(html) && /No section matches that\./.test(html));
ok('closing the drawer resets the filter',
  /function closeNav\(returnFocus\)[\s\S]{0,600}filter\.value = ''; applyNavFilter\(''\)/.test(js));


// ---- 6. Tables scroll in their own box, not in the document ----------------
ok('a table scroll container is defined',
  /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/.test(style) &&
  /\.table-scroll\s*\{[^}]*-webkit-overflow-scrolling:\s*touch/.test(style));
ok('wide tables keep a readable minimum width',
  /\.table-scroll\.table-wide > \.table[^}]*min-width:\s*560px/.test(style));
ok('loose tables are wrapped at render time', /function wrapLooseTables\(root\)/.test(js));
ok('tables already in .table-responsive are left alone',
  /table\.closest\('\.table-responsive, \.table-scroll'\)/.test(js));
ok('only four-plus-column tables get the minimum width', /cols >= 4/.test(js));
ok('async section renders are watched, not guessed',
  /new MutationObserver\(/.test(js) && /\.observe\(spa, \{ childList: true, subtree: true \}\)/.test(js));
ok('the observer is idempotent (no wrapper of a wrapper)',
  /if \(holder\) \{ if \(cols >= 4\) holder\.classList\.add\('table-wide'\); return; \}/.test(js));

// ---- 7. Nothing may widen the document -----------------------------------
ok('the page body never scrolls sideways',
  /body\s*\{\s*overflow-x:\s*hidden/.test(style) &&
  /@supports \(overflow-x: clip\) \{ body \{ overflow-x: clip; \} \}/.test(style));
ok('a table inside a table section is never wrapped in a div',
  /\^\(TBODY\|THEAD\|TFOOT\|TR\|COLGROUP\)\$/.test(js));
ok('the main column can shrink below its content', /\.main-area\s*\{[^}]*min-width:\s*0/.test(style));
ok('content is capped on ultrawide screens',
  /#spa\s*\{\s*max-width:\s*1440px;\s*margin:\s*0 auto/.test(style) &&
  /@media \(min-width: 1440px\)/.test(style));

// ---- 8. Phone typography and touch targets --------------------------------
ok('iOS cannot zoom a focused small field',
  /\.form-control-sm, \.form-select-sm[^{]*\{\s*font-size:\s*16px/.test(style));
ok('nav rows are a thumb-sized target on a phone',
  /@media \(max-width: 767px\)[\s\S]{0,400}\.sidebar \.nav-item \{ min-height: 46px/.test(style));
ok('nav touch rules stay out of the Writer\'s Flow pills',
  !/\n\s*\.nav-item \{[^}]*min-height/.test(style) && /data-tab="outreach"/.test(html));
ok('buttons get a floor height on a phone',
  /@media \(max-width: 767px\)[\s\S]{0,600}\.btn-sm \{ min-height: 34px/.test(style));
ok('KPI cards go two-up on a narrow phone',
  /@media \(max-width: 575px\)[\s\S]{0,160}\.stat-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(style));
ok('toasts do not overflow a 320px screen',
  /\.toast-area \{[^}]*left: 10px; right: 10px; max-width: none/.test(style));
ok('long tenant names are ellipsised in the topbar',
  /\.topbar-user \{[^}]*text-overflow: ellipsis/.test(style));
ok('the Customer 360 card is inset from the screen edge',
  /#custModal > div \{[^}]*margin: 10px !important/.test(style));
ok('landscape phones give their height to the content',
  /@media \(max-width: 900px\) and \(orientation: landscape\)/.test(style));

// ---- 9. Notches, home bars and dynamic viewports --------------------------
ok('dynamic viewport height is used with a vh fallback',
  /min-height: 100vh; min-height: 100dvh/.test(style) &&
  /max-height: calc\(100vh - var\(--topbar-h\)\); max-height: calc\(100dvh - var\(--topbar-h\)\)/.test(style));
ok('safe-area insets are respected', count(/env\(safe-area-inset-(bottom|right)/g, style) >= 4,
  count(/env\(safe-area-inset-(bottom|right)/g, style) + ' usages');
ok('the content clears the floating WhatsApp bubble',
  /\.main-area \{[^}]*calc\(78px \+ env\(safe-area-inset-bottom/.test(style));


// ---- 10. Deep links, reload and the back button ---------------------------
ok('the section is written into the URL', /function setSectionHash\(sec, push\)/.test(js) && /'#\/' \+ sec/.test(js));
ok('a nav click pushes history, so Back returns to the previous section',
  /go\(el\.dataset\.sec, \{ push: true \}\)/.test(js) && /o\.push === true/.test(js) && /history\.pushState/.test(js));
ok('the first render replaces instead of pushing', /history\.replaceState/.test(js));
ok('hashchange re-enters go()',
  /addEventListener\('hashchange'/.test(js) && /go\(sec, \{ fromHash: true \}\)/.test(js));
ok('go() does not rewrite the hash it was given',
  /if \(!o\.fromHash\) setSectionHash/.test(js));
ok('a reload reopens the section the merchant was reading',
  count(/go\(sectionFromHash\(\) \|\| 'home'\)/g, js) >= 4,
  count(/go\(sectionFromHash\(\) \|\| 'home'\)/g, js) + ' call sites');
ok('an unknown hash falls back to the dashboard',
  /function sectionFromHash\(\)[\s\S]{0,200}\? raw : '';/.test(js));

// ---- 11. Keyboard and screen readers -------------------------------------
ok('nav rows are announced as controls',
  /el\.setAttribute\('role', 'button'\)/.test(js) && /el\.setAttribute\('tabindex', '0'\)/.test(js));
ok('Enter and Space activate a nav row',
  /ev\.key === 'Enter' \|\| ev\.key === ' ' \|\| ev\.key === 'Spacebar'/.test(js));
ok('the current section is marked', /setAttribute\('aria-current', 'page'\)/.test(js));
ok('the tab title follows the section', /document\.title = label \?/.test(js));
ok('focus is visible for keyboard users only',
  /:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--accent\)/.test(style));
ok('reduced motion is honoured',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,300}transition-duration: 0\.001ms !important/.test(style) &&
  /animation-duration: 0\.001ms !important/.test(style));

// ---- 12. The shell is wired, and every element it touches exists ----------
ok('boot() hands the shell to one binder',
  /async function boot\(\) \{[\s\S]{0,200}bindShell\(\);/.test(js));
ok('the old one-line drawer toggle is gone',
  !/menuBtn'\)\.addEventListener\('click', \(\) => document\.getElementById\('sidebar'\)\.classList\.toggle\('open'\)\)/.test(js));
const shellIds = ['menuBtn', 'sidebar', 'navScrim', 'navFilter', 'navEmpty', 'spa', 'mainArea', 'logoutBtn', 'loginForm', 'toastArea', 'appShell', 'loginScreen', 'topUser', 'lPhone', 'lKey', 'loginBtn', 'loginAlert'];
const missingIds = shellIds.filter((id) => !new RegExp('id="' + id + '"').test(html));
ok('every element the shell reaches for is in the document', missingIds.length === 0, missingIds.join(', '));
const navRows = count(/class="nav-item[^"]*" data-sec=/g);
ok('all sections survived the shell rewrite', navRows >= 25, navRows + ' rows');
ok('every section row keeps its icon', count(/class="nav-icon"/g) === navRows,
  count(/class="nav-icon"/g) + '/' + navRows);

// ---- 13. Every inline script still compiles ------------------------------
ok('the page has inline scripts', scripts.length > 0, scripts.length + ' blocks');
let compileError = null;
for (const [index, source] of scripts.entries()) {
  try { new vm.Script(source, { filename: file + '#' + (index + 1) }); }
  catch (err) { compileError = 'block ' + (index + 1) + ': ' + err.message; break; }
}
ok('all inline scripts parse', compileError === null, compileError || '');

// ---- 14. The Scan to Pay screen this shell wraps must not regress ---------
ok('the QR still renders through AlphaQR', /AlphaQR\.dataUrl\(url, 720\)/.test(html));
ok('the QR poster keeps its white quiet-zone card',
  /#spQrCanvas figure \{[^}]*background: #fff/.test(style) &&
  /#spQrCanvas img, #spQrCanvas canvas \{[^}]*width: min\(300px, 76vw\)/.test(style));
ok('the Scan to Pay route is untouched',
  /data-sec="scan-pay"/.test(html) && /'scan-pay':renderScanPay/.test(html));
ok('go() still renders a spinner and resets the scroll',
  /sp\.innerHTML = spinner\(\);/.test(js) && /main\.scrollTo\(\{ top: 0/.test(js));
ok('the Writer\'s Flow tab order still holds',
  html.indexOf('id="wfMicro1Btn"') < html.indexOf('data-tab="outreach"'));

// ---- 15. The shell actually behaves: run it, do not just grep it ----------
// No jsdom in this repo, so this is the same trick the QR suite uses: a DOM small
// enough to reason about, big enough for the shell's reads and writes.
const shellStart = js.indexOf('const NAV_DRAWER_QUERY');
const shellEnd = js.indexOf('async function boot() {');
ok('the shell block can be isolated and executed', shellStart > -1 && shellEnd > shellStart,
  shellStart + '..' + shellEnd);
const shellSrc = js.slice(shellStart, shellEnd);

function node(tag, opts) {
  const o = opts || {};
  const n = {
    tagName: String(tag || 'div').toUpperCase(), id: o.id || '', textContent: o.text || '',
    dataset: o.dataset || {}, attrs: {}, hidden: !!o.hidden, focused: false,
    value: o.value || '', classes: new Set(String(o.cls || '').split(/\s+/).filter(Boolean)),
    handlers: {}, children: [], nextElementSibling: null, parentNode: null,
  };
  n.classList = {
    add: (...c) => { c.forEach((x) => n.classes.add(x)); },
    remove: (...c) => { c.forEach((x) => n.classes.delete(x)); },
    contains: (c) => n.classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !n.classes.has(c) : !!force;
      if (on) n.classes.add(c); else n.classes.delete(c);
      return on;
    },
  };
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
  n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
  n.removeAttribute = (k) => { delete n.attrs[k]; };
  n.hasAttribute = (k) => k in n.attrs;
  n.focus = () => { n.focused = true; };
  n.addEventListener = (t, fn) => { (n.handlers[t] = n.handlers[t] || []).push(fn); };
  n.fire = (t, ev) => { (n.handlers[t] || []).forEach((fn) => fn(ev || {})); };
  n.appendChild = (c) => { n.children.push(c); c.parentNode = n; return c; };
  n.insertBefore = (c) => { n.children.push(c); c.parentNode = n; return c; };
  n.querySelectorAll = () => [];
  return n;
}
function link(list) {
  for (let i = 0; i < list.length - 1; i++) list[i].nextElementSibling = list[i + 1];
  return list;
}

const labelHome = node('div', { cls: 'sidebar-label', text: 'Overview' });
const labelStore = node('div', { cls: 'sidebar-label', text: 'Store' });
const itemHome = node('div', { cls: 'nav-item', text: 'Dashboard', dataset: { sec: 'home' } });
const itemOrders = node('div', { cls: 'nav-item', text: 'Orders', dataset: { sec: 'orders' } });
const itemCatalog = node('div', { cls: 'nav-item', text: 'Product Catalog', dataset: { sec: 'catalog' } });
const itemScan = node('div', { cls: 'nav-item', text: 'Scan to Pay', dataset: { sec: 'scan-pay' } });
link([labelHome, itemHome, labelStore, itemOrders, itemCatalog, itemScan]);

const sidebar = node('nav', { id: 'sidebar', cls: 'sidebar' });
const scrim = node('div', { id: 'navScrim', cls: 'nav-scrim' });
const menuBtn = node('button', { id: 'menuBtn' });
const navFilter = node('input', { id: 'navFilter' });
const navEmpty = node('div', { id: 'navEmpty', hidden: true });
const body = node('body');
const spaBody = node('div');
const tableLoose = node('table');
tableLoose.querySelectorAll = (sel) => (sel === 'thead th' ? [1, 2, 3] : []);
tableLoose.closest = () => null;
spaBody.appendChild(tableLoose);
const tableHolder = node('div', { cls: 'table-responsive' });
const tableWide = node('table');
tableWide.querySelectorAll = (sel) => (sel === 'thead th' ? [1, 2, 3, 4, 5] : []);
tableWide.closest = () => tableHolder;
tableHolder.appendChild(tableWide);
const spa = node('div', { id: 'spa' });
spa.querySelectorAll = (sel) => (sel === 'table' ? [tableLoose, tableWide] : []);

const doc = {
  body, documentElement: { tagName: 'HTML' }, handlers: {},
  getElementById: (id) => ({ sidebar, navScrim: scrim, menuBtn, navFilter, navEmpty, spa }[id] || null),
  querySelectorAll: (sel) => {
    if (sel === '.nav-item[data-sec]') return [itemHome, itemOrders, itemCatalog, itemScan];
    if (sel === '#sidebar .sidebar-label') return [labelHome, labelStore];
    return [];
  },
  createElement: (tag) => node(tag),
  addEventListener: (t, fn) => { (doc.handlers[t] = doc.handlers[t] || []).push(fn); },
  fire: (t, ev) => { (doc.handlers[t] || []).forEach((fn) => fn(ev || {})); },
};

let wideViewport = false;
const win = {
  innerWidth: 390, handlers: {}, observers: 0,
  matchMedia: () => ({ matches: !wideViewport }),
  addEventListener: (t, fn) => { (win.handlers[t] = win.handlers[t] || []).push(fn); },
  fire: (t, ev) => { (win.handlers[t] || []).forEach((fn) => fn(ev || {})); },
};
const loc = { hash: '' };
const hist = {
  calls: [],
  pushState: (s, t, url) => { hist.calls.push(['push', url]); loc.hash = String(url); },
  replaceState: (s, t, url) => { hist.calls.push(['replace', url]); loc.hash = String(url); },
};
const goCalls = [];
class FakeObserver { constructor() { win.observers++; } observe() {} }
const ctx = {
  document: doc, window: win, history: hist, location: loc, MutationObserver: FakeObserver,
  setTimeout: (fn) => fn(), console,
  go: function () { goCalls.push(Array.prototype.slice.call(arguments)); },
  curSec: 'home',
};
vm.createContext(ctx);
let runError = null;
try { new vm.Script(shellSrc, { filename: 'tenant-shell.js' }).runInContext(ctx); }
catch (err) { runError = err.message; }
ok('the shell code runs against a DOM', runError === null, runError || '');

if (runError === null) {
  ok('a phone viewport is treated as a drawer', ctx.navIsDrawer() === true);

  ctx.openNav();
  ok('openNav opens the drawer, dims the page and locks the scroll',
    sidebar.classList.contains('open') && scrim.classList.contains('show') &&
    body.classList.contains('nav-open') && menuBtn.getAttribute('aria-expanded') === 'true');
  ok('the scrim is announced as visible', scrim.getAttribute('aria-hidden') === 'false');
  ok('the scrim swallows drags so the page behind cannot scroll',
    /\.nav-scrim \{[^}]*touch-action: none/.test(style));

  ctx.closeNav(true);
  ok('closeNav reverses all of it and returns focus to the button',
    !sidebar.classList.contains('open') && !scrim.classList.contains('show') &&
    !body.classList.contains('nav-open') && menuBtn.getAttribute('aria-expanded') === 'false' &&
    menuBtn.focused === true);

  ctx.toggleNav();
  const opened = sidebar.classList.contains('open');
  ctx.toggleNav();
  ok('the hamburger toggles both ways', opened && !sidebar.classList.contains('open'));

  ctx.applyNavFilter('scan');
  ok('filtering keeps the matching section and hides the rest',
    !itemScan.classList.contains('nav-hidden') && itemOrders.classList.contains('nav-hidden') &&
    itemHome.classList.contains('nav-hidden'));
  ok('an emptied group heading disappears with its rows',
    labelHome.classList.contains('nav-hidden') && !labelStore.classList.contains('nav-hidden'));
  ok('a match hides the empty-state note', navEmpty.hidden === true);

  ctx.applyNavFilter('zzzz');
  ok('no match hides every row and every heading',
    itemHome.classList.contains('nav-hidden') && itemScan.classList.contains('nav-hidden') &&
    labelHome.classList.contains('nav-hidden') && labelStore.classList.contains('nav-hidden'));
  ok('no match shows the empty-state note', navEmpty.hidden === false);

  ctx.applyNavFilter('');
  ok('clearing the filter restores the whole list',
    !itemHome.classList.contains('nav-hidden') && !labelHome.classList.contains('nav-hidden') &&
    navEmpty.hidden === true);


// ---- 16. Deep links, tables and event wiring, still executed --------------
if (runError === null) {
  hist.calls.length = 0;
  loc.hash = '';
  ctx.setSectionHash('orders', true);
  ctx.setSectionHash('orders', true);
  ok('the first navigation pushes a #/ section, the repeat does not',
    hist.calls.length === 1 && hist.calls[0][0] === 'push' && hist.calls[0][1] === '#/orders',
    JSON.stringify(hist.calls));
  ctx.setSectionHash('catalog', false);
  ok('a programmatic render replaces the entry instead of stacking one',
    hist.calls.length === 2 && hist.calls[1][0] === 'replace' && hist.calls[1][1] === '#/catalog');

  loc.hash = '#/orders';
  ok('a known hash resolves to its section', ctx.sectionFromHash() === 'orders');
  loc.hash = '#/not-a-section';
  ok('an unknown hash resolves to nothing', ctx.sectionFromHash() === '');
  ok('a section label is readable for the tab title', ctx.sectionLabel('scan-pay') === 'Scan to Pay');

  ok('a loose table is wrapped', ctx.wrapLooseTables() === 1);
  ok('a three-column table is not forced to a minimum width',
    String(tableLoose.parentNode && tableLoose.parentNode.className).indexOf('table-wide') === -1,
    String(tableLoose.parentNode && tableLoose.parentNode.className));
  ok('a five-column table is marked wide where it already scrolls',
    tableHolder.classList.contains('table-wide'));

  ctx.bindShell();
  ok('nav rows become keyboard controls',
    itemOrders.getAttribute('role') === 'button' && itemOrders.hasAttribute('tabindex'));
  itemOrders.fire('click');
  ok('a click navigates and pushes history',
    goCalls.length === 1 && goCalls[0][0] === 'orders' && goCalls[0][1] && goCalls[0][1].push === true,
    JSON.stringify(goCalls));
  itemScan.fire('keydown', { key: 'Enter', preventDefault() {} });
  ok('Enter activates a nav row', goCalls.length === 2 && goCalls[1][0] === 'scan-pay');
  ok('the section container is watched for new tables', win.observers === 1,
    win.observers + ' observers');

  ctx.openNav();
  doc.fire('keydown', { key: 'Escape' });
  ok('Escape closes an open drawer', !sidebar.classList.contains('open'));
  ctx.openNav();
  scrim.fire('click');
  ok('the scrim closes the drawer', !sidebar.classList.contains('open'));

  loc.hash = '#/catalog';
  win.fire('hashchange');
  ok('a back-button hash change renders that section',
    goCalls[goCalls.length - 1][0] === 'catalog' && goCalls[goCalls.length - 1][1].fromHash === true);

  ctx.openNav();
  wideViewport = true;
  win.fire('resize');
  ok('resizing out of the drawer breakpoint cleans up the scrim',
    !sidebar.classList.contains('open') && !body.classList.contains('nav-open'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

  navFilter.value = 'ord';
  ctx.closeNav(false);
  ok('closing the drawer also clears a half-typed filter',
    navFilter.value === '' && !itemHome.classList.contains('nav-hidden'));
}

process.exit(fail ? 1 : 0);
