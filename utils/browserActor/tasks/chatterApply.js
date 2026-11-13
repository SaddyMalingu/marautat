/**
 * ChatterApply — drive the 12 form steps, measure, then hand the page to a human (2026-11-13)
 *
 * Written without ever having seen the form's markup, and that constraint decided the design.
 *
 * The saved copy of `https://chatterapply.com/apply` is 11 KB and contains **no form at all**: it is
 * a shell that embeds the real application in an iframe pointing at
 * `https://chatterapply.com/apply/form/`, and that URL is itself a 2.3 KB JS shell. So there is no
 * real markup to write selectors against — not from the dump, not by fetching the page.
 *
 * Therefore nothing here is a hand-picked CSS selector. The reader is **generic form
 * introspection**: it finds the form document, then reads every field by walking `label[for]`,
 * wrapping `<label>`, `aria-label`, `aria-labelledby`, `placeholder`, `name` and `id`. That works on
 * any ordinary form, survives a rebuild of theirs and — crucially — reports what it found instead of
 * silently matching nothing. When a step holds something this cannot interpret it stops and says so;
 * the first real run turns that into a schema of facts.
 *
 * Two rules the page's own copy forces:
 *
 *   1. **The typing test is an attested measurement of the applicant.** The apply page lists
 *      "Typing speed of 65+ WPM" as a hiring requirement and says "The application includes a short
 *      typing test and assessment". A machine typing that test reports a competence no human
 *      demonstrated, which misrepresents the applicant to the employer — the same thing `oneForma.js`
 *      refuses to do for certifications. So step 14 is a **human** step by default; `includeTyping`
 *      exists for a tenant who has decided otherwise and is off unless asked for.
 *   2. **Step 15 is a human boundary.** Nothing matching `submit|send application|apply now` is ever
 *      clicked, and the page is never navigated or reloaded once it is up: the point is to leave a
 *      live, filled, mid-flow page for the person to finish.
 */

/** The platform as the worker needs to know it. `capabilities` is a promise, not a comment. */
export const CHATTER_APPLY = Object.freeze({
  slug: 'chatterapply',
  name: 'ChatterApply',
  origin: 'https://chatterapply.com',
  applyUrl: 'https://chatterapply.com/apply',
  /** The real application lives in an iframe on this URL; it also renders standalone. */
  formUrl: 'https://chatterapply.com/apply/form/',
  /**
   * `fill` and `read` only. No `submit`: the last step is a person's to press, and an agent that
   * presses it claims an application was made by someone who has not read it.
   */
  capabilities: Object.freeze(['read', 'fill']),
  steps: Object.freeze({
    /** The flow the tenant described: 12 form steps, 13 speed, 14 typing, 15 the human's. */
    formSteps: 12,
    speedTest: 13,
    typingTest: 14,
    handoffAt: 15
  }),
  buttons: Object.freeze({
    next: ['next', 'continue', 'save and continue', 'proceed'],
    start: ['start', 'start test', 'begin', 'begin test', 'start typing'],
    /** Never clicked, at any step, whatever the config says. */
    forbidden: ['submit', 'send application', 'apply now', 'finish application']
  })
});

/**
 * Finds the document the form is actually in.
 *
 * Same-origin frames are reachable directly, which is the case here (`/apply` and `/apply/form/` share
 * an origin), so no CDP target switching is needed. A **cross-origin** frame cannot be read this way —
 * `contentDocument` is null — and that has to be its own failure, because "no fields found" would send
 * someone editing a working selector.
 */
export const FORM_ROOT = `
  const normalizeSrc = (v) => String(v == null ? '' : v).trim();
  const findFormDocument = () => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      const src = normalizeSrc(frame.getAttribute('src'));
      if (!/apply\\/form|chatterapply/i.test(src)) continue;
      try {
        const doc = frame.contentDocument;
        if (doc && doc.body) return { doc, frameSrc: src, mode: 'iframe' };
      } catch (error) {
        return { doc: null, frameSrc: src, mode: 'cross-origin', error: String((error && error.message) || error) };
      }
    }
    // No matching frame: if this IS the form document, use it directly.
    return { doc: document, frameSrc: null, mode: 'top' };
  };
`;

/**
 * Read whatever step is on screen.
 *
 * Every field carries the label it was given, because the label is what the value mapper matches on
 * and what a human needs to see in the transcript when a field is skipped.
 */
