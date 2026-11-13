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
  describeOutcome,
  decideStep,
  fillStepExpr,
  clickButtonExpr,
  matchFieldKey,
  normaliseLabel,
  planStepValues,
  readStepExpr,
  runApplication,
  stepFingerprintExpr
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


// ─── Policy: where it stops, and why ─────────────────────────────────────────────────────────
{
  const base = { ok: true, buttons: [{ label: 'Next' }], fields: [], measurements: {} };
  eq('step 15 is the human boundary', decideStep({ snapshot: base, stepNumber: 15 }).action, 'handoff');
  eq('and says so', decideStep({ snapshot: base, stepNumber: 15 }).reason, 'human_boundary');
  eq('step 16+ is still the human boundary', decideStep({ snapshot: base, stepNumber: 16 }).action, 'handoff');

  const typing = { ...base, measurements: { typing: true } };
  eq('the typing test is a human step', decideStep({ snapshot: typing, stepNumber: 14 }).action, 'handoff');
  eq('because it measures the applicant',
    decideStep({ snapshot: typing, stepNumber: 14 }).reason, 'typing_test_is_human');
  eq('unless the tenant explicitly claims it',
    decideStep({ snapshot: typing, stepNumber: 14, options: { includeTyping: true } }).action, 'advance');

  const offering = { ...base, measurements: { speed: true }, buttons: [{ label: 'Start test' }, { label: 'Next', disabled: true }] };
  eq('a speed test that has not started is started',
    decideStep({ snapshot: offering, stepNumber: 13 }).action, 'start_measurement');
  const running = { ...base, measurements: { speed: true }, buttons: [{ label: 'Next', disabled: true }] };
  eq('a speed test in flight is waited for',
    decideStep({ snapshot: running, stepNumber: 13 }).action, 'wait_measurement');

  const withPlan = { values: [{ key: 'email', value: 'x' }], unresolved: [] };
  eq('fields to fill means fill', decideStep({ snapshot: base, plan: withPlan, stepNumber: 2 }).action, 'fill');
  const blocked = { values: [], unresolved: [{ label: 'Favourite colour' }] };
  eq('an unmapped required field stops the step',
    decideStep({ snapshot: base, plan: blocked, stepNumber: 2 }).action, 'needs_values');
  const clean = { values: [], unresolved: [] };
  eq('nothing to fill and a Next button means advance',
    decideStep({ snapshot: base, plan: clean, stepNumber: 2 }).action, 'advance');
  eq('a disabled Next is not clicked',
    decideStep({ snapshot: { ...base, buttons: [{ label: 'Next', disabled: true }] }, plan: clean, stepNumber: 2 }).action, 'stuck');
  eq('an unreadable page stops everything',
    decideStep({ snapshot: { ok: false, reason: 'cross_origin_frame' } }).action, 'stop');
}

// ─── Clicking: the submit guard holds even when the caller asks for it ───────────────────────
{
  const submit = { label: 'Submit application', clicks: 0 };
  const next = { label: 'Next', clicks: 0 };
  const doc = makeFormDoc({ fields: [{ label: 'First name', id: 'fn' }], buttons: [submit, next] });
  const page = makePage(doc);

  const refused = await evaluateOn(page, clickButtonExpr({ labels: ['Submit application', 'Next'] }));
  eq('a forbidden button is refused', refused.ok, false);
  eq('and named as such', refused.reason, 'refused_forbidden_button');
  eq('nothing was clicked', submit.clicks, 0);

  const clicked = await evaluateOn(page, clickButtonExpr({ labels: ['next'] }));
  eq('Next is clicked case-insensitively', clicked.ok, true);
  eq('exactly once', next.clicks, 1);
  eq('and the submit button is untouched', submit.clicks, 0);

  const disabledDoc = makeFormDoc({ buttons: [{ label: 'Next', disabled: true }] });
  const blocked = await evaluateOn(makePage(disabledDoc), clickButtonExpr({ labels: ['Next'] }));
  eq('a disabled button is reported, not clicked', blocked.reason, 'button_disabled');
}


