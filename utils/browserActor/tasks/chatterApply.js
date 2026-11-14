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
  buttons: Object.freeze({
    next: ['next', 'continue', 'save and continue', 'proceed'],
    start: ['start', 'start test', 'begin', 'begin test', 'start typing'],
    /** Never clicked, at any step, whatever the config says. */
    forbidden: ['submit', 'send application', 'apply now', 'finish application']
  })
});

/**
 * The funnel, as data — extracted from the app's own bundle on 2026-11-13.
 *
 * The saved `/apply` page carries no markup, but the form's bundle (`/apply/form/assets/B45XV0Dm.js`)
 * ships the whole flow as a literal array of screens and questions. Two funnels are bundled (the second
 * is another tenant's, "Apex Hiring"); this is the live one, and it matches the tenant's own values
 * question for question — including "No" for OnlyFans experience and a blank referral.
 *
 * It matters that this is a *list of questions*, not of screens: "step 8 = No" only makes sense once you
 * know question 8 is "Have you worked with OnlyFans before?". The runner now checks ids, so it can tell
 * it is on the screen it thinks it is on instead of trusting a counter.
 */
export const FUNNEL = Object.freeze([
  { id: 'welcome', title: 'Welcome', questions: [{ id: 'intro', type: 'info', label: 'Apply to Join The Team' }] },
  {
    id: 'age_verification',
    title: 'Age Verification',
    questions: [{ id: 'ageCheck', type: 'mcq', label: 'Are you 18+?', required: true, options: ['Yes', 'No'] }]
  },
  {
    id: 'personal',
    title: 'Personal Details',
    questions: [
      { id: 'fullName', type: 'text', label: 'Full Name', required: true },
      // Their "SaddyMalingu" is the Discord handle, not a website username.
      { id: 'discordUsername', type: 'text', label: 'Discord Username', required: true },
      { id: 'country', type: 'text', label: 'Country', required: true },
      { id: 'email', type: 'email', label: 'Email Address', required: true },
      { id: 'phone', type: 'phone', label: 'Contact Number', required: true }
    ]
  },
  {
    id: 'discovery',
    title: 'Discovery',
    questions: [
      { id: 'hasExperience', type: 'mcq', label: 'Have you worked with OnlyFans before?', required: true, options: ['Yes', 'No'] },
      // Optional: "Leave blank if No" — so a blank is a valid answer, not a missing one.
      { id: 'experienceDetails', type: 'long_text', label: 'If yes, please list the agencies and describe your experience.', required: false },
      { id: 'source', type: 'mcq', label: 'How did you find this recruitment server?', required: true, options: ['Discord', 'Telegram', 'Reddit', 'Google', 'Facebook', 'Friend'] },
      { id: 'referral', type: 'text', label: 'Were you referred by someone? (If yes, include their name)', required: false }
    ]
  },
  { id: 'setup', title: 'Tech Setup', questions: [{ id: 'deskPhoto', type: 'upload', label: 'Desk Photo', required: true }] },
  { id: 'proof', title: 'Proof of Work', questions: [{ id: 'proofOfWork', type: 'proof_of_work', label: 'Proof of work', required: true }] },
  {
    id: 'speed_typing',
    title: 'Speed & Typing',
    questions: [
      { id: 'speedTest', type: 'speed_test', label: 'Internet Speed Test', required: true, validation: { min: 70 } },
      { id: 'typingTest', type: 'typing_test', label: 'Typing Test', required: true, validation: { min: 70 } }
    ]
  },
  { id: 'english_test', title: 'English Proficiency', questions: [{ id: 'englishTest', type: 'english_test', label: 'English Proficiency Test', required: true }] },
  { id: 'behavioural', title: 'Behavioural & Analytical', questions: [] },
  {
    id: 'creativity',
    title: 'Writing + Creativity + Sales',
    questions: [
      { id: 'salesProcess', type: 'long_text', label: 'Describe your step by step process for how you lead a new fan to a sale.', required: true },
      { id: 'captionShower', type: 'long_text', label: 'Write the caption for this PPV content: Shower Video', required: true },
      { id: 'captionStrip', type: 'long_text', label: 'Write the caption for this PPV content: Strip Video', required: true },
      { id: 'captionExplicit', type: 'long_text', label: 'Write the caption for this PPV message: Explicit Video', required: true }
    ]
  },
  { id: 'final', title: 'Final Step', questions: [{ id: 'voiceIntro', type: 'voice', label: 'Voice Introduction', required: false }] }
]);

/**
 * Question types no agent should ever answer, whatever the config says.
 *
 * - `typing_test` / `english_test` / `voice` measure the applicant. A machine taking them reports a
 *   competence nobody demonstrated, to an employer who then hires on it.
 * - `proof_of_work` asks for results previously delivered; there is nothing to fill in, and inventing
 *   something would be fabrication.
 * - `upload` needs a file the human chose.
 *
 * `--include-typing` lifts the typing test only. Nothing lifts the rest.
 */
export const HUMAN_ONLY_TYPES = Object.freeze({
  typing_test: 'measures your typing speed',
  english_test: 'measures your English',
  voice: 'records your voice',
  proof_of_work: 'asks for work you have already delivered'
});

/** The screen the runner stops in front of: the one after the typing test. */
export const STOP_SCREEN = 'english_test';

/**
 * The live funnel's numbering, generated from the app's own bundle.
 *
 * The page prints "Step 14 of 21", so `stepNumber` is not a guess — it identifies the question exactly, and
 * this maps it. `questionByStep(15)` is the English test, `(14)` the typing test. Regenerate with
 * `npm run chatterapply:funnel` when their flow changes.
 */
import { LIVE_FUNNEL, LIVE_STEP_COUNT, liveQuestions, questionByStep } from './chatterApplyFunnel.js';
export { LIVE_FUNNEL, LIVE_STEP_COUNT, liveQuestions, questionByStep };

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
    // File inputs are kept deliberately: the desk photo is a required upload and has to be reported as
    // one. They are never written as text — the caller attaches a real file through the browser protocol.
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(String(el.type || '').toLowerCase()))
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
  /**
   * The page keeps every step mounted and slides between them, so the FIRST "Step N of 21" in the document is
   * not the one on screen (2026-11-14: it read step 8 while the form stood on step 10, and the run then pressed
   * Next on screens it was not looking at until maxSteps ran out). Only visible text counts, and among visible
   * candidates the one filling most of the viewport wins.
   */
  const inView = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (!rect) return 0;
    const win = doc.defaultView || window;
    const vw = win.innerWidth || 0;
    const vh = win.innerHeight || 0;
    const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    return w * h;
  };
  const counterPattern = new RegExp('^(?:step[ ]*)?([0-9]{1,2})[ ]*(?:of|/)[ ]*([0-9]{1,2})$', 'i');
  const onScreen = Array.from(doc.querySelectorAll('body *'))
    .filter((el) => el.children.length === 0 && visible(el))
    .map((el) => ({ text: clean(el.textContent), area: inView(el) }))
    .filter((row) => row.text && counterPattern.test(row.text) && row.area > 0)
    .sort((a, b) => b.area - a.area)[0] || null;
  const onScreenStep = onScreen ? Number(onScreen.text.match(/[0-9]{1,2}/)[0]) : null;
  const onScreenHeadings = Array.from(doc.querySelectorAll('h1, h2, h3, legend'))
    .filter(visible)
    .map((el) => clean(el.innerText || el.textContent))
    .filter(Boolean)
    .slice(0, 6);



  return JSON.stringify({
    ok: true,
    mode: found.mode,
    frameSrc: found.frameSrc,
    url: String(doc.location ? doc.location.href : ''),
    progressText: onScreenStep != null ? onScreen.text : progressText,
    step: onScreenStep != null ? onScreenStep : current,
    headings: onScreenHeadings.length ? onScreenHeadings : headings,
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
    index: Number.isInteger(row.index) ? row.index : null,
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

  /**
   * The reader's own order, reproduced so a positional write lands on the field it read (2026-11-14).
   *
   * This form renders inputs with **no name, no id and no label** — step 3's Full Name field is anonymous but
   * for its placeholder — so name/id/label lookup found nothing and the write failed with field_not_found on a
   * field the reader had just read successfully. The reader's index is the field's position in this exact list:
   * same selector, same exclusions, same visibility rule. A file input keeps its place (so indices do not
   * shift) but is never written.
   */
  const visible = (el) => {
    if (!el) return false;
    if (String(el.type || '').toLowerCase() === 'hidden') return false;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };
  const readOrder = Array.from(doc.querySelectorAll('input, select, textarea'))
    .filter((el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(String(el.type || '').toLowerCase()))
    .filter(visible);

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
      const byLabel = all.find((el) => labelFor(el).toLowerCase() === key);
      if (byLabel) return byLabel;
    }
    if (Number.isInteger(write.index)) {
      const positional = readOrder[write.index];
      if (positional && String(positional.type || '').toLowerCase() !== 'file') return positional;
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
      index: field.index,
      type: field.type,
      value: desired
    });
  }

  return { values, unresolved, unmapped, skipped };
}