export function readStepExpr({ includeValues = true } = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) {
    return JSON.stringify({
      ok: false,
      reason: 'cross_origin_frame',
      frameSrc: found.frameSrc,
      detail: 'The form frame cannot be read from this document, so no field can be filled safely.',
      error: found.error || null
    });
  }
  const doc = found.doc;
  const bodyText = clean(doc.body ? doc.body.innerText : '').slice(0, 1200);

  const labelFor = (el) => {
    const id = el.getAttribute('id');
    if (id) {
      const explicit = doc.querySelector('label[for="' + String(id).replace(/"/g, '\\\\"') + '"]');
      if (explicit) return clean(explicit.innerText || explicit.textContent);
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) return clean(wrapping.innerText || wrapping.textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((token) => doc.getElementById(token)).filter(Boolean);
      const text = clean(parts.map((part) => part.innerText || part.textContent).join(' '));
      if (text) return text;
    }
    // A field with only a placeholder is common on this kind of form; the placeholder is the label.
    return clean(el.getAttribute('placeholder'));
  };

  const visible = (el) => {
    if (!el) return false;
    if (String(el.type || '').toLowerCase() === 'hidden') return false;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };

  const fields = Array.from(doc.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(String(el.type || '').toLowerCase()))
    .filter(visible)
    .map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: String(el.getAttribute('type') || el.tagName).toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      label: labelFor(el),
      placeholder: clean(el.getAttribute('placeholder')),
      autocomplete: clean(el.getAttribute('autocomplete')),
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      disabled: el.disabled === true,
      value: ${includeValues ? 'clean(el.value).slice(0, 200)' : "''"},
      checked: (el.type === 'checkbox' || el.type === 'radio') ? Boolean(el.checked) : null,
      options: el.tagName === 'SELECT'
        ? Array.from(el.options).slice(0, 40).map((o) => ({ value: o.value, label: clean(o.textContent) }))
        : null
    }));

  const buttons = Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"]'))
    .filter(visible)
    .map((el) => ({
      label: clean(el.innerText || el.textContent || el.value).slice(0, 60),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      type: String(el.getAttribute('type') || '')
    }))
    .filter((b) => b.label);

  const headings = Array.from(doc.querySelectorAll('h1, h2, h3, legend'))
    .map((el) => clean(el.innerText || el.textContent))
    .filter(Boolean)
    .slice(0, 6);

  const progressText = (bodyText.match(/(?:step\\s*)?(\\d{1,2})\\s*(?:of|\\/)\\s*(\\d{1,2})/i) || [])[0] || null;
  const current = progressText ? Number(progressText.match(/\\d{1,2}/)[0]) : null;

  return JSON.stringify({
    ok: true,
    mode: found.mode,
    frameSrc: found.frameSrc,
    url: String(doc.location ? doc.location.href : ''),
    progressText,
    step: current,
    headings,
    fields,
    buttons,
    text: bodyText.slice(0, 600),
    // Widgets that measure something rather than ask something.
    measurements: {
      speed: /mbps|download speed|upload speed|internet speed|connection speed/i.test(bodyText),
      typing: /wpm|words per minute|typing (?:test|speed)|keystroke/i.test(bodyText)
    },
    errors: Array.from(doc.querySelectorAll('[aria-invalid="true"], [role="alert"]'))
      .map((el) => clean(el.innerText || el.textContent))
      .filter(Boolean)
      .slice(0, 8)
  });
})()`;
}


/**
 * Write values into the fields the planner chose.
 *
 * Every write goes through the **native value setter** of the frame's own `window` and then fires
 * `input` and `change`. Assigning `el.value` directly works on a plain form and does nothing on a
 * React form: React's synthetic events read the tracked value, see no change, and never update state
 * — the field looks filled on screen while the app knows nothing, so Next stays disabled with nothing
 * behind it. That failure is silent and expensive; this is the fix.
 *
 * Each write is verified by reading the value back, so a selector that matched the wrong element shows
 * up here rather than as a validation error three steps later.
 */
export function fillStepExpr({ values = [] } = {}) {
  const writes = JSON.stringify(values.map((row) => ({
    name: row.name || '',
    id: row.id || '',
    label: row.label || '',
    value: row.value == null ? '' : String(row.value)
  })));
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame', frameSrc: found.frameSrc });
  const doc = found.doc;
  const view = doc.defaultView || window;
  const writes = ${writes};

  const labelFor = (el) => {
    const id = el.getAttribute('id');
    if (id) {
      const explicit = doc.querySelector('label[for="' + String(id).replace(/"/g, '\\\\"') + '"]');
      if (explicit) return clean(explicit.innerText || explicit.textContent);
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) return clean(wrapping.innerText || wrapping.textContent);
    return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder'));
  };
  const all = Array.from(doc.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(String(el.type || '').toLowerCase()));

  const locate = (write) => {
    if (write.name) {
      const byName = all.find((el) => el.getAttribute('name') === write.name);
      if (byName) return byName;
    }
    if (write.id) {
      const byId = doc.getElementById(write.id);
      if (byId) return byId;
    }
    if (write.label) {
      const key = write.label.toLowerCase();
      return all.find((el) => labelFor(el).toLowerCase() === key) || null;
    }
    return null;
  };

  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? view.HTMLSelectElement.prototype
      : view.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
    el.dispatchEvent(new view.Event('blur', { bubbles: true }));
  };

  const results = writes.map((write) => {
    const el = locate(write);
    if (!el) return { ...write, ok: false, reason: 'field_not_found' };
    if (el.disabled) return { ...write, ok: false, reason: 'field_disabled' };
    if (el.tagName === 'SELECT') {
      // Match an option by value, then by visible text — a form may use either.
      const wanted = write.value.toLowerCase();
      const option = Array.from(el.options).find((o) => String(o.value).toLowerCase() === wanted)
        || Array.from(el.options).find((o) => clean(o.textContent).toLowerCase() === wanted)
        || Array.from(el.options).find((o) => clean(o.textContent).toLowerCase().includes(wanted));
      if (!option) {
        return {
          ...write,
          ok: false,
          reason: 'option_not_found',
          options: Array.from(el.options).slice(0, 25).map((o) => clean(o.textContent))
        };
      }
      setNativeValue(el, option.value);
      return { ...write, ok: true, written: option.value, label: labelFor(el) };
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      const wants = /^(true|yes|on|1)$/i.test(write.value);
      if (el.checked !== wants) el.click();
      return { ...write, ok: el.checked === wants, written: el.checked, label: labelFor(el) };
    }
    setNativeValue(el, write.value);
    const actual = clean(el.value);
    return {
      ...write,
      ok: actual === clean(write.value),
      written: actual,
      label: labelFor(el),
      reason: actual === clean(write.value) ? null : 'value_not_kept'
    };
  });

  return JSON.stringify({
    ok: results.every((row) => row.ok),
    applied: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok),
    results
  });
})()`;
}