// ─── Filling: the native setter, the select match and the read-back ──────────────────────────
{
  const first = { label: 'First name', id: 'fn', name: 'firstName', required: true };
  const country = { label: 'Country', id: 'co', name: 'country', tag: 'select', options: [{ value: 'ke', label: 'Kenya' }, { value: 'ph', label: 'Philippines' }] };
  const openToCalls = { label: 'Open to calls', id: 'oc', name: 'openToCalls', type: 'checkbox' };
  const doc = makeFormDoc({ fields: [first, country, openToCalls] });

  const written = await evaluateOn(makePage(doc), fillStepExpr({
    values: [
      { name: 'firstName', value: 'Saddy', label: 'First name' },
      { name: 'country', value: 'Kenya', label: 'Country' },
      { name: 'openToCalls', value: 'yes', label: 'Open to calls' }
    ]
  }));

  eq('all three writes land', written.applied, 3);
  eq('nothing failed', written.failed.length, 0);
  eq('the text field holds the value', doc.fields[0].value, 'Saddy');
  eq('the select matched by visible text', doc.fields[1].value, 'ke');
  eq('the checkbox is ticked', doc.fields[2].checked, true);
  // React only sees a change if the events fire; that is the entire reason for the native setter.
  ok('input and change both fire',
    doc.fields[0].events.includes('input') && doc.fields[0].events.includes('change'), doc.fields[0].events);
}

{
  // A field that ignores writes must be reported, not silently accepted.
  const doc = makeFormDoc({ fields: [{ label: 'First name', id: 'fn', name: 'firstName' }] });
  Object.defineProperty(doc.fields[0], 'value', {
    configurable: true,
    get: () => '',
    set: () => {}
  });
  const written = await evaluateOn(makePage(doc), fillStepExpr({ values: [{ name: 'firstName', value: 'Saddy' }] }));
  eq('the write is reported as failed', written.ok, false);
  eq('with the reason', written.failed[0].reason, 'value_not_kept');
}

{
  const doc = makeFormDoc({ fields: [{ label: 'Country', id: 'co', name: 'country', tag: 'select', options: ['Kenya'] }] });
  const written = await evaluateOn(makePage(doc), fillStepExpr({ values: [{ name: 'country', value: 'Atlantis' }] }));
  eq('an option that does not exist is reported', written.ok, false);
  eq('with the reason', written.failed[0].reason, 'option_not_found');
  ok('and with the options it did see', (written.failed[0].options || []).includes('Kenya'), written.failed[0].options);
}

{
  const doc = makeFormDoc({ fields: [{ label: 'First name', id: 'fn', name: 'firstName' }] });
  const written = await evaluateOn(makePage(doc), fillStepExpr({ values: [{ name: 'nothing', value: 'x' }] }));
  eq('a field that is not there is reported', written.failed[0].reason, 'field_not_found');
}


// ─── The whole walk: real expressions, scripted page, stops at the human ─────────────────────
/**
 * A page that changes when Next is clicked, so the loop faces the same problem the real form does:
 * which step it is on is only knowable by reading the page again.
 */
