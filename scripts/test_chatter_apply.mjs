/**
 * ChatterApply: the reader, the mapper and the step policy (2026-11-13)
 *
 * There is no saved markup for this form — the apply page is a shell with the application in an iframe,
 * and both URLs are JS shells — so the reader works by generic form introspection. That makes the fake
 * DOM below the specification: it builds the shapes the reader claims to handle (label[for], a wrapping
 * label, an aria-label, a placeholder-only field, a select, a checkbox) and the expression has to find
 * them in all of them.
 *
 * Run: node scripts/test_chatter_apply.mjs
 */
import {
  CHATTER_APPLY,
  FUNNEL,
  HUMAN_ONLY_TYPES,
  LIVE_STEP_COUNT,
  STOP_SCREEN,
  chooseOptionExpr,
  buttonOffersOption,
  describeOutcome,
  decideStep,
  fileInputExpr,
  fillStepExpr,
  clickButtonExpr,
  humanOnlyReason,
  matchFieldKey,
  normaliseLabel,
  normaliseOptionLabel,
  planChoices,
  planScreenValues,
  planStepValues,
  mapFunnel,
  questionByStep,
  readStepExpr,
  rewindToStart,
  runApplication,
  liveQuestions,
  screenFor,
  stepFingerprintExpr,
  typeAtWpmExpr,
  typingPromptExpr,
  waitForHuman
} from '../utils/browserActor/tasks/chatterApply.js';