/**
 * Press one button, chosen by its label.
 *
 * `forbidden` is checked first and *always*: the guard has to hold even if a caller passes config that
 * names the submit button, because the one thing this runner must never do is finish an application on
 * somebody's behalf.
 */
export function clickButtonExpr({ labels = [], forbidden = CHATTER_APPLY.buttons.forbidden } = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;
  const wants = ${JSON.stringify(labels.map((l) => String(l).toLowerCase()))};
  const forbidden = ${JSON.stringify((forbidden || []).map((f) => String(f).toLowerCase()))};

  const visible = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };
  const candidates = Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"]'))
    .filter(visible)
    .map((el) => ({ el, label: clean(el.innerText || el.textContent || el.value) }))
    .filter((row) => row.label);

  const match = candidates.find((row) => wants.some((want) => row.label.toLowerCase() === want))
    || candidates.find((row) => wants.some((want) => row.label.toLowerCase().includes(want)));
  if (match && forbidden.some((word) => match.label.toLowerCase().includes(word))) {
    return JSON.stringify({ ok: false, reason: 'refused_forbidden_button', label: match.label });
  }
  if (!match) {
    return JSON.stringify({ ok: false, reason: 'no_matching_button', available: candidates.map((row) => row.label) });
  }
  if (match.el.disabled === true || match.el.getAttribute('aria-disabled') === 'true') {
    return JSON.stringify({ ok: false, reason: 'button_disabled', label: match.label });
  }
  try { match.el.scrollIntoView({ block: 'center' }); } catch (e) {}
  match.el.click();
  return JSON.stringify({ ok: true, label: match.label });
})()`;
}

/** Which step are we on? Cheap enough to poll between actions. */
export function stepFingerprintExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;
  const text = clean(doc.body ? doc.body.innerText : '');
  const progress = (text.match(/(?:step\\s*)?(\\d{1,2})\\s*(?:of|\\/)\\s*(\\d{1,2})/i) || [])[0] || null;
  const heading = Array.from(doc.querySelectorAll('h1, h2, h3, legend'))
    .map((el) => clean(el.innerText || el.textContent)).filter(Boolean)[0] || null;
  const fields = Array.from(doc.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset'].includes(String(el.type || '').toLowerCase()))
    .length;
  return JSON.stringify({
    ok: true,
    step: progress ? Number(progress.match(/\\d{1,2}/)[0]) : null,
    progress,
    heading,
    fields,
    // A digest of the visible text changes when the app moves on, even if it shows no step number.
    fingerprint: (heading || '') + '|' + fields + '|' + text.slice(0, 160)
  });
})()`;
}