/**
 * Which screen is on display?
 *
 * Matched on the page's own title/heading first, then on the question ids the DOM exposes — never on a
 * counter, because the tenant's "step 12" and the app's twelve are not the same twelve. Returns null
 * when it does not recognise the screen, which is a fact the caller has to handle rather than assume.
 */
export function screenFor(snapshot = {}) {
  const headings = (snapshot.headings || []).map((h) => normaliseLabel(h));
  const bodyStart = normaliseLabel(snapshot.text || '');
  const fieldNames = new Set(
    (snapshot.fields || []).flatMap((f) => [f.name, f.id]).filter(Boolean).map((v) => String(v))
  );
  // A question id in the DOM is the strongest signal: these names are the app's own.
  let best = null;
  let bestScore = 0;
  for (const screen of FUNNEL) {
    let score = 0;
    for (const question of screen.questions) {
      if (fieldNames.has(question.id)) score += 3;
      if (normaliseLabel(question.label) && bodyStart.includes(normaliseLabel(question.label))) score += 2;
    }
    if (headings.some((h) => h && normaliseLabel(screen.title).includes(h))) score += 2;
    if (score > bestScore) { best = screen; bestScore = score; }
  }
  return bestScore > 0 ? { ...best, score: bestScore } : null;
}

/**
 * The reason a screen must be left to a human, or null.
 *
 * Only the typing test can be lifted (`includeTyping`), and only because a tenant may decide the number
 * is theirs to own. Everything else here stays human.
 */
export function humanOnlyReason(screen, { includeTyping = false } = {}) {
  if (!screen) return null;
  for (const question of screen.questions || []) {
    const type = question.type;
    if (!HUMAN_ONLY_TYPES[type]) continue;
    if (type === 'typing_test' && includeTyping) continue;
    if (type === 'upload') continue; // an upload is a file the human picked; handled separately
    return { screen: screen.id, question: question.id, type, why: HUMAN_ONLY_TYPES[type] };
  }
  return null;
}

/**
 * Pick the values to write on this screen.
 *
 * Prefers the question **id** the app uses (`fullName`, `hasExperience`, …) because that is exact; only
 * falls back to matching a label when the DOM does not expose an id, which is what the generic mapper is
 * for. A required question with no value in the profile is reported, never invented.
 */
export function planScreenValues({ screen = null, fields = [], profile = {}, includeTyping = false, stepNumber = null } = {}) {
  if (!screen) return planStepValues({ fields, profile });

  /**
   * The step number is the last resort for naming a field (2026-11-14).
   *
   * Live, this form renders one question per step with **no label and no name** on the input — the only text
   * is the placeholder (`e.g. John Doe`) — so matching by label found nothing and the run stopped at step 3
   * with Next disabled. The page's own numbering does name it: step 3 is `fullName`. Used only when the field
   * could not be identified any other way and the step shows exactly one writable field, so a value can never
   * be written twice across fields the page did name.
   */
  const onStep = stepNumber != null ? questionByStep(stepNumber) : null;
  const stepQuestion = onStep && onStep.screen?.id === screen.id ? onStep.question : null;
  const writable = fields.filter((f) => f.type !== 'file' && !f.disabled);
  const soleStepQuestion = writable.length === 1 ? stepQuestion : null;

  const byId = new Map();
  for (const question of screen.questions || []) byId.set(question.id, question);

  const values = [];
  const unresolved = [];
  const unmapped = [];
  const skipped = [];
  const uploads = [];

  for (const field of fields) {
    if (field.disabled) { skipped.push({ label: field.label, reason: 'disabled' }); continue; }

    // The app names its inputs after the question id; that is the exact answer to "which field is this".
    const direct = byId.get(field.name) || byId.get(field.id);
    const labelMatch = (screen.questions || []).find(
      (q) => normaliseLabel(q.label) && normaliseLabel(q.label) === normaliseLabel(field.label)
    );
    const fileInputs = fields.filter((f) => f.type === 'file');
    const uploadQuestions = (screen.questions || []).filter((q) => q.type === 'upload');
    // react-dropzone's input is invisible and often unnamed, so one file field on a screen with one
    // upload question can only be that question.
    const soleUpload = field.type === 'file' && fileInputs.length === 1 && uploadQuestions.length === 1
      ? uploadQuestions[0]
      : null;
    const question = direct || labelMatch || soleUpload
      || (soleStepQuestion && !matchFieldKey(field) ? soleStepQuestion : null);
    const key = question ? question.id : matchFieldKey(field);
    const raw = key ? profile[key] : undefined;
    const hasValue = raw !== undefined && raw !== null && String(raw).trim() !== '';

    // A file is attached, never typed: a path written into a text box is a broken application.
    if (field.type === 'file' || question?.type === 'upload') {
      const entry = {
        label: question?.label || field.label || 'Upload',
        name: field.name || '',
        id: field.id || '',
        key: key || null
      };
      if (hasValue) uploads.push({ ...entry, path: String(raw) });
      else (question?.required === false ? unmapped : unresolved).push({
        ...entry,
        reason: key ? 'upload_file_missing' : 'unrecognised_upload'
      });
      continue;
    }

    if (question && HUMAN_ONLY_TYPES[question.type]) {
      // Never answered by the agent, so it is not "missing" either.
      skipped.push({ label: question.label, reason: 'human_only', type: question.type });
      continue;
    }
    if (!hasValue) {
      const entry = {
        label: question?.label || field.label || field.placeholder || field.name || `field #${field.index}`,
        name: field.name || '',
        id: field.id || '',
        type: field.type,
        key: key || null,
        reason: key ? 'profile_value_missing' : 'unrecognised_field'
      };
      (question ? question.required : field.required) ? unresolved.push(entry) : unmapped.push(entry);
      continue;
    }

    const desired = Array.isArray(raw) ? raw.join(', ') : String(raw);
    const already = String(field.value == null ? '' : field.value).trim() === desired.trim()
      || (field.type === 'checkbox' && String(Boolean(field.checked)) === String(/^(true|yes|on|1)$/i.test(desired)));
    if (already) { skipped.push({ label: question?.label || field.label, reason: 'already_set', key }); continue; }

    // An option list means the value has to be one of those options; a typo must not become an answer.
    if (Array.isArray(question?.options) && question.options.length) {
      const hit = question.options.find((o) => o.toLowerCase() === desired.toLowerCase())
        || question.options.find((o) => o.toLowerCase().startsWith(desired.toLowerCase()));
      if (!hit) {
        unresolved.push({
          label: question.label, name: field.name || '', id: field.id || '', key,
          reason: 'not_an_option', options: question.options, wanted: desired
        });
        continue;
      }
      values.push({ key, label: question.label, name: field.name || '', id: field.id || '', index: field.index, type: field.type, value: hit });
      continue;
    }
    values.push({ key, label: question?.label || field.label, name: field.name || '', id: field.id || '', index: field.index, type: field.type, value: desired });
  }

  return { values, unresolved, unmapped, skipped, uploads, screen: screen.id };
}
/**
 * What to do with the screen that is on display. Pure, so the policy is testable without a browser.
 *
 * The ordering encodes the safety rules: the stop screen and the human-only questions are checked before
 * anything is written, the speed test is started and waited for rather than answered, and a required
 * question with no value in the profile stops the run instead of being filled with a guess.
 */
