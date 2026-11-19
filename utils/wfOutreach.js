/**
 * Writer's Flow outreach, as a conversation with a brake (2026-11-19)
 *
 * The request was exact: *"it should be clear — not just running. It must seek
 * clarification and tell the user what is about to happen for approval."*
 *
 * So the bot never starts a campaign from one sentence. It fills four slots in order (what
 * to look for, which industries, how many, approve), says plainly what it is about to
 * create before it creates it, and only then writes a **draft** — nothing is sent until a
 * human presses Run, because a campaign spends the tenant's credibility with strangers and
 * their email reputation with inbox providers.
 *
 * Pure state machine: no IO, no sending. `renderOutreach()` returns the next message and the
 * action the caller should take, so the webhook stays a switch and this file stays testable.
 */

export const WF_MAX_TARGET = 25;
export const WF_DEFAULT_TARGET = 10;
export const WF_STAGES = ['goal', 'industries', 'target', 'confirm'];

/** Did they ask for outreach, in any of the words people actually use? */
export function detectOutreach(text) {
  const t = String(text || '').toLowerCase();
  return /\b(run|start|launch|begin|do)\b[^.\n]{0,24}\b(outreach|campaign|prospecting|writer'?s?\s*flow|wf)\b/.test(t)
    || /\b(find|get|source)\b[^.\n]{0,20}\bleads?\b/.test(t)
    || /\bwriter'?s?\s*flow\b/.test(t);
}

export const emptyOutreach = () => ({ stage: null, keywords: [], industries: [], target: WF_DEFAULT_TARGET });

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/** "hotels, lodges and camps" → ['hotels','lodges','camps'] */
export function parseIndustries(text) {
  const raw = clean(text);
  if (!raw) return [];
  if (/^(any|all|no preference|none)$/i.test(raw)) return [];
  return raw
    .split(/[,;/]|\band\b|&/i)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.length <= 40)
    .slice(0, 6);
}

/** The first number they say, clamped to what the runner will accept. */
export function parseTarget(text, maxTarget = WF_MAX_TARGET) {
  const m = clean(text).match(/\d{1,3}/);
  if (!m) return null;
  return Math.min(maxTarget, Math.max(1, Number(m[0])));
}

export function isApproval(text) {
  return /^(yes|yep|yeah|ok|okay|go ahead|go|proceed|confirm|approved?|do it|start|run it)\b/i.test(clean(text));
}

export function isCancel(text) {
  return /^(no|stop|cancel|not now|later|hold on|wait)\b/i.test(clean(text));
}

export function campaignName(state) {
  const kw = (state.keywords[0] || 'outreach').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 40);
  return kw || 'outreach';
}

/** Said *before* anything is created — the whole point of the flow. */
export function describeOutreachPlan(state, { tenantName = 'your business', maxTarget = WF_MAX_TARGET } = {}) {
  const keywords = state.keywords[0] || '(none)';
  const industries = state.industries.length ? state.industries.join(', ') : 'any industry';
  const target = Math.min(maxTarget, Number(state.target) || WF_DEFAULT_TARGET);
  return [
    'Here is exactly what will happen, for ' + tenantName + ':',
    '',
    '1. I create a Writer\'s Flow campaign called *' + campaignName(state) + '* — a draft, nothing else.',
    '2. When it runs, it searches for *' + keywords + '* in *' + industries + '* and keeps up to *' + target + ' leads* scoring 70 or better.',
    '3. The leads land in your portal with name, organisation, email and why each one matched.',
    '4. Outreach messages are *not* sent by this step. You review the list first, and sending stays a separate decision.',
    '',
    'Reply *YES* to create the draft, or *no* to stop.'
  ].join('\n');
}

export function describeOutreachCreated(state, { tenantName = 'your business' } = {}) {
  return [
    'Draft created for ' + tenantName + ': *' + campaignName(state) + '* — '
      + (state.industries.length ? state.industries.join(', ') : 'any industry')
      + ', up to ' + state.target + ' leads.',
    '',
    'Nothing has been sent. Open Writer\'s Flow in your portal to press Run, or reply *run it* and I will start it and report what it found.',
    '',
    'You can still change the keywords, industries or count there before it runs.'
  ].join('\n');
}

/**
 * One turn of the conversation.
 *
 * `state` is what was stored in the session (or `null` to begin). Returns the next state, the
 * message to send, and `action`: `ask` (keep going), `create` (the caller writes a draft
 * campaign), `cancel`, or `none` (not an outreach turn — fall through to the normal reply).
 */
export function renderOutreach({ state = null, text = '', tenantName = 'your business', maxTarget = WF_MAX_TARGET } = {}) {
  const message = clean(text);
  const current = state && state.stage ? { ...emptyOutreach(), ...state } : null;

  if (!current) {
    if (!detectOutreach(message)) return { action: 'none', state: null, reply: null };
    return {
      action: 'ask',
      state: { ...emptyOutreach(), stage: 'goal' },
      reply: [
        'Yes — I can run a Writer\'s Flow outreach campaign, but I will not start one from a single word.',
        '',
        'First: what am I looking for? Give me what you sell and who buys it, e.g.',
        '*"hotels in Nairobi that host conferences"*',
        '',
        'I will turn that into keywords, show you the exact plan, and nothing is sent until you approve it.'
      ].join('\n')
    };
  }

  if (isCancel(message)) {
    return {
      action: 'cancel',
      state: emptyOutreach(),
      reply: 'Stopped — nothing was created and nothing was sent. Say "run outreach" when you want to start again.'
    };
  }

  if (current.stage === 'goal') {
    if (message.length < 8) {
      return {
        action: 'ask',
        state: current,
        reply: 'I need a little more than that — one sentence: what you sell, and who you want to reach. For example, *"solar panels for schools in Kisumu"*.'
      };
    }
    current.keywords = [message.slice(0, 160)];
    current.stage = 'industries';
    return {
      action: 'ask',
      state: current,
      reply: 'Got it: *' + current.keywords[0] + '*.'
        + '\n\nWhich industries should I search? A short list is fine (e.g. *hospitality, education*) — or say *any*.'
    };
  }

  if (current.stage === 'industries') {
    current.industries = parseIndustries(message);
    current.stage = 'target';
    return {
      action: 'ask',
      state: current,
      reply: (current.industries.length
        ? 'Industries: ' + current.industries.join(', ') + '.'
        : 'Any industry, then.')
        + '\n\nHow many leads? 10, 15 or ' + maxTarget + ' (that is the cap). Fewer is easier to act on.'
    };
  }

  if (current.stage === 'target') {
    const target = parseTarget(message, maxTarget);
    if (!target) {
      return {
        action: 'ask',
        state: current,
        reply: 'Just a number — 10 is a good first run, ' + maxTarget + ' is the maximum.'
      };
    }
    current.target = target;
    current.stage = 'confirm';
    return { action: 'ask', state: current, reply: describeOutreachPlan(current, { tenantName, maxTarget }) };
  }

  if (current.stage === 'confirm') {
    if (!isApproval(message)) {
      return {
        action: 'ask',
        state: current,
        reply: 'I have not created anything. Reply *YES* to create the draft, or *no* to stop. If something in the plan is wrong, tell me what to change (e.g. "make it 5 leads").'
      };
    }
    return { action: 'create', state: current, reply: describeOutreachCreated(current, { tenantName }) };
  }

  return { action: 'none', state: current, reply: null };
}