/*
 * ─── The mapping, which is the part a person has to trust ───────────────────────────────────────
 *
 * The form is unknown, so the profile has to meet the fields by name. The rule that keeps this honest:
 * **a field is filled only when a phrase in its label resolves to exactly one profile key.** An
 * unrecognised field that is required stops the run and is named, because a plausible-looking guess on
 * a required application field is worse than a stop — the tenant cannot see a wrong answer later, and
 * the employer reads it as theirs.
 */
export const PROFILE_FIELDS = Object.freeze({
  firstName: ['first name', 'firstname', 'given name', 'fname', 'forename'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'lname'],
  fullName: ['full name', 'your name', 'legal name', 'name'],
  email: ['email address', 'e-mail', 'email'],
  phone: ['phone number', 'mobile number', 'whatsapp number', 'contact number', 'phone', 'mobile', 'whatsapp'],
  country: ['country of residence', 'which country', 'country', 'location'],
  city: ['city', 'town'],
  dateOfBirth: ['date of birth', 'birth date', 'dob', 'birthday'],
  age: ['age'],
  gender: ['gender', 'sex'],
  englishLevel: ['english level', 'english proficiency', 'english fluency', 'level of english'],
  experience: ['years of experience', 'chatting experience', 'previous experience', 'experience'],
  availability: ['when can you start', 'available from', 'start date', 'availability'],
  hoursPerWeek: ['hours per week', 'weekly hours', 'how many hours', 'hours available'],
  shift: ['shift preference', 'preferred shift', 'working hours', 'schedule preference', 'shift'],
  timezone: ['timezone', 'time zone', 'utc offset'],
  device: ['what device', 'computer specs', 'laptop', 'desktop', 'device'],
  internet: ['internet connection', 'connection type', 'internet speed', 'internet'],
  languages: ['languages spoken', 'languages', 'language'],
  why: ['why do you want', 'why should we hire', 'tell us about yourself', 'about yourself', 'motivation'],
  telegram: ['telegram'],
  discord: ['discord'],
  referrer: ['how did you hear', 'referral', 'referred by', 'referrer'],
  expectedPay: ['expected pay', 'salary expectation', 'expected salary', 'desired rate'],
  portfolio: ['portfolio', 'website', 'work samples']
});

/** Lowercase, strip punctuation and collapse spaces — labels vary more than values do. */
export function normaliseLabel(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which profile key does this field want?
 *
 * Longest phrase wins, so "phone number" beats "phone" and "first name" is never stolen by "name".
 * Returns null rather than a best guess when nothing matches.
 */
export function matchFieldKey(field = {}) {
  const haystacks = [field.label, field.placeholder, field.autocomplete, field.name, field.id]
    .map(normaliseLabel)
    .filter(Boolean);
  if (!haystacks.length) return null;
  const candidates = [];
  for (const [key, phrases] of Object.entries(PROFILE_FIELDS)) {
    for (const phrase of phrases) candidates.push({ key, phrase: normaliseLabel(phrase) });
  }
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const { key, phrase } of candidates) {
    for (const hay of haystacks) {
      if (hay === phrase) return key;
      // Whole-word containment only. Bare "name" is deliberately excluded from containment: on a real
      // form "Company name", "Username" and "Referrer name" are different questions, and answering
      // them with a person's name is exactly the kind of confident wrong answer this module refuses.
      if (!` ${hay} `.includes(` ${phrase} `)) continue;
      if (key === 'fullName' && phrase === 'name') continue;
      return key;
    }
  }
  return null;
}