export function decideStep({ snapshot = {}, plan = null, screen = null, stepNumber = null, options = {} } = {}) {
  const { includeTyping = false, stopScreen = STOP_SCREEN, speedScreen = 'speed_typing' } = options;

  if (!snapshot.ok) {
    return { action: 'stop', reason: snapshot.reason || 'unreadable', detail: snapshot.detail || null };
  }

  // The page numbers its questions, so the step identifies the question exactly — the most precise signal
  // available and the one the applicant reads on screen. Checked first, because a human-only question must
  // stop the run even if the screen could not be recognised from its headings.
  const atStep = stepNumber != null ? questionByStep(stepNumber) : null;
  if (atStep?.question?.type) {
    const type = atStep.question.type;
    const liftable = type === 'typing_test' && includeTyping;
    if (HUMAN_ONLY_TYPES[type] && !liftable) {
      return {
        action: 'handoff',
        reason: type === 'english_test' ? 'human_boundary' : 'human_only_question',
        step: stepNumber,
        question: atStep.question.id,
        screen: atStep.screen?.id || null,
        why: HUMAN_ONLY_TYPES[type]
      };
    }
    // The page's own measurements. Waiting is the only correct action: the number is theirs, not ours.
    if (type === 'speed_test') {
      const start = (snapshot.buttons || []).find((b) => /^(start|begin)/i.test(b.label) && !b.disabled);
      if (start) return { action: 'start_measurement', reason: 'speed_test_offered', step: stepNumber, button: start.label };
      const canMoveOn = (snapshot.buttons || []).some(
        (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
      );
      if (!canMoveOn) return { action: 'wait_measurement', reason: 'speed_test_running', step: stepNumber };
    }
    // A typing test the tenant has claimed: type the passage the page shows, then let it score.
    if (liftable) {
      return { action: 'typing_test', reason: 'typing_claimed', step: stepNumber, question: atStep.question.id };
    }
  }

  // The screen the tenant keeps: reached, so stop with the page exactly as it is.
  if (screen?.id === stopScreen) {
    return { action: 'handoff', reason: 'human_boundary', screen: screen.id, step: stepNumber ?? snapshot.step ?? null };
  }

  // A question that measures the applicant, or asks for work already delivered.
  const humanOnly = humanOnlyReason(screen, { includeTyping });

  // The page's own measurement comes first, because it is work the page does rather than a question:
  // start it if it is offered, wait while there is no way forward, and fall through once it is done.
  const measuring = (screen?.id === speedScreen) || snapshot.measurements?.speed;
  if (measuring && !plan?.values?.length) {
    const start = (snapshot.buttons || []).find((b) => /^(start|begin)/i.test(b.label) && !b.disabled);
    if (start) return { action: 'start_measurement', reason: 'speed_test_offered', step: stepNumber, button: start.label };
    const canMoveOn = (snapshot.buttons || []).some(
      (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
    );
    // Only wait while the page offers no way forward; otherwise the measurement has finished and the
    // screen's remaining question (usually the typing test) decides what happens next.
    if (!canMoveOn && snapshot.measurements?.speed) {
      return { action: 'wait_measurement', reason: 'speed_test_running', step: stepNumber };
    }
  }

  if (humanOnly) {
    return {
      action: 'handoff',
      reason: 'human_only_question',
      screen: humanOnly.screen,
      question: humanOnly.question,
      why: humanOnly.why,
      step: stepNumber ?? snapshot.step ?? null
    };
  }

  if (plan?.unresolved?.length) {
    return { action: 'needs_values', reason: 'required_field_unmapped', step: stepNumber, unresolved: plan.unresolved };
  }
  // A chosen file is attached through the browser protocol, not typed into a field.
  if (plan?.uploads?.length) {
    return { action: 'upload', reason: 'file_to_attach', step: stepNumber, uploads: plan.uploads };
  }
  if (plan?.values?.length) {
    return { action: 'fill', reason: 'fields_to_fill', step: stepNumber, values: plan.values };
  }

  // A multiple-choice answer rendered as buttons. Only when the page is still blocking: if Next is
  // already enabled the question is answered or optional, and clicking again could toggle it off.
  const nextReady = (snapshot.buttons || []).some(
    (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
  );
  if (plan?.choices?.length && !nextReady) {
    return { action: 'choose', reason: 'multiple_choice', step: stepNumber, choices: plan.choices };
  }

  // The typing test, when the tenant has claimed it: type the passage, then let the page score it.
  if (screen?.questions?.some((q) => q.type === 'typing_test') && includeTyping) {
    return { action: 'typing_test', reason: 'typing_claimed', step: stepNumber };
  }

  const next = (snapshot.buttons || []).find(
    (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
  );

  /**
   * Never advance a screen we could not read (2026-11-14).
   *
   * The first live run reached an unrecognised screen, read zero fields, found an enabled Next and pressed
   * it — seven times — skipping the applicant's name, contact details and experience. A screen with no
   * fields, no choices, no uploads and no known info step is either unknown or not rendered yet, and the
   * only safe action is to stop and show what is on it.
   */
  const readNothing = !(snapshot.fields || []).length
    && !plan?.values?.length
    && !plan?.choices?.length
    && !plan?.uploads?.length;
  const knownInfo = Boolean(screen && (screen.questions || []).length
    && (screen.questions || []).every((q) => ['info', 'mcq', 'speed_test', 'typing_test', 'english_test', 'voice', 'proof_of_work'].includes(q.type)));
  if (readNothing && !screen && next) {
    return {
      action: 'stop',
      reason: 'unrecognised_screen',
      step: stepNumber,
      heading: (snapshot.headings || [])[0] || null,
      buttons: (snapshot.buttons || []).map((b) => b.label),
      detail: 'Nothing on this screen could be read, so filling it or advancing past it would be a guess.'
    };
  }

  if (next) return { action: 'advance', reason: 'ready_for_next', step: stepNumber, button: next.label };

  /**
   * Next disabled with an *optional* field still empty means the page is waiting for that field anyway, not
   * that the step is unreadable (2026-11-14). The live run stopped at step 3 as `no_next_button` when the
   * truth was "Full Name is empty" — the input had no label, so it was never planned. (A required field never
   * reaches here: it is reported as `required_field_unmapped` above.) Naming the question is the difference
   * between a report a person can act on and one they have to reverse-engineer.
   */
  if (plan?.unmapped?.length && !next) {
    return {
      action: 'needs_values',
      reason: 'page_wants_this_field',
      step: stepNumber,
      screen: screen?.id || null,
      unresolved: plan.unmapped
    };
  }

  return { action: 'stuck', reason: 'no_next_button', step: stepNumber, buttons: (snapshot.buttons || []).map((b) => b.label) };
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
export async function runApplication({
  evaluate,
  attachFile = null,
  clickOption = null,
  profile = {},
  options = {},
  log = () => {}
} = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('runApplication needs an evaluate() function');
  const {
    maxSteps = 20,
    settleMs = 800,
    advanceTimeoutMs = 15_000,
    measureTimeoutMs = 60_000,
    pollMs = 500,
    dryRun = false,
    typingWpm = 70,
    waitForHumanMs = 0,
    ...policy
  } = options;

  const transcript = [];
  const steps = [];
  // A screen is read more than once, so an upload must be remembered by what it was, not by "did we".
  const attached = new Set();
  // Nothing may be repeated indefinitely: earlier, a click that never took looped seven times over the
  // same option. Three identical attempts on the same step is a bug or a page we cannot drive, not a retry.
  let lastSignature = null;
  let repeatCount = 0;
  // The highest step reached, so a read that goes backwards is caught instead of clicked.
  let lastStepNumber = null;
  const note = (entry) => { transcript.push(entry); log(entry); return entry; };

  for (let index = 0; index < maxSteps; index += 1) {
    const snapshot = await evaluate(readStepExpr());
    if (!snapshot?.ok) {
      note({ event: 'unreadable', reason: snapshot?.reason || 'unknown', detail: snapshot?.detail || null });
      return { ok: false, reason: snapshot?.reason || 'unreadable', transcript, steps, keepOpen: true };
    }

    // Which screen this is, by the app's own title and question ids — never by a counter, because the
    // tenant's "step 12" and the app's twelfth screen are not the same thing.
    const screen = screenFor(snapshot);
    // The page's own "Step 14 of 21" is the identity when it offers one; a derived counter is not, because
    // it increments on every read and turns one screen into twelve.
    const stepNumber = snapshot.step ?? null;

    /**
     * Never walk backwards (2026-11-14). Live, a mis-read step number sent this loop to step 8 while the form
     * stood on 10, and it then pressed Next on 8, 9, 8, 9, 9, 5, 6 until maxSteps ran out — twenty clicks on
     * screens it was not looking at. A step that decreases is a page this loop does not understand, so it stops
     * and says so, leaving the browser as it is.
     */
    if (stepNumber != null && lastStepNumber != null && stepNumber < lastStepNumber) {
      note({ event: 'step-went-backwards', from: lastStepNumber, to: stepNumber, heading: (snapshot.headings || [])[0] || null });
      return {
        ok: false,
        handoff: true,
        step: stepNumber,
        reason: 'step_went_backwards',
        detail: { from: lastStepNumber, to: stepNumber },
        keepOpen: true,
        transcript,
        steps
      };
    }
    if (stepNumber != null) lastStepNumber = stepNumber;
    const stepKey = stepNumber != null
      ? `step:${stepNumber}`
      : (screen?.id ? `screen:${screen.id}` : `view:${(snapshot.headings || [])[0] || 'unknown'}`);
    const plan = planScreenValues({
      screen,
      fields: snapshot.fields || [],
      profile,
      includeTyping: policy.includeTyping,
      stepNumber
    });
    // A screen's multiple-choice questions may be buttons rather than inputs, so they are planned here
    // and travel with the plan into the decision.
    plan.choices = planChoices({ screen, buttons: snapshot.buttons || [], profile }).choices;
    // Drop files this run has already attached to this screen, so a re-read advances instead of
    // attaching the same photo again.
    if (plan.uploads?.length) {
      plan.uploads = plan.uploads.filter((upload) => {
        const key = `${screen?.id || ''}:${upload.key || upload.name || upload.label}:${upload.path}`;
        return !attached.has(key);
      });
    }
    // One record per step, not per read. A step is read more than once — before filling and again
    // before advancing — and appending each read would make a five-iteration run look like five
    // different steps to the person reading the summary. The first non-empty plan is what was filled.
    const record = {
      step: stepNumber,
      screen: screen?.id || null,
      screenTitle: screen?.title || null,
      headings: snapshot.headings,
      progressText: snapshot.progressText,
      fields: (snapshot.fields || []).map((f) => ({
        label: f.label, name: f.name, type: f.type, required: f.required, value: f.value
      })),
      buttons: (snapshot.buttons || []).map((b) => b.label),
      measurements: snapshot.measurements,
      planned: plan.values.map((v) => ({ key: v.key, label: v.label, value: v.value })),
      uploads: plan.uploads || [],
      unresolved: plan.unresolved,
      unmapped: plan.unmapped,
      attempts: 1
    };
    const existing = steps.find((s) => s.key === stepKey);
    if (existing) {
      existing.attempts += 1;
      existing.fields = record.fields;
      existing.buttons = record.buttons;
      existing.screen = record.screen || existing.screen;
      if (!existing.planned.length && record.planned.length) existing.planned = record.planned;
      if (!existing.uploads.length && record.uploads.length) existing.uploads = record.uploads;
      if (!existing.unresolved.length && record.unresolved.length) existing.unresolved = record.unresolved;
      existing.unmapped = record.unmapped.length ? record.unmapped : existing.unmapped;
    } else {
      steps.push({ ...record, key: stepKey });
    }

    const decision = decideStep({ snapshot, plan, screen, stepNumber, options: policy });
    note({
      event: 'decide',
      step: stepNumber,
      screen: screen?.id || null,
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

    // The loop breaker: same step, same action, three times running.
    const signature = `${stepKey}|${decision.action}`;
    repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
    lastSignature = signature;
    if (repeatCount >= 3) {
      note({ event: 'no-progress', step: stepNumber, action: decision.action, repeats: repeatCount });
      return {
        ok: false,
        step: stepNumber,
        reason: 'no_progress',
        detail: decision,
        keepOpen: true,
        transcript,
        steps
      };
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

    if (decision.action === 'choose') {
      // With --wait-human, a blocked question is handed to the person at the keyboard: this app ignores
      // programmatic clicks, so asking is the only reliable way past it — and asking beats failing.
      if (waitForHumanMs > 0) {
        note({
          event: 'human-needed',
          step: stepNumber,
          question: decision.choices[0]?.question || null,
          label: decision.choices[0]?.label || null,
          options: decision.choices.map((c) => c.option),
          waitingMs: waitForHumanMs
        });
        const waited = await waitForHuman({
          evaluate,
          previous: { step: stepNumber, progressText: snapshot.progressText },
          timeoutMs: waitForHumanMs,
          pollMs: Math.max(500, pollMs)
        });
        if (waited.ok) {
          note({ event: 'human-answered', step: stepNumber, waitedMs: waited.waitedMs });
          await new Promise((r) => setTimeout(r, settleMs));
          continue;
        }
        return {
          ok: false,
          handoff: true,
          step: stepNumber,
          reason: 'human_timeout',
          needsHuman: { question: decision.choices[0]?.question || null, options: decision.choices.map((c) => c.option) },
          waitedMs: waited.waitedMs,
          keepOpen: true,
          transcript,
          steps
        };
      }

      // Click each option, then confirm the page stopped blocking. A click that a re-render swallowed
      // leaves Next disabled, and that must surface here rather than as a stuck screen three reads later.
      const picked = [];
      for (const choice of decision.choices) {
        // Trusted click when the caller supplies one; this app ignores dispatched events.
        const result = typeof clickOption === 'function'
          ? await clickOption(choice)
          : await evaluate(chooseOptionExpr({ option: choice.option, question: choice.question }));
        picked.push({ ...choice, ok: Boolean(result?.ok), label: result?.label || null, reason: result?.reason || null });
      }
      note({
        event: 'choose',
        step: stepNumber,
        picked: picked.filter((p) => p.ok).length,
        total: picked.length,
        options: picked.map((p) => p.option)
      });
      const missed = picked.filter((p) => !p.ok);
      if (missed.length) {
        return { ok: false, step: stepNumber, reason: 'choice_failed', failures: missed, keepOpen: true, transcript, steps };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    if (decision.action === 'upload') {
      // A file input cannot be given a value by script; the caller attaches it through the protocol.
      if (typeof attachFile !== 'function') {
        return {
          ok: false,
          step: stepNumber,
          reason: 'upload_not_supported',
          uploads: decision.uploads,
          keepOpen: true,
          transcript,
          steps
        };
      }
      const attachedResults = [];
      for (const upload of decision.uploads) {
        const result = await attachFile(upload);
        attachedResults.push({ ...upload, ok: Boolean(result?.ok), detail: result?.detail || null });
        if (result?.ok) attached.add(`${screen?.id || ''}:${upload.key || upload.name || upload.label}:${upload.path}`);
      }
      note({ event: 'upload', step: stepNumber, attached: attachedResults.filter((a) => a.ok).length, total: attachedResults.length });
      const failed = attachedResults.filter((a) => !a.ok);
      if (failed.length) {
        return { ok: false, step: stepNumber, reason: 'upload_failed', failures: failed, keepOpen: true, transcript, steps };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    if (decision.action === 'typing_test') {
      // Only reachable with includeTyping, and only after the passage has been read and shown.
      const prompt = await evaluate(typingPromptExpr());
      if (!prompt?.ok) {
        return {
          ok: false,
          step: stepNumber,
          reason: prompt?.reason || 'typing_prompt_not_found',
          detail: prompt,
          keepOpen: true,
          transcript,
          steps
        };
      }
      note({ event: 'typing-start', step: stepNumber, chars: prompt.promptLength, wpm: typingWpm, passage: String(prompt.prompt).slice(0, 120) });
      const typed = await evaluate(typeAtWpmExpr({ text: prompt.prompt, wpm: typingWpm }), { awaitPromise: true });
      note({ event: 'typing-done', step: stepNumber, typed: typed?.typed || 0, wpm: typed?.effectiveWpm ?? null });
      if (!typed?.ok) {
        return { ok: false, step: stepNumber, reason: 'typing_failed', detail: typed, keepOpen: true, transcript, steps };
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
    return `Stopped at the English Proficiency screen — that one is yours. The page is open and untouched.`;
  }
  if (result.reason === 'human_only_question') {
    return `Stopped: the next question ${result.why || 'is not one an agent should answer'}`
      + ` (${result.question || 'unspecified'}). The page is open.`;
  }
  if (result.reason === 'required_field_unmapped') {
    const names = (result.needsValues || []).map((f) => f.label).join(', ');
    return `Needs values for: ${names}. Nothing was guessed and the page is still open.`;
  }
  if (result.reason === 'upload_not_supported') {
    const names = (result.uploads || []).map((u) => u.label).join(', ');
    return `A file is required (${names}) and no file channel was provided; re-run with --desk-photo.`;
  }
  if (result.reason === 'upload_failed') {
    return `The file could not be attached: ${(result.failures || []).map((f) => f.detail || f.reason).join(' / ')}`;
  }
  if (result.reason === 'step_not_advanced') {
    const errors = (result.errors || []).join(' / ');
    return `The page did not move past step ${result.step}${errors ? `: ${errors}` : ' (no message shown)'}`;
  }
  if (result.ok && result.handoff) return `Stopped at step ${result.step}. The page is open.`;
  if (result.ok) return 'Finished without needing a human.';
  return `Stopped: ${result.reason || 'unknown'}`;
}


/*
 * ─── The two mechanics that are not form writing ────────────────────────────────────────────────
 *
 * The desk photo is a react-dropzone input: hidden, clipped to 1px, and driven by `onChange`. A file
 * input's value cannot be assigned from script at all, so the only way in is the browser protocol
 * (`DOM.setFileInputFiles`), which takes an element reference. `fileInputExpr` therefore returns the
 * element itself rather than JSON.
 */

/**
 * The element a file should be attached to. Evaluated with `returnByValue: false` so the caller gets an
 * objectId it can hand to `DOM.setFileInputFiles`.
 */
export function fileInputExpr({ name = '', id = '' } = {}) {
  return `(() => {
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return null;
  const inputs = Array.from(found.doc.querySelectorAll('input[type="file"]'));
  if (!inputs.length) return null;
  const wanted = ${JSON.stringify({ name: String(name || ''), id: String(id || '') })};
  return (wanted.name && inputs.find((el) => el.getAttribute('name') === wanted.name))
    || (wanted.id && inputs.find((el) => el.getAttribute('id') === wanted.id))
    || inputs[0]
    || null;
})()`;
}

/**
 * Find the passage to type and the box to type it into.
 *
 * Both are inferences about an unknown widget, so both are reported rather than assumed: the caller sees
 * the passage it found, its length and the field it will use. If no passage can be identified with
 * confidence the run stops — typing the wrong words scores zero and looks like a slow applicant.
 */
export function typingPromptExpr() {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;

  const visible = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };

  // Where the typing goes: an empty, visible textarea first, then an empty text input.
  const boxes = Array.from(doc.querySelectorAll('textarea, input[type="text"]'))
    .filter(visible)
    .filter((el) => !el.disabled && !el.readOnly);
  const target = boxes.find((el) => el.tagName === 'TEXTAREA' && !clean(el.value))
    || boxes.find((el) => !clean(el.value))
    || null;
  if (!target) return JSON.stringify({ ok: false, reason: 'typing_box_not_found' });

  // The passage: long text that is not the box and is not the page's own instructions.
  const candidates = Array.from(doc.querySelectorAll('p, div, span, pre, blockquote, h4, h5'))
    // Anything that wraps the box is not the passage. Guarded because a detached or exotic node may
    // not implement contains, and one bad node must not abort the search.
    .filter((el) => {
      try { return !el.contains(target) && !target.contains(el); } catch (e) { return true; }
    })
    .filter(visible)
    .map((el) => clean(el.innerText || el.textContent))
    .filter((text) => text.length >= 80 && text.split(' ').length >= 12)
    .filter((text) => !/apply to join|this application process|upload|wpm|good luck/i.test(text));
  // The shortest candidate that is still a passage is usually the passage, not its wrapper.
  candidates.sort((a, b) => a.length - b.length);
  const prompt = candidates[0] || null;

  return JSON.stringify({
    ok: Boolean(prompt),
    reason: prompt ? null : 'typing_prompt_not_found',
    prompt,
    promptLength: prompt ? prompt.length : 0,
    candidateCount: candidates.length,
    target: { tag: target.tagName.toLowerCase(), name: target.getAttribute('name') || '', id: target.getAttribute('id') || '' }
  });
})()`;
}


/**
 * Type a passage at a given words-per-minute pace — only when a tenant has claimed the typing test.
 *
 * Five characters to a word, so the per-character delay is `60000 / (wpm * 5)` ms. Each character goes
 * through the native setter with a real `input` event, because one bulk assignment would register an
 * impossible speed and score nothing.
 *
 * This is the only place a machine produces a number a person is judged on. It exists because the tenant
 * asked for it by name, and the number is theirs to stand behind.
 */
export function typeAtWpmExpr({ text = '', wpm = 70, jitterMs = 12 } = {}) {
  const safeWpm = Math.max(10, Math.min(300, Number(wpm) || 70));
  const delay = Math.round(60000 / (safeWpm * 5));
  const jitter = Math.max(0, Number(jitterMs) || 0);
  return `(async () => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;
  const view = doc.defaultView || window;
  const text = ${JSON.stringify(String(text))};
  if (!text) return JSON.stringify({ ok: false, reason: 'no_text' });

  const visible = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };
  const target = Array.from(doc.querySelectorAll('textarea, input[type="text"]'))
    .filter(visible)
    .find((el) => !el.disabled && !el.readOnly && !clean(el.value));
  if (!target) return JSON.stringify({ ok: false, reason: 'typing_box_not_found' });

  try { target.focus(); } catch (e) {}
  const proto = target.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const setValue = (value) => {
    if (descriptor && descriptor.set) descriptor.set.call(target, value);
    else target.value = value;
  };

  const startedAt = Date.now();
  let typed = 0;
  for (const ch of text) {
    setValue(text.slice(0, typed + 1));
    const keyInit = { key: ch, bubbles: true };
    target.dispatchEvent(view.KeyboardEvent ? new view.KeyboardEvent('keydown', keyInit) : new view.Event('keydown', { bubbles: true }));
    target.dispatchEvent(new view.Event('input', { bubbles: true }));
    typed += 1;
    // A little variance, so the pace reads as a person's rhythm rather than a metronome.
    const wait = Math.max(4, ${delay} + Math.round((Math.random() - 0.5) * 2 * ${jitter}));
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  target.dispatchEvent(new view.Event('change', { bubbles: true }));
  const elapsedMs = Date.now() - startedAt;
  return JSON.stringify({
    ok: clean(target.value).length > 0,
    typed,
    elapsedMs,
    effectiveWpm: elapsedMs ? Math.round((typed / 5) / (elapsedMs / 60000)) : null,
    target: { tag: target.tagName.toLowerCase(), name: target.getAttribute('name') || '' }
  });
})()`;
}


/**
 * Multiple-choice questions render as **buttons**, not radios (2026-11-14).
 *
 * The first live run reached the age screen and stopped there: `A Yes`, `B No`, `← Previous`, `Next →`,
 * zero `<input>` elements, and `Next →` disabled until an answer is picked. So an MCQ answer has to be
 * *clicked*, and `A Yes` / `1. Yes` / `Yes` are the same option to us.
 *
 * This is the only place this module guesses at a label, so it is narrow: strip a leading option marker,
 * compare case-insensitively, exact match first and a prefix only when nothing matched exactly.

/**
 * Map the funnel: read every screen, advance, record (2026-11-14).
 *
 * The bundle's array described an 11-screen flow; the live application has 21 steps and prints
 * "Step 14 of 21" in the page. Guessing which was which produced the worst outcome of this exercise — a run
 * that pressed Next through the applicant's name and contacts because the screens were unfamiliar. So the
 * funnel is now read from the live app instead of inferred, and this is the reader.
 *
 * Boundaries, because mapping must not quietly become applying:
 *
 *   - **Nothing is typed.** Text fields are recorded as they are and left alone; the live app does not
 *     block Next on them, which is why they can wait for the fill pass.
 *   - **Nothing is uploaded or submitted.** A multiple-choice screen *does* block until answered, so
 *     `answerChoices` clicks the profile's answer and records that it did — there is no other way forward.
 *   - **It stops rather than loops**: a screen seen twice, a click that changes nothing, or no way forward.
 */
export async function mapFunnel({ evaluate, clickOption = null, profile = {}, options = {}, log = () => {} } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('mapFunnel needs an evaluate() function');
  const {
    maxSteps = 30,
    settleMs = 900,
    advanceTimeoutMs = 15_000,
    pollMs = 500,
    answerChoices = true,
    includeTyping = false,
    typingWpm = 70,
    waitForHumanMs = 0
  } = options;

  const steps = [];
  const seen = new Set();
  const note = (entry) => log(entry);

  for (let index = 0; index < maxSteps; index += 1) {
    const snapshot = await evaluate(readStepExpr());
    if (!snapshot?.ok) {
      return { ok: false, reason: snapshot?.reason || 'unreadable', detail: snapshot?.detail || null, steps };
    }

    const screen = screenFor(snapshot);
    const key = snapshot.step != null
      ? `step:${snapshot.step}`
      : `view:${(snapshot.headings || [])[0] || 'unknown'}|${(snapshot.fields || []).length}`;

    const record = {
      key,
      step: snapshot.step ?? null,
      progressText: snapshot.progressText ?? null,
      heading: (snapshot.headings || [])[0] || null,
      headings: snapshot.headings || [],
      screen: screen?.id || null,
      text: String(snapshot.text || '').slice(0, 400),
      measurements: snapshot.measurements || {},
      fields: (snapshot.fields || []).map((f) => ({
        label: f.label,
        name: f.name,
        id: f.id,
        type: f.type,
        required: f.required,
        placeholder: f.placeholder,
        options: f.options ? f.options.map((o) => o.label) : null
      })),
      buttons: (snapshot.buttons || []).map((b) => ({ label: b.label, disabled: Boolean(b.disabled) })),
      advancedBy: null
    };

    // A repeated step is not a loop: answering a question re-renders the same screen with Next enabled.
    // So the identity is the step *and its state* — a screen that comes back unchanged is the loop.
    const stateHash = `${key}|${record.buttons.map((b) => `${b.label}${b.disabled ? '*' : ''}`).join(',')}|${record.fields.length}`;
    if (seen.has(stateHash)) {
      note({ event: 'map-loop', step: record.step, key, state: stateHash });
      return { ok: true, reason: 'loop', at: record.step, steps };
    }
    seen.add(stateHash);
    // One record per step: the second visit updates the buttons rather than adding a duplicate.
    const existing = steps.find((s) => s.key === key);
    if (existing) {
      existing.buttons = record.buttons;
      existing.fields = record.fields;
      existing.text = record.text;
      existing.visits = (existing.visits || 1) + 1;
      note({
        event: 'map-again',
        step: record.step,
        heading: record.heading,
        buttons: record.buttons.map((b) => `${b.label}${b.disabled ? ' (disabled)' : ''}`)
      });
    } else {
      steps.push(record);
      note({
        event: 'map',
        step: record.step,
        heading: record.heading,
        fields: record.fields.length,
        buttons: record.buttons.map((b) => `${b.label}${b.disabled ? ' (disabled)' : ''}`)
      });
    }

    const next = (snapshot.buttons || []).find(
      (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
    );

    if (next) {
      const before = await evaluate(stepFingerprintExpr());
      const clicked = await evaluate(clickButtonExpr({ labels: [next.label] }));
      if (!clicked?.ok) return { ok: false, reason: clicked?.reason || 'click_failed', at: record.step, steps };
      record.advancedBy = `next:${clicked.label}`;
      const changed = await waitForStepChange({ evaluate, before, timeoutMs: advanceTimeoutMs, pollMs });
      if (!changed.moved) {
        return { ok: true, reason: 'stuck', at: record.step, detail: 'Next did not move the page', steps };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    // Next is blocked: on this app that means a question needs answering — including the typing test,
    // which is a human's to take and therefore ends the map unless the tenant has claimed it.
    const plan = planChoices({ screen, buttons: snapshot.buttons || [], profile });
    if (answerChoices && plan.choices.length) {
      // When the page will not take a click, the map asks the person and waits — otherwise it stalls here
      // and every step after this one goes unmapped.
      if (waitForHumanMs > 0) {
        const options = plan.choices.map((c) => c.option);
        note({ event: 'map-human-needed', step: record.step, question: plan.choices[0]?.question || null, options });
        const waited = await waitForHuman({
          evaluate,
          previous: { step: record.step, progressText: snapshot.progressText },
          timeoutMs: waitForHumanMs,
          pollMs: Math.max(500, pollMs)
        });
        record.advancedBy = waited.ok ? 'human' : 'human_timeout';
        if (waited.ok) {
          note({ event: 'map-human-answered', step: record.step, waitedMs: waited.waitedMs });
          await new Promise((r) => setTimeout(r, settleMs));
          continue;
        }
        return { ok: true, reason: 'human_timeout', at: record.step, options, steps };
      }

      const picked = [];
      for (const choice of plan.choices) {
        // A trusted click (browser protocol) is used when the caller can provide one: this app ignored
        // synthetic events, and that is not something a page-side expression can fix.
        const result = typeof clickOption === 'function'
          ? await clickOption(choice)
          : await evaluate(chooseOptionExpr({ option: choice.option, question: choice.question }));
        picked.push({ ...choice, ok: Boolean(result?.ok) });
      }
      const chosen = picked.filter((p) => p.ok).map((p) => p.option);
      record.advancedBy = `choice:${chosen.join(',') || 'none'}`;
      note({ event: 'map-choice', step: record.step, options: chosen });
      if (!chosen.length) {
        return { ok: true, reason: 'blocked', at: record.step, detail: 'no option could be chosen', steps };
      }
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    if (includeTyping && (snapshot.measurements?.typing || screen?.questions?.some((q) => q.type === 'typing_test'))) {
      const prompt = await evaluate(typingPromptExpr());
      if (!prompt?.ok) return { ok: true, reason: 'typing_prompt_not_found', at: record.step, steps };
      const typed = await evaluate(typeAtWpmExpr({ text: prompt.prompt, wpm: typingWpm }), { awaitPromise: true });
      record.advancedBy = `typed:${typed?.typed || 0}`;
      note({ event: 'map-typing', step: record.step, chars: typed?.typed || 0 });
      await new Promise((r) => setTimeout(r, settleMs));
      continue;
    }

    return {
      ok: true,
      reason: 'blocked',
      at: record.step,
      detail: 'Next is disabled and no answer of ours unlocks it',
      buttons: record.buttons.map((b) => b.label),
      steps
    };
  }

  return { ok: false, reason: 'max_steps_reached', steps };
}

/**
 * Walk back to the first step by pressing Previous until the page stops moving.
 *
 * Mapping starts wherever the browser happens to be; after a partial run that is the middle of the
 * application. Pressing Previous is the only way back and it changes nothing else — the answers already on
 * the page stay on it, which is what makes this safe to run on somebody's half-finished application.
 */
export async function rewindToStart({ evaluate, maxBack = 30, settleMs = 700, pollMs = 300, log = () => {} } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('rewindToStart needs an evaluate() function');
  let pressed = 0;
  for (let index = 0; index < maxBack; index += 1) {
    const snapshot = await evaluate(readStepExpr());
    if (!snapshot?.ok) return { ok: false, reason: snapshot?.reason || 'unreadable', pressed };
    if (snapshot.step != null && Number(snapshot.step) <= 1) return { ok: true, pressed, at: snapshot.step };

    const back = (snapshot.buttons || []).find((b) => !b.disabled && /(previous|back|←)/i.test(b.label));
    if (!back) return { ok: true, reason: 'no_back_button', pressed, at: snapshot.step ?? null };

    const before = await evaluate(stepFingerprintExpr());
    const clicked = await evaluate(clickButtonExpr({ labels: [back.label] }));
    if (!clicked?.ok) return { ok: false, reason: clicked?.reason || 'click_failed', pressed, at: snapshot.step };
    pressed += 1;
    log({ event: 'rewind', from: snapshot.step ?? null, button: back.label });
    const changed = await waitForStepChange({ evaluate, before, timeoutMs: 6_000, pollMs });
    if (!changed.moved) return { ok: true, reason: 'did_not_move', pressed, at: snapshot.step ?? null };
    await new Promise((r) => setTimeout(r, settleMs));
  }
  return { ok: false, reason: 'max_back_reached', pressed };
}

/** Lowercase, collapse whitespace. The neutral form two labels are compared in. */
export function normaliseOptionLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Does this button offer that option?
 *
 * The question's own option list is the authority — `Yes` — while the control may decorate it as
 * `A Yes`, `1. Yes`, `Yes ✓` or `Yes (recommended)`. So the comparison strips a leading marker and any
 * punctuation, but only to reach the *known* option, never to invent one. That is why this takes the
 * option as an argument instead of normalising labels in the abstract.
 */
export function buttonOffersOption(buttonLabel, option) {
  const button = normaliseOptionLabel(buttonLabel);
  const wanted = normaliseOptionLabel(option);
  if (!button || !wanted) return false;
  if (button === wanted) return true;
  // "A Yes" / "1. Yes" / "a) Yes" — a marker in front of the option itself.
  if (button.replace(/^(?:[a-z]|\d{1,2})\s*[.)\]:-]?\s+/, '') === wanted) return true;
  // Decoration after it: "Yes ✓", "Yes (recommended)".
  const plain = (value) => value.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return plain(button) === plain(wanted);
}

/**
 * Which multiple-choice questions can be answered from the profile right now.
 *
 * A required MCQ with no answer is left to `planScreenValues` to report as unresolved — this speaks only
 * for the ones where the profile has an answer and a matching control exists.
 */
export function planChoices({ screen = null, buttons = [], profile = {} } = {}) {
  const choices = [];
  const notOffered = [];
  for (const question of screen?.questions || []) {
    if (question.type !== 'mcq' || !Array.isArray(question.options) || !question.options.length) continue;
    const raw = profile[question.id];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    // The profile value has to be one of the offered options; a typo must not become an answer.
    const option = question.options.find((o) => normaliseOptionLabel(o) === normaliseOptionLabel(raw));
    if (!option) {
      notOffered.push({ question: question.id, label: question.label, options: question.options, wanted: String(raw), reason: 'not_an_option' });
      continue;
    }
    const button = (buttons || []).find((b) => !b.disabled && buttonOffersOption(b.label, option));
    if (!button) {
      notOffered.push({ question: question.id, label: question.label, options: question.options, wanted: option, reason: 'no_matching_control' });
      continue;
    }
    choices.push({ question: question.id, label: question.label, option, buttonLabel: button.label });
  }
  return { choices, notOffered };
}

/** Click the option a question asks for. */
export function chooseOptionExpr({ option = '', question = '' } = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const normalise = (v) => clean(v).toLowerCase();
  const stripMarker = (v) => v.replace(/^(?:[a-z]|\\d{1,2})\\s*[.)\\]:-]?\\s+/, '');
  const plain = (v) => v.replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;
  const view = doc.defaultView || window;
  const wanted = normalise(${JSON.stringify(String(option || ''))});
  const question = ${JSON.stringify(String(question || ''))};

  // A bare .click() is not enough on this app: the live age screen re-rendered the same question and
  // bumped the step counter instead of moving on. So the full pointer sequence is dispatched, which is
  // what a real click sends and what overlay/portal handlers listen for.
  const clickLikeHuman = (el) => {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const fire = (type, Ctor, init) => {
      try {
        const Event = view[Ctor] || view.Event;
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, view, button: 0, ...(init || {}) }));


      } catch (e) { /* the sequence continues; one unsupported event is not fatal */ }
    };
    fire('pointerdown', 'PointerEvent');
    fire('mousedown', 'MouseEvent');
    fire('pointerup', 'PointerEvent');
    fire('mouseup', 'MouseEvent');
    try { el.click(); } catch (e) {}
  };

  const visible = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };
  const candidates = Array.from(doc.querySelectorAll('button, [role="button"], [role="radio"], label, input[type="radio"]'))
    .filter(visible)
    .map((el) => {
      // A radio input has no text; its label carries the option.
      let label = clean(el.innerText || el.textContent);
      if (!label && el.tagName === 'INPUT') {
        const wrapping = el.closest ? el.closest('label') : null;
        label = clean(wrapping ? (wrapping.innerText || wrapping.textContent) : (el.getAttribute('aria-label') || el.value || ''));
      }
      return { el, label };
    })
    .filter((row) => row.label && row.label.length <= 60);

  // Same rule as buttonOffersOption(): the option list is the authority, the control may decorate it.
  const offers = (label) => {
    const value = normalise(label);
    return value === wanted || stripMarker(value) === wanted || plain(value) === plain(wanted);
  };
  const match = candidates.find((row) => normalise(row.label) === wanted)
    || candidates.find((row) => offers(row.label));
  if (!match) {
    return JSON.stringify({
      ok: false,
      reason: 'option_not_found',
      wanted,
      available: candidates.map((row) => row.label).slice(0, 12)
    });
  }
  if (match.el.disabled === true || match.el.getAttribute('aria-disabled') === 'true') {
    return JSON.stringify({ ok: false, reason: 'option_disabled', label: match.label });
  }
  try { match.el.scrollIntoView({ block: 'center' }); } catch (e) {}
  clickLikeHuman(match.el);
  // Read back what the control now says, so a click that did not register is visible to the caller.
  const state = {
    checked: match.el.checked === undefined ? null : Boolean(match.el.checked),
    ariaChecked: match.el.getAttribute('aria-checked'),
    ariaPressed: match.el.getAttribute('aria-pressed'),
    dataState: match.el.getAttribute('data-state')
  };
  return JSON.stringify({ ok: true, label: match.label, question, state });
})()`;
}
/**
 * Where on screen an option sits, in top-level viewport coordinates.
 *
 * Synthetic events did not move this app: `A Yes` was clicked, `Next` stayed disabled and the same question
 * came back. React (and anything accepting pointer events) can ignore a dispatched `click`; a *trusted*
 * click from the browser protocol cannot be ignored. That needs a coordinate, which is what this returns —
 * adding the iframe's own offset, because the protocol addresses the top viewport while the control lives
 * inside the frame.
 */
export function optionPointExpr({ option = '' } = {}) {
  return `(() => {
  const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  const normalise = (v) => clean(v).toLowerCase();
  const stripMarker = (v) => v.replace(/^(?:[a-z]|\\d{1,2})\\s*[.)\\]:-]?\\s+/, '');
  const plain = (v) => v.replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();
  ${FORM_ROOT}
  const found = findFormDocument();
  if (!found.doc) return JSON.stringify({ ok: false, reason: 'cross_origin_frame' });
  const doc = found.doc;
  const wanted = normalise(${JSON.stringify(String(option || ''))});

  const visible = (el) => {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return Boolean(rect && (rect.width > 0 || rect.height > 0));
  };
  const candidates = Array.from(doc.querySelectorAll('button, [role="button"], [role="radio"], label, input[type="radio"]'))
    .filter(visible)
    .map((el) => {
      let label = clean(el.innerText || el.textContent);
      if (!label && el.tagName === 'INPUT') {
        const wrapping = el.closest ? el.closest('label') : null;
        label = clean(wrapping ? (wrapping.innerText || wrapping.textContent) : (el.getAttribute('aria-label') || el.value || ''));
      }
      return { el, label };
    })
    .filter((row) => row.label && row.label.length <= 60);

  const offers = (label) => {
    const value = normalise(label);
    return value === wanted || stripMarker(value) === wanted || plain(value) === plain(wanted);
  };
  const match = candidates.find((row) => normalise(row.label) === wanted)
    || candidates.find((row) => offers(row.label));
  if (!match) {
    return JSON.stringify({ ok: false, reason: 'option_not_found', wanted, available: candidates.map((r) => r.label).slice(0, 12) });
  }

  const rect = match.el.getBoundingClientRect();
  // The frame's own offset in the top document: the protocol addresses the top viewport.
  let offsetX = 0;
  let offsetY = 0;
  if (found.mode === 'iframe') {
    const frames = Array.from(document.querySelectorAll('iframe'));
    const frame = frames.find((f) => String(f.getAttribute('src') || '') === String(found.frameSrc || ''));
    if (frame) {
      const box = frame.getBoundingClientRect();
      offsetX = box.left;
      offsetY = box.top;
    }
  }
  return JSON.stringify({
    ok: true,
    label: match.label,
    x: Math.round(offsetX + rect.left + rect.width / 2),
    y: Math.round(offsetY + rect.top + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  });
})()`;
}



/**
 * Pause for a person, then carry on (2026-11-14).
 *
 * Some of this form's controls ignore programmatic clicks entirely: a dispatched click, a full synthetic
 * pointer sequence and a protocol-trusted mouse event all left Next disabled on the age question. That is not
 * something a page expression can fix, and it is not a reason to give up on the other twenty steps.
 *
 * So: say what is needed, wait for the page to move, and continue. "Moved" means the page's own step number
 * changed or its Next control became enabled — both are things only a real answer produces.
 */
export async function waitForHuman({ evaluate, previous = null, timeoutMs = 120_000, pollMs = 1_000 } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('waitForHuman needs an evaluate() function');
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.max(250, Number(pollMs) || 1000)));
    const snapshot = await evaluate(readStepExpr());
    if (!snapshot?.ok) continue;
    const nextReady = (snapshot.buttons || []).some(
      (b) => !b.disabled && CHATTER_APPLY.buttons.next.some((word) => b.label.toLowerCase().includes(word))
    );
    // The step must *increase*. Reading a null step mid-transition as "moved" ended a live wait after one
    // second on an unanswered question, and the next read caught a half-rendered screen with no Next on it.
    const nowStep = typeof snapshot.step === 'number' ? snapshot.step : null;
    const moved = nowStep != null && previous?.step != null && nowStep > previous.step;
    if (nextReady || moved) {
      return { ok: true, waitedMs: Date.now() - startedAt, snapshot };
    }
  }
  return { ok: false, reason: 'human_timeout', waitedMs: Date.now() - startedAt };
}