let pass = 0;
const failures = [];
function eq(what, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass += 1; return; }
  failures.push(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(what, value, detail) {
  if (value) { pass += 1; return; }
  failures.push(`${what}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

/** A window good enough for the native-value-setter dance the filler performs. */
function makeView() {
  const protoWithValue = () => {
    const proto = {};
    Object.defineProperty(proto, 'value', {
      configurable: true,
      get() { return this.__value === undefined ? '' : this.__value; },
      set(next) { this.__value = String(next); }
    });
    return { prototype: proto };
  };
  return {
    HTMLInputElement: protoWithValue(),
    HTMLTextAreaElement: protoWithValue(),
    HTMLSelectElement: protoWithValue(),
    Event: class FakeEvent { constructor(type, init) { this.type = type; this.bubbles = Boolean(init && init.bubbles); } }
  };
}

/**
 * One field. `labelMode` decides how the label is discoverable, because a real form uses all of these
 * and the reader must not silently miss two of them.
 */
function makeField(spec, doc) {
  const el = {
    tagName: (spec.tag || 'input').toUpperCase(),
    type: spec.type || 'text',
    required: Boolean(spec.required),
    disabled: Boolean(spec.disabled),
    options: spec.options ? spec.options.map((o) => ({ value: o.value ?? o, textContent: o.label ?? o })) : undefined,
    checked: Boolean(spec.checked),
    __value: spec.value === undefined ? '' : String(spec.value),
    events: [],
    attrs: {
      type: spec.type || 'text',
      name: spec.name || '',
      id: spec.id || '',
      'aria-label': spec.ariaLabel || null,
      'aria-required': spec.required ? 'true' : null,
      placeholder: spec.placeholder || null,
      autocomplete: spec.autocomplete || null,
      'aria-labelledby': spec.labelledBy || null
    },
    getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
    getBoundingClientRect() { return { width: 120, height: 20 }; },
    dispatchEvent(event) { this.events.push(event.type); return true; },
    click() {
      if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) this.checked = !this.checked;
    },
    closest(sel) {
      if (sel !== 'label') return null;
      return spec.labelMode === 'wrap' ? { innerText: spec.label } : null;
    }
  };
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return this.__value; },
    set(next) { this.__value = String(next); }
  });
  if (spec.labelMode === 'for' || spec.labelMode === undefined) doc.byFor.set(spec.id || spec.name, spec.label);
  return el;
}

/** The form document: fields, buttons, headings, text, and the label/for map. */
function makeFormDoc({ step = 1, total = 15, fields = [], buttons = [], headings = [], text = '' }) {
  const doc = {
    byFor: new Map(),
    buttons,
    location: { href: 'https://chatterapply.com/apply/form/' },
    defaultView: makeView(),
    body: { innerText: `${text}\nStep ${step} of ${total}` },
    alerts: [],
    querySelectorAll(sel) {
      if (sel === 'input, select, textarea') return this.fields;
      if (sel === 'button, [role="button"], input[type="submit"]') return this.visibleButtons();
      // The option clicker asks for this wider set, because choices are buttons, labels or radios.
      if (sel === 'button, [role="button"], [role="radio"], label, input[type="radio"]') return this.visibleButtons();
      if (sel === 'button, [role="button"], [role="radio"], label') return this.visibleButtons();
      if (sel === 'h1, h2, h3, legend') return headings.map((h) => ({ innerText: h, textContent: h }));
      if (sel === '[aria-invalid="true"], [role="alert"]') return this.alerts;
      return [];
    },
    visibleButtons() {
      return this.buttons.map((b) => ({
        innerText: b.label,
        textContent: b.label,
        value: b.label,
        disabled: Boolean(b.disabled),
        getAttribute: (n) => (n === 'aria-disabled' ? (b.disabled ? 'true' : null) : (n === 'type' ? 'button' : null)),
        getBoundingClientRect: () => ({ width: 100, height: 30 }),
        scrollIntoView() {},
        click() { b.clicks = (b.clicks || 0) + 1; if (b.onClick) b.onClick(); }
      }));
    },
    querySelector(sel) {
      const match = String(sel).match(/^label\[for="(.+)"\]$/);
      if (!match) return null;
      const label = this.byFor.get(match[1]);
      return label ? { innerText: label, textContent: label } : null;
    },
    getElementById(id) {
      return (this.fields || []).find((f) => f.getAttribute('id') === id) || null;
    }
  };
  doc.fields = fields.map((spec) => makeField(spec, doc));
  return doc;
}

/** The top document, with the form in a same-origin iframe — the shape the real page has. */
function makePage(doc, { frameSrc = 'https://chatterapply.com/apply/form/', crossOrigin = false } = {}) {
  return {
    querySelectorAll(sel) {
      if (sel !== 'iframe') return [];
      return [{
        getAttribute: () => frameSrc,
        get contentDocument() {
          if (crossOrigin) throw new Error('Blocked a frame with origin from accessing a cross-origin frame.');
          return doc;
        }
      }];
    }
  };
}

/** Run one of the real expressions against a fake page. */
async function evaluateOn(page, expression) {
  const raw = await new Function('document', 'window', 'CSS', `return ${expression};`)(
    page,
    { navigator: {} },
    { escape: (v) => String(v) }
  );
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

const PROFILE = {
  firstName: 'Saddy',
  lastName: 'Malingu',
  email: 'saddy@example.com',
  phone: '+254700000000',
  country: 'Kenya',
  city: 'Nairobi',
  englishLevel: 'Fluent',
  experience: '2 years',
  hoursPerWeek: '40',
  internet: 'Fibre',
  why: 'I like the work.'
};


// ─── The reader finds the form inside the iframe, and finds every kind of label ────────────────
{
  const doc = makeFormDoc({
    step: 1,
    fields: [
      { label: 'First name', id: 'fn', name: 'firstName', required: true },
      { label: 'Last name', id: 'ln', name: 'lastName', labelMode: 'wrap', required: true },
      { label: 'Email address', id: 'em', name: 'email', ariaLabel: 'Email address', required: true },
      { label: '', id: 'ph', name: 'phone', placeholder: 'Phone number', required: true }
    ],
    buttons: [{ label: 'Next' }],
    headings: ['Personal details'],
    text: 'Tell us about you'
  });
  const snapshot = await evaluateOn(makePage(doc), readStepExpr());

  eq('the form is read through the iframe', snapshot.mode, 'iframe');
  eq('the step number is parsed from the page', snapshot.step, 1);
  eq('the heading is kept', snapshot.headings[0], 'Personal details');
  eq('all four fields are found', snapshot.fields.length, 4);
  eq('label[for] is used', snapshot.fields[0].label, 'First name');
  eq('a wrapping label is used', snapshot.fields[1].label, 'Last name');
  eq('aria-label is used', snapshot.fields[2].label, 'Email address');
  eq('a placeholder-only field still gets a label', snapshot.fields[3].label, 'Phone number');
  eq('required is read', snapshot.fields[0].required, true);
  eq('the button is read', snapshot.buttons[0].label, 'Next');
}

{
  // A cross-origin frame cannot be read at all. That must be its own reason, not "no fields found".
  const doc = makeFormDoc({ fields: [{ label: 'First name', id: 'fn' }] });
  const snapshot = await evaluateOn(makePage(doc, { crossOrigin: true }), readStepExpr());
  eq('a cross-origin frame is not ok', snapshot.ok, false);
  eq('and says why', snapshot.reason, 'cross_origin_frame');
  ok('with the frame it could not read', /apply\/form/.test(snapshot.frameSrc || ''), snapshot.frameSrc);
}

// ─── Label matching: specific beats generic, and an unknown field is unknown ───────────────────
{
  eq('first name wins over name', matchFieldKey({ label: 'First name' }), 'firstName');
  eq('"name" alone is the full name', matchFieldKey({ label: 'Name' }), 'fullName');
  eq('a company name is not a person', matchFieldKey({ label: 'Company name' }), null);
  eq('a username is not a full name', matchFieldKey({ label: 'Username' }), null);
  eq('phone number beats phone', matchFieldKey({ label: 'Phone number', name: 'phone' }), 'phone');
  eq('the name attribute is used when there is no label', matchFieldKey({ name: 'email_address' }), 'email');
  eq('an autocomplete hint counts', matchFieldKey({ autocomplete: 'given-name' }), 'firstName');
  eq('punctuation in a label does not defeat it', matchFieldKey({ label: 'E-mail:' }), 'email');
  eq('a question about shifts is a shift', matchFieldKey({ label: 'Preferred shift' }), 'shift');
  eq('an unrelated field maps to nothing', matchFieldKey({ label: 'Favourite colour' }), null);
  eq('normaliseLabel collapses punctuation', normaliseLabel('  First   Name: '), 'first name');
}


// ─── Planning: fills what it knows, refuses to guess, and is idempotent ───────────────────────
{
  const fields = [
    { index: 0, label: 'First name', name: 'fn', type: 'text', required: true, value: '' },
    { index: 1, label: 'Email address', name: 'em', type: 'email', required: true, value: '' },
    { index: 2, label: 'Favourite colour', name: 'fc', type: 'text', required: true, value: '' }
  ];
  const plan = planStepValues({ fields, profile: PROFILE });
  eq('two fields can be filled', plan.values.length, 2);
  eq('the required unknown field is held back', plan.unresolved.length, 1);
  eq('and is named for the human', plan.unresolved[0].label, 'Favourite colour');
  eq('with the honest reason', plan.unresolved[0].reason, 'unrecognised_field');

  // Idempotence: run the same step again with the values now present.
  const refilled = fields.map((f, i) => ({ ...f, value: i === 2 ? '' : (i === 0 ? 'Saddy' : 'saddy@example.com') }));
  const again = planStepValues({ fields: refilled, profile: PROFILE });
  eq('a filled field is not written twice', again.values.length, 0);
  eq('it is reported as already set', again.skipped.filter((s) => s.reason === 'already_set').length, 2);
  eq('and the unknown field still blocks', again.unresolved.length, 1);
}

{
  // An optional unknown field is left alone rather than blocking the step.
  const plan = planStepValues({
    fields: [{ index: 0, label: 'Favourite colour', name: 'fc', type: 'text', required: false, value: '' }],
    profile: PROFILE
  });
  eq('nothing to fill', plan.values.length, 0);
  eq('nothing blocking', plan.unresolved.length, 0);
  eq('but it is reported as unmapped', plan.unmapped.length, 1);
}

{
  // The same profile value must not land in two fields on one step.
  const plan = planStepValues({
    fields: [
      { index: 0, label: 'Email address', name: 'a', type: 'email', required: true, value: '' },
      { index: 1, label: 'Email', name: 'b', type: 'email', required: false, value: '' }
    ],
    profile: PROFILE
  });
  eq('only one write happens', plan.values.length, 1);
  eq('the second is skipped as a duplicate', plan.skipped.filter((s) => s.reason === 'duplicate_key').length, 1);
}

{
  // A required field whose profile value is missing says so, and names the key it wanted.
  const plan = planStepValues({
    fields: [{ index: 0, label: 'Telegram username', name: 'tg', type: 'text', required: true, value: '' }],
    profile: PROFILE
  });
  eq('nothing is invented', plan.values.length, 0);
  eq('it is a required gap', plan.unresolved.length, 1);
  eq('the reason points at the profile', plan.unresolved[0].reason, 'profile_value_missing');
  eq('and names the key', plan.unresolved[0].key, 'telegram');
}




// ─── The funnel is data, and the data is what the tenant's own answers produced ────────────────
{
  eq('the funnel has the eleven screens the bundle declares', FUNNEL.length, 11);
  const ids = FUNNEL.map((s) => s.id);
  eq('in the bundle\'s order', ids.join(','),
    'welcome,age_verification,personal,discovery,setup,proof,speed_typing,english_test,behavioural,creativity,final');

  // The tenant's list reads as questions, not screens. Check the mapping that proved it.
  const q = (id) => FUNNEL.flatMap((s) => s.questions).find((x) => x.id === id);
  eq('question 2 is the 18+ check', q('ageCheck').label, 'Are you 18+?');
  eq('question 4 is the Discord handle, not a website username', q('discordUsername').label, 'Discord Username');
  eq('question 8 is the OnlyFans experience question', q('hasExperience').label, 'Have you worked with OnlyFans before?');
  eq('question 9 is optional, so a blank is an answer', q('experienceDetails').required, false);
  eq('question 10 offers Reddit', q('source').options.includes('Reddit'), true);
  eq('question 11 is the referral, also optional', q('referral').required, false);
  eq('question 12 is the desk photo upload', q('deskPhoto').type, 'upload');
  eq('question 14 is the typing test with a 70 floor', q('typingTest').validation.min, 70);
  eq('the stop screen is the English test', STOP_SCREEN, 'english_test');
}

// ─── Recognising a screen by its questions, not by a counter ──────────────────────────────────
{
  const snapshot = {
    ok: true,
    headings: ['Personal Details'],
    text: 'Full Name Discord Username Country Email Address Contact Number',
    fields: [
      { name: 'fullName', id: 'fullName', label: 'Full Name' },
      { name: 'discordUsername', id: 'discordUsername', label: 'Discord Username' },
      { name: 'email', id: 'email', label: 'Email Address' }
    ]
  };
  const screen = screenFor(snapshot);
  eq('the personal screen is identified', screen.id, 'personal');
  ok('with a positive score', screen.score > 0, screen.score);

  // A bare form with nothing recognisable must not be guessed at.
  eq('an unknown screen stays unknown', screenFor({ ok: true, headings: ['Something else'], fields: [], text: '' }), null);

  // The English screen is recognised from its own question text even with no input.
  const english = screenFor({ ok: true, headings: ['English Proficiency'], fields: [], text: 'English Proficiency Test' });
  eq('the English screen is identified', english.id, 'english_test');

// ─── Policy: where it stops, and why ─────────────────────────────────────────────────────────
{
  const base = { ok: true, buttons: [{ label: 'Next' }], fields: [], measurements: {} };
  const english = FUNNEL.find((s) => s.id === 'english_test');

  eq('the English screen is handed over', decideStep({ snapshot: base, screen: english }).action, 'handoff');
  eq('and named as the boundary', decideStep({ snapshot: base, screen: english }).reason, 'human_boundary');

  for (const id of ['typing_test', 'english_test', 'voice', 'proof_of_work']) {
    ok(`${id} is listed as human-only`, Boolean(HUMAN_ONLY_TYPES[id]), HUMAN_ONLY_TYPES[id]);
  }
  eq('the English test cannot be lifted', humanOnlyReason(english, { includeTyping: true }).type, 'english_test');
  eq('the typing test can be lifted', humanOnlyReason(FUNNEL.find((s) => s.id === 'speed_typing'), { includeTyping: true }), null);
  eq('but not by default', humanOnlyReason(FUNNEL.find((s) => s.id === 'speed_typing')).type, 'typing_test');
  ok('the proof screen is human-only', Boolean(humanOnlyReason(FUNNEL.find((s) => s.id === 'proof'))));

  // Speed and typing share one screen; the measurement is started, never answered.
  const speedScreen = FUNNEL.find((s) => s.id === 'speed_typing');
  const offering = { ...base, measurements: { speed: true }, buttons: [{ label: 'Start test' }, { label: 'Next', disabled: true }] };
  eq('a speed test that has not started is started',
    decideStep({ snapshot: offering, screen: speedScreen, plan: { values: [] } }).action, 'start_measurement');
  const running = { ...base, measurements: { speed: true }, buttons: [{ label: 'Next', disabled: true }] };
  eq('a speed test in flight is waited for',
    decideStep({ snapshot: running, screen: speedScreen, plan: { values: [] } }).action, 'wait_measurement');

  // Fill / needs-values / upload / advance / stuck, all on a normal screen.
  const personal = FUNNEL.find((s) => s.id === 'personal');
  eq('fields to fill means fill',
    decideStep({ snapshot: base, screen: personal, plan: { values: [{ key: 'email', value: 'x' }], unresolved: [] } }).action, 'fill');
  eq('an unmapped required field stops the screen',
    decideStep({ snapshot: base, screen: personal, plan: { values: [], unresolved: [{ label: 'Favourite colour' }] } }).action, 'needs_values');
  eq('a file to attach is its own action',
    decideStep({ snapshot: base, screen: personal, plan: { values: [], unresolved: [], uploads: [{ path: 'x.jpg' }] } }).action, 'upload');
  eq('nothing to fill and a Next button means advance',
    decideStep({ snapshot: base, screen: personal, plan: { values: [], unresolved: [] } }).action, 'advance');
  eq('a disabled Next is not clicked',
    decideStep({ snapshot: { ...base, buttons: [{ label: 'Next', disabled: true }] }, screen: personal, plan: { values: [], unresolved: [] } }).action, 'stuck');
  eq('an unreadable page stops everything',
    decideStep({ snapshot: { ok: false, reason: 'cross_origin_frame' } }).action, 'stop');
}


// ─── Planning by question id: exact, option-checked, and never a file typed as text ──────────
{
  const personal = FUNNEL.find((s) => s.id === 'personal');
  const fields = [
    { index: 0, name: 'fullName', id: 'fullName', label: 'Full Name', type: 'text', required: true, value: '' },
    { index: 1, name: 'discordUsername', id: 'discordUsername', label: 'Discord Username', type: 'text', required: true, value: '' },
    { index: 2, name: 'email', id: 'email', label: 'Email Address', type: 'email', required: true, value: '' }
  ];
  const profile = { fullName: 'David Saddy Malingu', discordUsername: 'SaddyMalingu', email: 'saddymalingu@gmail.com' };
  const plan = planScreenValues({ screen: personal, fields, profile });
  eq('all three are planned', plan.values.length, 3);
  eq('the question id is the key', plan.values[0].key, 'fullName');
  eq('and the value is the profile value', plan.values[0].value, 'David Saddy Malingu');
  eq('nothing unresolved', plan.unresolved.length, 0);

  // A multiple-choice answer that is not on the list is refused, not typed in.
  const discovery = FUNNEL.find((s) => s.id === 'discovery');
  const sourceField = { index: 0, name: 'source', id: 'source', label: 'How did you find this recruitment server?', type: 'radio', required: true, value: '' };
  const bad = planScreenValues({ screen: discovery, fields: [sourceField], profile: { source: 'Twitter' } });
  eq('an option that is not offered blocks the screen', bad.values.length, 0);
  eq('with a reason naming the options', bad.unresolved[0].reason, 'not_an_option');
  ok('and the options are shown', bad.unresolved[0].options.includes('Reddit'), bad.unresolved[0].options);

  const good = planScreenValues({ screen: discovery, fields: [sourceField], profile: { source: 'reddit' } });
  eq('a case-insensitive match is accepted', good.values[0].value, 'Reddit');
}

{
  // The desk photo: a file input with no name, on a screen with exactly one upload question.
  const setup = FUNNEL.find((s) => s.id === 'setup');
  const uploadField = { index: 0, name: '', id: '', label: '', type: 'file', required: true, value: '' };
  const plan = planScreenValues({ screen: setup, fields: [uploadField], profile: { deskPhoto: 'C:/Users/HP/Downloads/desk.jpg' } });
  eq('the file is an upload, not a value', plan.values.length, 0);
  eq('with the path attached', plan.uploads[0].path, 'C:/Users/HP/Downloads/desk.jpg');
  eq('keyed to the question', plan.uploads[0].key, 'deskPhoto');

  const missing = planScreenValues({ screen: setup, fields: [uploadField], profile: {} });
  eq('a required upload with no file blocks the screen', missing.unresolved[0].reason, 'upload_file_missing');
  eq('and never becomes a text write', missing.values.length, 0);
}

{
  // Optional questions with no answer are fine — the tenant leaves the referral blank.
  const discovery = FUNNEL.find((s) => s.id === 'discovery');
  const plan = planScreenValues({
    screen: discovery,
    fields: [
      { index: 0, name: 'experienceDetails', id: 'experienceDetails', label: 'If yes, please list the agencies', type: 'textarea', required: false, value: '' },
      { index: 1, name: 'referral', id: 'referral', label: 'Were you referred by someone?', type: 'text', required: false, value: '' }
    ],
    profile: { referral: '' }
  });
  eq('a blank optional answer is not a blocker', plan.unresolved.length, 0);
  eq('and nothing is written for it', plan.values.length, 0);
}

}

// ─── The two non-form mechanics: a real file, and paced typing ───────────────────────────────
/** Give a fake document the widgets the upload and typing passes look for. */
function addWidgets(doc, { passages = [], fileFields = [] } = {}) {
  const original = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => {
    if (sel === 'input[type="file"]') return fileFields;
    if (sel === 'textarea, input[type="text"]') {
      return doc.fields.filter((f) => f.tagName === 'TEXTAREA' || String(f.type) === 'text');
    }
    if (sel === 'p, div, span, pre, blockquote, h4, h5') {
      return passages.map((text) => ({
        innerText: text,
        textContent: text,
        contains: () => false,
        getBoundingClientRect: () => ({ width: 420, height: 60 })
      }));
    }
    return original(sel);
  };
  return doc;
}

{
  // The file input is returned as an element (not JSON) so the caller can hand its objectId to the protocol.
  const fileField = makeField({ type: 'file', id: 'drop', name: '' }, { byFor: new Map() });
  const doc = addWidgets(makeFormDoc({ fields: [] }), { fileFields: [fileField] });
  const element = await evaluateOn(makePage(doc), fileInputExpr());
  eq('the file input is found', element, fileField);
}

{
  // Typing: the passage and the box. A paragraph of instructions must not be mistaken for the passage.
  const box = makeField({ tag: 'textarea', type: 'textarea', id: 'typing', name: 'typing' }, { byFor: new Map() });
  const doc = addWidgets(makeFormDoc({ fields: [] }), {
    passages: [
      'Welcome. This application process is designed to test your skills, speed, and attention to detail.',
      'The quick brown fox jumps over the lazy dog while the morning light spreads slowly across the valley floor.'
    ]
  });
  doc.fields.push(box);
  const found = await evaluateOn(makePage(doc), typingPromptExpr());
  eq('the typing box is found', found.ok, true);
  ok('the passage is the pangram, not the instructions', /quick brown fox/i.test(found.prompt), found.prompt);
  ok('the instructions are not offered', !/application process/i.test(found.prompt), found.prompt);
  eq('the box is named', found.target.tag, 'textarea');
}

{
  // No passage means stop, not type garbage into a scored test.
  const box = makeField({ tag: 'textarea', type: 'textarea', id: 'typing', name: 'typing' }, { byFor: new Map() });
  const doc = addWidgets(makeFormDoc({ fields: [] }), { passages: ['short'] });
  doc.fields.push(box);
  const nothing = await evaluateOn(makePage(doc), typingPromptExpr());
  eq('no passage is its own failure', nothing.ok, false);
  eq('with a reason', nothing.reason, 'typing_prompt_not_found');
}

{
  // Typing at a pace: characters land one at a time and the elapsed time implies roughly the asked WPM.
  const box = makeField({ tag: 'textarea', type: 'textarea', id: 'typing', name: 'typing' }, { byFor: new Map() });
  const doc = addWidgets(makeFormDoc({ fields: [] }));
  doc.fields.push(box);
  const passage = 'The quick brown fox jumps over the lazy dog.';
  const result = await evaluateOn(makePage(doc), typeAtWpmExpr({ text: passage, wpm: 300, jitterMs: 0 }));
  eq('the whole passage is typed', result.typed, passage.length);
  eq('the field holds it', doc.fields[0].value, passage);
  ok('the pace is in the right ballpark', result.effectiveWpm > 100, `${result.effectiveWpm} WPM`);
  ok('and it is reported honestly', typeof result.effectiveWpm === 'number', result.effectiveWpm);
}


// ─── The whole walk: real expressions, scripted screens, stops at the English test ───────────
/**
 * A page that changes when Next is clicked, so the loop faces the real problem: which screen it is on is
 * only knowable by reading it again.
 */
function makeScriptedScreens(specs) {
  let index = 0;
  let doc = null;
  const build = () => {
    const spec = specs[Math.min(index, specs.length - 1)] || { step: 1, fields: [] };
    const next = {
      label: spec.nextLabel || 'Next',
      disabled: Boolean(spec.nextDisabled),
      onClick: () => {
        if (spec.nextDoesNothing) return;
        index = Math.min(index + 1, specs.length - 1);
        build();
      }
    };
    // A spec that lists its own buttons keeps them — their disabled state is the whole point of the
    // guard tests — and otherwise the page gets one Next.
    const buttons = spec.buttons
      ? spec.buttons.map((b) => ({ ...b, onClick: b.onClick || next.onClick }))
      : [next];
    doc = makeFormDoc({
      step: spec.step,
      total: 11,
      fields: (spec.fields || []).map((f) => f),
      buttons,
      headings: spec.headings || [],
      text: spec.text || ''
    });
    return doc;
  };
  build();
  return {
    get index() { return index; },
    get doc() { return doc; },
    evaluate: (expression) => evaluateOn(makePage(doc), expression)
  };
}

const WALK_PROFILE = {
  fullName: 'David Saddy Malingu',
  discordUsername: 'SaddyMalingu',
  email: 'saddymalingu@gmail.com',
  hasExperience: 'No',
  source: 'Reddit',
  referral: 'u/Silver-Tax-2158'
};

{
  const page = makeScriptedScreens([
    {
      step: 1,
      headings: ['Personal Details'],
      fields: [
        { label: 'Full Name', id: 'fullName', name: 'fullName', required: true },
        { label: 'Discord Username', id: 'discordUsername', name: 'discordUsername', required: true },
        { label: 'Email Address', id: 'email', name: 'email', required: true }
      ]
    },
    {
      step: 2,
      headings: ['Discovery'],
      fields: [
        { label: 'Have you worked with OnlyFans before?', id: 'hasExperience', name: 'hasExperience', required: true },
        { label: 'How did you find this recruitment server?', id: 'source', name: 'source', required: true }
      ]
    },
    { step: 3, headings: ['English Proficiency'], text: 'English Proficiency Test', fields: [] }
  ]);

  const result = await runApplication({
    evaluate: page.evaluate,
    profile: WALK_PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 60, maxSteps: 12 }
  });

  eq('the walk hands over', result.handoff, true);
  eq('at the English test', result.reason, 'human_boundary');
  eq('and the browser must stay open', result.keepOpen, true);
  eq('three screens were recorded', result.steps.length, 3);
  eq('the first is Personal Details', result.steps[0].screen, 'personal');
  eq('the second is Discovery', result.steps[1].screen, 'discovery');
  eq('it filled three fields on screen one', result.steps[0].planned.length, 3);
  eq('and two answers on screen two', result.steps[1].planned.length, 2);
  eq('both advances moved the page', result.transcript.filter((t) => t.event === 'advance' && t.moved).length, 2);
  eq('the question ids were used as keys', result.steps[0].planned[0].key, 'fullName');
}


// ─── The upload screen: attached through the caller, never typed ─────────────────────────────
{
  const page = makeScriptedScreens([
    { step: 1, headings: ['Tech Setup'], fields: [{ label: '', id: '', name: '', type: 'file', required: true }] }
  ]);
  const seen = [];
  const result = await runApplication({
    evaluate: page.evaluate,
    attachFile: async (upload) => { seen.push(upload); return { ok: true, files: 1 }; },
    profile: { deskPhoto: 'C:/Users/HP/Downloads/IMG_20211123_161036_205.jpg' },
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 30, maxSteps: 2 }
  });
  eq('the file was attached', seen.length, 1);
  eq('with the path the tenant gave',
    seen[0].path, 'C:/Users/HP/Downloads/IMG_20211123_161036_205.jpg');
  eq('keyed to the desk photo question', seen[0].key, 'deskPhoto');
  ok('the run reports the upload step', result.transcript.some((t) => t.event === 'upload' && t.attached === 1),
    result.transcript.map((t) => t.event));
}

{
  // With no file channel the run must say so rather than pretend the screen is done.
  const page = makeScriptedScreens([
    { step: 1, headings: ['Tech Setup'], fields: [{ label: '', id: '', name: '', type: 'file', required: true }] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: { deskPhoto: 'C:/desk.jpg' },
    options: { settleMs: 1, pollMs: 2, maxSteps: 2 }
  });
  eq('no channel is a hard failure', result.ok, false);
  eq('named precisely', result.reason, 'upload_not_supported');
  eq('and the page stays open', result.keepOpen, true);
}

// ─── What the tenant reads when it stops ────────────────────────────────────────────────────
{
  const handoff = describeOutcome({ handoff: true, reason: 'human_boundary', step: 8 });
  ok('the handoff names the English screen', /English Proficiency/i.test(handoff), handoff);
  ok('and says the page is open', /open/i.test(handoff), handoff);

  const human = describeOutcome({ reason: 'human_only_question', question: 'voiceIntro', why: 'records your voice' });
  ok('a human question says what it is', /records your voice/i.test(human), human);

  const missing = describeOutcome({ reason: 'required_field_unmapped', needsValues: [{ label: 'Desk Photo' }] });
  ok('a missing value is named', /Desk Photo/.test(missing), missing);

  const noFile = describeOutcome({ reason: 'upload_not_supported', uploads: [{ label: 'Desk Photo' }] });
  ok('a missing file channel points at the flag', /--desk-photo/.test(noFile), noFile);
}

eq('the platform advertises no submit capability', CHATTER_APPLY.capabilities.includes('submit'), false);
eq('fill is allowed', CHATTER_APPLY.capabilities.includes('fill'), true);


// ─── Multiple choice is clicked, not filled (found by the first live run) ─────────────────────
{
  // The live age screen rendered: "A Yes" · "B No" · "← Previous" · "Next →", zero inputs,
  // and Next disabled until an answer was picked.
  eq('a label normalises to itself', normaliseOptionLabel('A Yes'), 'a yes');
  eq('the marker is stripped to reach the option', normaliseOptionLabel('A Yes').replace(/^(?:[a-z]|\d{1,2})\s*[.)\]:-]?\s+/, ''), 'yes');
  eq('a numbered marker too', normaliseOptionLabel('1. No').replace(/^(?:[a-z]|\d{1,2})\s*[.)\]:-]?\s+/, ''), 'no');
  eq('a bare option is untouched', normaliseOptionLabel(' Yes '), 'yes');

  eq('"A Yes" offers "Yes"', buttonOffersOption('A Yes', 'Yes'), true);
  eq('"B No" offers "No"', buttonOffersOption('B No', 'No'), true);
  eq('"A Yes" does not offer "No"', buttonOffersOption('A Yes', 'No'), false);
  eq('decoration does not break it', buttonOffersOption('Yes ✓', 'Yes'), true);
  eq('a longer label is not a different option', buttonOffersOption('Not sure', 'No'), false);
}

{
  const age = FUNNEL.find((s) => s.id === 'age_verification');
  const blocked = [{ label: 'A Yes' }, { label: 'B No' }, { label: 'Next →', disabled: true }];
  const plan = planChoices({ screen: age, buttons: blocked, profile: { ageCheck: 'Yes' } });
  eq('the answer maps to the option button', plan.choices.length, 1);
  eq('and names the button', plan.choices[0].buttonLabel, 'A Yes');
  eq('keyed to the question', plan.choices[0].question, 'ageCheck');

  // The profile value must be one of the offered options.
  const typo = planChoices({ screen: age, buttons: blocked, profile: { ageCheck: 'Yeah' } });
  eq('an answer that is not an option is refused', typo.choices.length, 0);
  eq('and reported', typo.notOffered[0].reason, 'not_an_option');

  // No control for it: say so rather than clicking something else.
  const missing = planChoices({ screen: age, buttons: [{ label: 'A Maybe' }], profile: { ageCheck: 'Yes' } });
  eq('a question with no matching control is reported', missing.notOffered[0].reason, 'no_matching_control');
  eq('and no choice is invented', missing.choices.length, 0);
}

{
  const age = FUNNEL.find((s) => s.id === 'age_verification');
  const base = { ok: true, fields: [], measurements: {} };
  const plan = { values: [], unresolved: [], uploads: [], choices: [{ question: 'ageCheck', option: 'Yes' }] };

  eq('a pending choice on a blocked screen is chosen',
    decideStep({ snapshot: { ...base, buttons: [{ label: 'A Yes' }, { label: 'Next →', disabled: true }] }, screen: age, plan }).action,
    'choose');
  eq('but an already-answered screen advances instead',
    decideStep({ snapshot: { ...base, buttons: [{ label: 'A Yes' }, { label: 'Next →' }] }, screen: age, plan }).action,
    'advance');
  eq('with no pending choice it advances',
    decideStep({ snapshot: { ...base, buttons: [{ label: 'Next →' }] }, screen: age, plan: { ...plan, choices: [] } }).action,
    'advance');
}

{
  // Clicking the option: exact label wins over a prefix, and the click is one call.
  const clicks = [];
  const buttons = [
    { label: 'A Yes', clicks: 0 },
    { label: 'B No', clicks: 0 }
  ];
  const doc = makeFormDoc({ fields: [], buttons: buttons.map((b) => ({ ...b, onClick: () => { b.clicks += 1; clicks.push(b.label); } })) });
  const page = makePage(doc);

  const picked = await evaluateOn(page, chooseOptionExpr({ option: 'Yes', question: 'ageCheck' }));
  eq('the option is clicked', picked.ok, true);
  eq('and the button that was clicked is named', picked.label, 'A Yes');
  eq('exactly one click', clicks.length, 1);

  const missing = await evaluateOn(page, chooseOptionExpr({ option: 'Maybe' }));
  eq('an option that is not there is refused', missing.ok, false);
  ok('with the options it did see', (missing.available || []).includes('A Yes'), missing.available);
}


// ─── The guards the first live run proved were missing (2026-11-14) ──────────────────────────
{
  // A screen nothing could be read from must stop, not be advanced. On the live form this pressed Next
  // through the applicant's name, contacts and experience while reporting success.
  const blind = { ok: true, headings: ['→Some screen'], fields: [], buttons: [{ label: 'Next →' }], measurements: {} };
  const plan = { values: [], unresolved: [], uploads: [], choices: [] };
  const decision = decideStep({ snapshot: blind, screen: null, plan });
  eq('an unreadable screen stops', decision.action, 'stop');
  eq('with its own reason', decision.reason, 'unrecognised_screen');
  ok('and says what it saw', /Nothing on this screen/.test(decision.detail), decision.detail);

  // A known info screen may still be advanced with nothing on it.
  const welcome = FUNNEL.find((s) => s.id === 'welcome');
  const info = { ok: true, headings: ['Apply to Join The Team'], fields: [], buttons: [{ label: 'Continue ↵' }], measurements: {} };
  eq('a known info screen still advances',
    decideStep({ snapshot: info, screen: welcome, plan: { ...plan } }).action, 'advance');
}

{
  // The same broken click must not run forever: the live run picked one option seven times.
  const age = FUNNEL.find((s) => s.id === 'age_verification');
  const page = makeScriptedScreens([
    {
      step: 2,
      headings: ['→Are you 18+?'],
      // The live page carries the question text, which is how the screen is recognised.
      text: 'Are you 18? Yes No',
      fields: [],
      buttons: [
        { label: 'A Yes' },
        { label: 'Next →', disabled: true }
      ],
      nextDoesNothing: true
    }
  ]);
  // The choice is offered, but pressing it changes nothing on this page.
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: { ageCheck: 'Yes' },
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 20, maxSteps: 10 }
  });
  eq('a click that never takes is stopped', result.ok, false);
  eq('as no progress', result.reason, 'no_progress');
  eq('after three tries, not ten', result.transcript.filter((t) => t.event === 'decide').length, 3);
  eq('and the page is left open', result.keepOpen, true);
}

{
  // One screen must produce one record, keyed on the page's own step number.
  const page = makeScriptedScreens([
    { step: 3, headings: ['Personal Details'], fields: [{ label: 'Full Name', id: 'fullName', name: 'fullName', required: true }] },
    { step: 4, headings: ['Discovery'], fields: [] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: { fullName: 'David Saddy Malingu' },
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 6 }
  });
  eq('each step is recorded once', result.steps.length, 2);
  eq('keyed by the page number', result.steps[0].key, 'step:3');
  ok('a step read twice still has one record', result.steps[0].attempts >= 2, result.steps.map((s) => s.attempts));
  eq('and the fill was recorded on it', result.steps[0].planned.length, 1);
}


// ─── Mapping the live funnel: read everything, type nothing (2026-11-14) ─────────────────────
/** A page that can go backwards, so rewind can be exercised. */
function makeBackablePage(start = 3, floor = 1) {
  let step = start;
  let doc = null;
  const build = () => {
    doc = makeFormDoc({
      step,
      total: 21,
      fields: [],
      buttons: [
        { label: '← Previous', onClick: () => { if (step > floor) { step -= 1; build(); } } },
        { label: 'Next →', onClick: () => { step += 1; build(); } }
      ],
      headings: [`Screen ${step}`],
      text: ''
    });
    return doc;
  };
  build();
  return {
    get step() { return step; },
    get doc() { return doc; },
    evaluate: (expression) => evaluateOn(makePage(doc), expression)
  };
}

{
  const page = makeScriptedScreens([
    { step: 1, headings: ['Apply to Join The Team'], text: 'Apply to Join The Team', fields: [] },
    { step: 2, headings: ['Personal Details'], text: 'Full Name Email Address', fields: [
      { label: 'Full Name', id: 'fullName', name: 'fullName', required: true },
      { label: 'Email Address', id: 'email', name: 'email', required: true }
    ] },
    { step: 3, headings: ['Typing Test'], text: 'Typing Test aim for 70 wpm', fields: [
      { label: '', id: 'typing', name: 'typing', type: 'text' }
    ] }
  ]);

  const result = await mapFunnel({
    evaluate: page.evaluate,
    profile: WALK_PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 8 }
  });

  eq('all three screens are recorded', result.steps.length, 3);
  eq('with their own step numbers', result.steps.map((s) => s.step), [1, 2, 3]);
  eq('and their headings', result.steps[1].heading, 'Personal Details');
  eq('fields are recorded by label', result.steps[1].fields.map((f) => f.label), ['Full Name', 'Email Address']);
  ok('the page moved by pressing Next', result.steps[0].advancedBy.startsWith('next:'), result.steps[0].advancedBy);
  // The whole point: mapping reads, it does not apply.
  eq('nothing was typed into the text field', page.doc.fields[0].value, '');
  ok('the map stopped rather than running on', result.steps.length < 8, result.steps.length);
}

{
  // A blocked multiple-choice screen: clicking the profile's answer is the only way forward, and the map
  // records that it did it rather than pretending the screen advanced itself.
  const page = makeScriptedScreens([
    { step: 2, headings: ['→Are you 18+?'], text: 'Are you 18?', fields: [],
      buttons: [{ label: 'A Yes' }, { label: 'B No' }, { label: 'Next →', disabled: true }] },
    { step: 3, headings: ['Personal Details'], text: 'Full Name', fields: [
      { label: 'Full Name', id: 'fullName', name: 'fullName', required: true }
    ] }
  ]);
  const result = await mapFunnel({
    evaluate: page.evaluate,
    profile: { ageCheck: 'Yes' },
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 5 }
  });
  eq('the answered question is recorded', result.steps[0].advancedBy, 'choice:Yes');
  ok('and the map continued to the next screen', result.steps.length >= 2, result.steps.map((s) => s.step));
}

{
  // With answers disallowed, the map must stop at the first screen it cannot pass — not guess.
  const page = makeScriptedScreens([
    { step: 2, headings: ['→Are you 18+?'], text: 'Are you 18?', fields: [],
      buttons: [{ label: 'A Yes' }, { label: 'Next →', disabled: true }] }
  ]);
  const result = await mapFunnel({
    evaluate: page.evaluate,
    profile: { ageCheck: 'Yes' },
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 5, answerChoices: false }
  });
  eq('it stops at the blocked question', result.reason, 'blocked');
  eq('on that step', result.at, 2);
  eq('having recorded it', result.steps.length, 1);
}

{
  // Rewind: press Previous until step 1, changing nothing else.
  const page = makeBackablePage(3, 1);
  const result = await rewindToStart({ evaluate: page.evaluate, settleMs: 1, pollMs: 2, log: () => {} });
  eq('it reaches the first step', result.at, 1);
  eq('pressing twice', result.pressed, 2);
  eq('and the page really is on step 1', page.step, 1);
}

{
  // Already at step 1: no presses, no clicks.
  const page = makeBackablePage(1, 1);
  const result = await rewindToStart({ evaluate: page.evaluate, settleMs: 1, pollMs: 2, log: () => {} });
  eq('it says it is already there', result.pressed, 0);
  eq('at step 1', result.at, 1);
}


// ─── The live 21 steps, and the handoff they make exact (2026-11-14) ─────────────────────────
{
  eq('the live funnel has 21 displayed steps', LIVE_STEP_COUNT, 21);
  eq('every question is listed', liveQuestions().length, 21);
  eq('step 2 is the age check', questionByStep(2).question.id, 'ageCheck');
  eq('step 4 is the Discord handle', questionByStep(4).question.id, 'discordUsername');
  eq('step 8 is the OnlyFans experience question', questionByStep(8).question.id, 'hasExperience');
  eq('step 9 is optional', questionByStep(9).question.required, false);
  eq('step 12 is the desk photo', questionByStep(12).question.type, 'upload');
  eq('step 13 is the speed test', questionByStep(13).question.id, 'speedTest');
  eq('step 14 is the typing test — what the live page showed', questionByStep(14).question.id, 'typingTest');
  eq('step 15 is the English test', questionByStep(15).question.id, 'englishTest');
  eq('step 21 is the voice intro', questionByStep(21).question.id, 'voiceIntro');
  eq('a step beyond the funnel is null', questionByStep(99), null);
  ok('the skipped question keeps no number', questionByStep(13).question.id !== 'proofOfWork');
}

{
  const base = { ok: true, buttons: [{ label: 'Next' }], fields: [], measurements: {} };
  // The step alone is enough: no screen recognition needed.
  const english = decideStep({ snapshot: base, stepNumber: 15 });
  eq('step 15 is the handoff', english.action, 'handoff');
  eq('named as the boundary', english.reason, 'human_boundary');
  eq('and identified by question', english.question, 'englishTest');

  const typing = decideStep({ snapshot: base, stepNumber: 14 });
  eq('step 14 stops for the human', typing.action, 'handoff');
  eq('because it measures them', typing.reason, 'human_only_question');

  const claimed = decideStep({ snapshot: base, stepNumber: 14, options: { includeTyping: true } });
  eq('when claimed, the typing test is typed', claimed.action, 'typing_test');
  eq('and says why', claimed.reason, 'typing_claimed');

  // A normal question is still filled, not handed over.
  eq('step 3 is filled', decideStep({ snapshot: base, stepNumber: 3, plan: { values: [{ key: 'fullName', value: 'x' }], unresolved: [] } }).action, 'fill');
}


// ─── Waiting for a person, when the page will not take a click (2026-11-14) ─────────────────
{
  // A page that answers only when the human does: Next stays disabled for the first two polls.
  let polls = 0;
  const evaluate = async () => {
    polls += 1;
    const enabled = polls > 2;
    return {
      ok: true,
      step: 2,
      progressText: 'Step 2 of 21',
      headings: ['→Are you 18+?'],
      fields: [],
      text: 'Are you 18?',
      measurements: {},
      buttons: [{ label: 'A Yes' }, { label: 'Next →', disabled: !enabled }]
    };
  };
  const waited = await waitForHuman({ evaluate, previous: { step: 2 }, timeoutMs: 3000, pollMs: 250 });
  eq('the wait ends when the page moves', waited.ok, true);
  ok('and it says how long it waited', waited.waitedMs >= 250, waited.waitedMs);
  ok('it polled more than once', polls > 2, polls);
}

{
  // Nobody answers: the wait gives up and says so, rather than pretending success.
  const evaluate = async () => ({
    ok: true, step: 2, progressText: 'Step 2 of 21', headings: [], fields: [], text: '', measurements: {},
    buttons: [{ label: 'A Yes' }, { label: 'Next →', disabled: true }]
  });
  const waited = await waitForHuman({ evaluate, previous: { step: 2 }, timeoutMs: 700, pollMs: 250 });
  eq('a silent human times out', waited.ok, false);
  eq('with its own reason', waited.reason, 'human_timeout');
}

{
  // In the run itself: with a wait budget the blocked question is asked; if nobody answers, the run stops
  // honestly with the page open, naming what it was waiting for.
  const page = makeScriptedScreens([
    { step: 2, headings: ['→Are you 18+?'], text: 'Are you 18?', fields: [],
      buttons: [{ label: 'A Yes' }, { label: 'Next →', disabled: true }] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: { ageCheck: 'Yes' },
    options: { settleMs: 1, pollMs: 1, advanceTimeoutMs: 40, maxSteps: 3, waitForHumanMs: 600 }
  });
  eq('an unanswered question ends the run', result.ok, false);
  eq('as a human timeout, not a failure to click', result.reason, 'human_timeout');
  eq('it asked the right question', result.needsHuman.question, 'ageCheck');
  eq('with the options the page offers', result.needsHuman.options, ['Yes']);
  eq('and it leaves the page open for them', result.keepOpen, true);
  ok('the transcript records that it asked', result.transcript.some((t) => t.event === 'human-needed'),
    result.transcript.map((t) => t.event));
}

console.log(`\n${pass} passed, ${failures.length} failed`);

if (failures.length) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}