/**
 * Turn one step's fields plus a profile into the writes to perform.
 *
 * `values` skips anything already correct, so a second run over the same step writes nothing and the
 * machine advances instead of looping. `unresolved` holds required fields it will not guess at;
 * `unmapped` holds optional ones it is leaving alone. Everything it declines to do is named.
 */
export function planStepValues({ fields = [], profile = {}, alreadyUsed = [] } = {}) {
  const used = new Set(alreadyUsed);
  const values = [];
  const unresolved = [];
  const unmapped = [];
  const skipped = [];

  for (const field of fields) {
    if (field.disabled) {
      skipped.push({ label: field.label || field.name, reason: 'disabled' });
      continue;
    }
    const key = matchFieldKey(field);
    const raw = key ? profile[key] : undefined;
    const hasValue = raw !== undefined && raw !== null && String(raw).trim() !== '';

    if (!hasValue) {
      // Required and unknown: stop rather than invent. Optional and unknown: leave it alone.
      (field.required ? unresolved : unmapped).push({
        label: field.label || field.placeholder || field.name || field.id || `field #${field.index}`,
        name: field.name || '',
        id: field.id || '',
        type: field.type,
        key: key || null,
        reason: key ? 'profile_value_missing' : 'unrecognised_field'
      });
      continue;
    }

    if (used.has(key) && field.type !== 'checkbox' && field.type !== 'radio') {
      // One profile value twice in a step is a mis-mapped label, not a form that asks twice.
      skipped.push({ label: field.label || field.name, reason: 'duplicate_key', key });
      continue;
    }

    const desired = Array.isArray(raw) ? raw.join(', ') : String(raw);
    const isChoice = field.type === 'checkbox' || field.type === 'radio';
    const already = isChoice
      ? String(Boolean(field.checked)) === String(/^(true|yes|on|1)$/i.test(desired))
      : String(field.value == null ? '' : field.value).trim() === desired.trim();

    if (already) {
      used.add(key);
      skipped.push({ label: field.label || field.name, reason: 'already_set', key });
      continue;
    }

    used.add(key);
    values.push({
      key,
      label: field.label || field.placeholder || '',
      name: field.name || '',
      id: field.id || '',
      type: field.type,
      value: desired
    });
  }

  return { values, unresolved, unmapped, skipped };
}

/**
 * What to do with the step that is on screen. Pure, so the policy is testable without a browser.
 *
 * The ordering encodes the safety rules: the human boundary is checked before anything else, the
 * typing test is a human step unless explicitly claimed, and a required field it cannot map stops the
 * run instead of being filled with a guess.
 */