function makeScriptedPage(specs) {
  let index = 0;
  let doc = null;
  const build = () => {
    const spec = specs[index] || { step: 15, fields: [] };
    const next = {
      label: spec.nextLabel || 'Next',
      disabled: Boolean(spec.nextDisabled),
      onClick: () => {
        if (spec.nextDoesNothing) return;
        index = Math.min(index + 1, specs.length - 1);
        build();
      }
    };
    const buttons = spec.buttons
      ? spec.buttons.map((b) => ({ ...b, onClick: b.onClick || next.onClick }))
      : [next];
    doc = makeFormDoc({
      step: spec.step,
      total: 15,
      fields: spec.fields || [],
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

{
  const page = makeScriptedPage([
    { step: 1, headings: ['Your details'], fields: [
      { label: 'First name', id: 'fn', name: 'firstName', required: true },
      { label: 'Email address', id: 'em', name: 'email', required: true }
    ] },
    { step: 2, headings: ['Where you are'], fields: [
      { label: 'Country', id: 'co', name: 'country', required: true },
      { label: 'City', id: 'ci', name: 'city', required: false }
    ] },
    { step: 15, headings: ['One last thing'], fields: [] }
  ]);

  const result = await runApplication({
    evaluate: page.evaluate,
    profile: PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 60, maxSteps: 8 }
  });

  eq('the walk reports a handoff', result.handoff, true);
  eq('at the human boundary', result.reason, 'human_boundary');
  eq('on step 15', result.step, 15);
  eq('and the browser must stay open', result.keepOpen, true);
  eq('three steps were recorded', result.steps.length, 3);
  eq('step 1 planned both of its fields', result.steps[0].planned.length, 2);
  eq('step 2 planned both of its fields', result.steps[1].planned.length, 2);
  ok('a step that was filled and advanced is still one record', result.steps[0].attempts >= 2,
    result.steps.map((s) => `step ${s.step} x${s.attempts}`));
  ok('the transcript records each decision',
    result.transcript.filter((t) => t.event === 'decide').length >= 3, result.transcript.length);
  eq('both advances really moved the page',
    result.transcript.filter((t) => t.event === 'advance' && t.moved).length, 2);
}

{
  // A required field the profile cannot answer stops the walk at that step, with the field named.
  const page = makeScriptedPage([
    { step: 1, headings: ['Odd question'], fields: [
      { label: 'First name', id: 'fn', name: 'firstName', required: true },
      { label: 'Favourite colour', id: 'fc', name: 'colour', required: true }
    ] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 3 }
  });
  eq('the walk stops rather than guessing', result.ok, false);
  eq('for a missing value', result.reason, 'required_field_unmapped');
  eq('it still leaves the page open', result.keepOpen, true);
  eq('and names the field', result.needsValues[0].label, 'Favourite colour');
}

{
  // A Next that does nothing is caught: the click "worked", the page did not move.
  const page = makeScriptedPage([
    { step: 1, headings: ['Stuck'], fields: [{ label: 'First name', id: 'fn', name: 'firstName', required: true }], nextDoesNothing: true }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 30, maxSteps: 3 }
  });
  eq('a page that does not move is a failure', result.ok, false);
  eq('with that exact reason', result.reason, 'step_not_advanced');
  eq('and the page is still open', result.keepOpen, true);
}


{
  // The typing test: the agent must stop even though it could type.
  const page = makeScriptedPage([
    { step: 14, headings: ['Typing test'], text: 'Type the paragraph below. We measure your WPM.', fields: [] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: PROFILE,
    options: { settleMs: 1, pollMs: 2, advanceTimeoutMs: 40, maxSteps: 3 }
  });
  eq('the typing test is handed over', result.handoff, true);
  eq('because it measures the applicant', result.reason, 'typing_test_is_human');
  eq('on step 14', result.step, 14);
}

{
  // A dry run plans and stops, and must not touch the form.
  const page = makeScriptedPage([
    { step: 1, headings: ['Your details'], fields: [{ label: 'First name', id: 'fn', name: 'firstName', required: true }] }
  ]);
  const result = await runApplication({
    evaluate: page.evaluate,
    profile: PROFILE,
    options: { dryRun: true, settleMs: 1, pollMs: 2, maxSteps: 2 }
  });
  eq('the dry run reports itself', result.dryRun, true);
  eq('and plans the write', result.planned.values.length, 1);
  eq('but leaves the field empty', page.doc.fields[0].value, '');
}

{
  // The fingerprint is what detects movement, so it has to change when the step does.
  const one = await evaluateOn(makePage(makeFormDoc({ step: 1, headings: ['A'], fields: [{ label: 'First name', id: 'a' }] })), stepFingerprintExpr());
  const two = await evaluateOn(makePage(makeFormDoc({ step: 2, headings: ['B'], fields: [{ label: 'First name', id: 'a' }] })), stepFingerprintExpr());
  eq('the step is read', one.step, 1);
  eq('and reads differently on the next step', two.step, 2);
  ok('the fingerprint differs', one.fingerprint !== two.fingerprint, [one.fingerprint, two.fingerprint]);
}

{
  // What the tenant actually reads when it stops.
  ok('the handoff message names the step and says the page is open',
    /step 15/.test(describeOutcome({ handoff: true, reason: 'human_boundary', step: 15 })),
    describeOutcome({ handoff: true, reason: 'human_boundary', step: 15 }));
  ok('the typing message says it is theirs to type',
    /typing test/i.test(describeOutcome({ reason: 'typing_test_is_human', step: 14 })),
    describeOutcome({ reason: 'typing_test_is_human', step: 14 }));
  ok('a missing value is named',
    /Favourite colour/.test(describeOutcome({ reason: 'required_field_unmapped', needsValues: [{ label: 'Favourite colour' }] })),
    describeOutcome({ reason: 'required_field_unmapped', needsValues: [{ label: 'Favourite colour' }] }));
}

eq('the platform advertises no submit capability', CHATTER_APPLY.capabilities.includes('submit'), false);
eq('fill is allowed', CHATTER_APPLY.capabilities.includes('fill'), true);
eq('the human boundary is step 15', CHATTER_APPLY.steps.handoffAt, 15);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(1);
}