export function decideStep({ snapshot = {}, plan = null, stepNumber = null, options = {} } = {}) {
  const {
    handoffAt = CHATTER_APPLY.steps.handoffAt,
    typingTest = CHATTER_APPLY.steps.typingTest,
    includeTyping = false,
    speedTest = CHATTER_APPLY.steps.speedTest
  } = options;

  if (!snapshot.ok) {
    return { action: 'stop', reason: snapshot.reason || 'unreadable', detail: snapshot.detail || null };
  }
  const step = stepNumber || snapshot.step || null;

  // The human's step, whatever else is on screen.
  if (step && step >= handoffAt) {
    return { action: 'handoff', reason: 'human_boundary', step };
  }
  if (snapshot.measurements?.typing && !includeTyping) {
    return { action: 'handoff', reason: 'typing_test_is_human', step };
  }
  // A measurement is the page's own; it is waited for, never produced.
  if (step && step === speedTest && snapshot.measurements?.speed) {
    const start = (snapshot.buttons || []).find((b) => /^(start|begin)/i.test(b.label) && !b.disabled);
    return start
      ? { action: 'start_measurement', reason: 'speed_test_offered', step, button: start.label }
      : { action: 'wait_measurement', reason: 'speed_test_running', step };
  }
  if (plan && plan.unresolved?.length) {
    return { action: 'needs_values', reason: 'required_field_unmapped', step, unresolved: plan.unresolved };
  }
  if (plan && plan.values?.length) {
    return { action: 'fill', reason: 'fields_to_fill', step, values: plan.values };
  }
  const next = (snapshot.buttons || []).find(
    (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
  );
  if (next) return { action: 'advance', reason: 'ready_for_next', step, button: next.label };
  return { action: 'stuck', reason: 'no_next_button', step, buttons: (snapshot.buttons || []).map((b) => b.label) };
}


/**
 * Walk the application, one step at a time, and stop at the human boundary.
 *
 * Everything the browser does goes through the injected `evaluate` (expression string → parsed JSON),
 * so the loop is testable against a simulated form and the CDP plumbing stays in the script.
 *
 * Two properties matter more than anything it fills:
 *
 *   - **It never navigates.** There is no navigation call in this file at all. The page is opened once
 *     by the caller and then only read and clicked, so a half-finished application is never thrown away
 *     by a reload — the difference between "ready for you" and "start again".
 *   - **Every advance is verified.** After clicking Next it waits for the step to actually change. A
 *     click a validation rule swallowed looks identical to a successful one at the moment of clicking;
 *     the difference only shows up as a run that silently did nothing.
 */
export async function runApplication({ evaluate, profile = {}, options = {}, log = () => {} } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('runApplication needs an evaluate() function');
  const {
    maxSteps = 20,
    settleMs = 800,
    advanceTimeoutMs = 15_000,
    measureTimeoutMs = 60_000,
    pollMs = 500,
    dryRun = false,
    ...policy
  } = options;

  const transcript = [];
  const steps = [];
  const note = (entry) => { transcript.push(entry); log(entry); return entry; };

  for (let index = 0; index < maxSteps; index += 1) {
    const snapshot = await evaluate(readStepExpr());
    if (!snapshot?.ok) {
      note({ event: 'unreadable', reason: snapshot?.reason || 'unknown', detail: snapshot?.detail || null });
      return { ok: false, reason: snapshot?.reason || 'unreadable', transcript, steps, keepOpen: true };
    }

    const stepNumber = snapshot.step || (steps.length ? steps.length + 1 : null);
    const plan = planStepValues({ fields: snapshot.fields || [], profile });
    // One record per step, not per read. A step is read more than once — before filling and again
    // before advancing — and appending each read would make a five-iteration run look like five
    // different steps to the person reading the summary. The first non-empty plan is what was filled.
    const record = {
      step: stepNumber,
      headings: snapshot.headings,
      progressText: snapshot.progressText,
      fields: (snapshot.fields || []).map((f) => ({
        label: f.label, name: f.name, type: f.type, required: f.required, value: f.value
      })),
      buttons: (snapshot.buttons || []).map((b) => b.label),
      measurements: snapshot.measurements,
      planned: plan.values.map((v) => ({ key: v.key, label: v.label, value: v.value })),
      unresolved: plan.unresolved,
      unmapped: plan.unmapped,
      attempts: 1
    };
    const existing = steps.find((s) => s.step !== null && s.step === stepNumber);
    if (existing) {
      existing.attempts += 1;
      existing.fields = record.fields;
      existing.buttons = record.buttons;
      if (!existing.planned.length && record.planned.length) existing.planned = record.planned;
      if (!existing.unresolved.length && record.unresolved.length) existing.unresolved = record.unresolved;
      existing.unmapped = record.unmapped.length ? record.unmapped : existing.unmapped;
    } else {
      steps.push(record);
    }

    const decision = decideStep({ snapshot, plan, stepNumber, options: policy });
    note({
      event: 'decide',
      step: stepNumber,
      heading: snapshot.headings?.[0] || null,
      action: decision.action,
      reason: decision.reason,
      fields: (snapshot.fields || []).length,
      toFill: plan.values.length,
      unresolved: plan.unresolved.length
    });

    if (decision.action === 'handoff') {
      // The caller must leave the browser exactly as it is.
      return { ok: true, handoff: true, step: stepNumber, reason: decision.reason, keepOpen: true, transcript, steps };
    }
    if (decision.action === 'needs_values') {
      return {
        ok: false,
        handoff: true,
        step: stepNumber,
        reason: decision.reason,
        needsValues: decision.unresolved || plan.unresolved,
        keepOpen: true,
        transcript,
        steps
      };
    }
    if (decision.action === 'stop' || decision.action === 'stuck') {
      return { ok: false, step: stepNumber, reason: decision.reason, detail: decision, keepOpen: true, transcript, steps };
    }
    if (dryRun) {
      // A dry run reads and decides, then stops: it must not fill or click its way through a real form.
      note({ event: 'dry-run', step: stepNumber, would: decision.action });
      return { ok: true, dryRun: true, step: stepNumber, planned: plan, decision, transcript, steps, keepOpen: true };
    }

    if (decision.action === 'fill') {
      const written = await evaluate(fillStepExpr({ values: plan.values }));
      note({ event: 'fill', step: stepNumber, applied: written?.applied || 0, failed: (written?.failed || []).length });
      if (!written?.ok) {
        return {
          ok: false,
          step: stepNumber,
          reason: 'fill_failed',
          failures: written?.failed || [],
          keepOpen: true,
          transcript,
          steps
        };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    if (decision.action === 'start_measurement') {
      const started = await evaluate(clickButtonExpr({ labels: [decision.button] }));
      note({ event: 'measurement-start', step: stepNumber, label: started?.label || null, ok: Boolean(started?.ok) });
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }


    if (decision.action === 'wait_measurement') {
      // The page measures the connection; we only wait for its verdict and never supply one.
      const startedAt = Date.now();
      let done = false;
      while (Date.now() - startedAt < measureTimeoutMs) {
        await new Promise((r) => setTimeout(r, Math.max(pollMs, 1000)));
        const again = await evaluate(readStepExpr());
        const nextReady = (again?.buttons || []).some(
          (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((w) => b.label.toLowerCase().includes(w))
        );
        if (!again?.measurements?.speed || nextReady) { done = true; break; }
      }
      note({ event: 'measurement-wait', step: stepNumber, done, waitedMs: Date.now() - startedAt });
      if (!done) {
        return { ok: false, step: stepNumber, reason: 'measurement_timeout', keepOpen: true, transcript, steps };
      }
      continue;
    }

    if (decision.action === 'advance') {
      const before = await evaluate(stepFingerprintExpr());
      const clicked = await evaluate(clickButtonExpr({ labels: [decision.button] }));
      if (!clicked?.ok) {
        return {
          ok: false,
          step: stepNumber,
          reason: clicked?.reason || 'click_failed',
          detail: clicked,
          keepOpen: true,
          transcript,
          steps
        };
      }
      const changed = await waitForStepChange({ evaluate, before, timeoutMs: advanceTimeoutMs, pollMs });
      note({
        event: 'advance',
        step: stepNumber,
        button: clicked.label,
        moved: changed.moved,
        from: before?.step ?? null,
        to: changed.after?.step ?? null
      });
      if (!changed.moved) {
        // The click landed but the page stayed put: almost always a validation message.
        const after = await evaluate(readStepExpr());
        return {
          ok: false,
          step: stepNumber,
          reason: 'step_not_advanced',
          errors: after?.errors || [],
          keepOpen: true,
          transcript,
          steps
        };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    return { ok: false, step: stepNumber, reason: `unhandled_action:${decision.action}`, keepOpen: true, transcript, steps };
  }

  return { ok: false, reason: 'max_steps_reached', keepOpen: true, transcript, steps };
}

/** Poll the cheap fingerprint until the page moves on, or give up. */
export async function waitForStepChange({ evaluate, before = null, timeoutMs = 15_000, pollMs = 500 } = {}) {
  const startedAt = Date.now();
  let after = null;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    after = await evaluate(stepFingerprintExpr());
    if (!after?.ok) continue;
    // Prefer the page's own step number; fall back to the text digest when it shows none.
    const moved = (before?.step != null && after.step != null)
      ? after.step !== before.step
      : after.fingerprint !== before?.fingerprint;
    if (moved) return { moved: true, after };
  }
  return { moved: false, after };
}

/** One line a human can act on, for the transcript's last entry. */
export function describeOutcome(result = {}) {
  if (result.handoff && result.reason === 'human_boundary') {
    return `Stopped at step ${result.step} — that one is yours. The page is open and untouched.`;
  }
  if (result.reason === 'typing_test_is_human') {
    return `Stopped at the typing test (step ${result.step}). It measures you, so it is yours to type. The page is open.`;
  }
  if (result.reason === 'required_field_unmapped') {
    const names = (result.needsValues || []).map((f) => f.label).join(', ');
    return `Needs values for: ${names}. Nothing was guessed and the page is still open.`;
  }
  if (result.reason === 'step_not_advanced') {
    const errors = (result.errors || []).join(' / ');
    return `The page did not move past step ${result.step}${errors ? `: ${errors}` : ' (no message shown)'}`;
  }
  if (result.ok && result.handoff) return `Stopped at step ${result.step}. The page is open.`;
  if (result.ok) return 'Finished without needing a human.';
  return `Stopped: ${result.reason || 'unknown'}`;
}

