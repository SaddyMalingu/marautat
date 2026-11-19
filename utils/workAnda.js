/**
 * WORK_ANDA â€” agents that work *for* a tenant on a specific site (2026-11-14)
 *
 * `WORK_ANDA` is a paid upgrade, not a capability every tenant gets: an agent that logs into a third-party site
 * and acts on the tenant's behalf carries their identity, their reputation and their application. So the gate is
 * data the server checks, not a hidden button: a tenant without the flag is refused by the API, and hiding the
 * panel is only the courtesy on top.
 *
 * Who has it: `WORK_ANDA_TENANTS` (comma-separated slugs), defaulting to `malingu-ventures` â€” the first
 * customer, whose agent applies to OnlyFans chatter roles on ChatterApply.
 *
 * Each agent names the console that drives it. Today there is one console (`/apply`) and one agent; adding a
 * second site means adding a row here and a page beside it, not a new mechanism.
 */

/** The default: the tenant this was built for. Env overrides it, so a second customer needs no deploy. */
export const DEFAULT_WORK_ANDA_TENANTS = Object.freeze(['malingu-ventures']);

export const WORK_ANDA_SECTION = Object.freeze({ id: 'work-anda', label: 'Work_Anda', group: 'Growth' });

/**
 * Templates: agents built for one tenant and offered to others. The catalogue is open to every tenant (that is
 * how an upgrade sells itself); leasing is not built yet, and the cards say `preview` rather than offering a
 * button that fails.
 */
export const WORK_ANDA_TEMPLATES = Object.freeze([
  {
    id: 'of-chatter',
    name: 'OF Chatter',
    site: 'chatterapply.com',
    builtFor: 'Malingu Ventures',
    status: 'preview',
    summary: 'Fills the OnlyFans chatter application, and stops for the questions only the applicant can answer.',
    lease: 'Leasing opens after the first tenant run is complete end to end.'
  }
]);

/** The live agents a tenant has. Same ids as the templates, so leasing one later is data, not code. */
export const WORK_ANDA_AGENTS = Object.freeze([
  {
    id: 'of-chatter',
    name: 'OF Chatter',
    site: 'chatterapply.com',
    consolePath: '/apply',
    runKind: 'apply',
    summary: 'Fills the OnlyFans chatter application on your behalf, and stops for the questions only you can answer.',
    stopsAt: 'steps 2, 8, 10 (your clicks), 15 (English test), 21 (voice intro)'
  }
]);

/**
 * The queue: agents asked for, and what happened to them (2026-11-19).
 *
 * A card here is a yes to "should this be an agent", not a claim that it works. It is
 * the same shape as OF Chatter — a worker that acts on a site, on one tenant's behalf,
 * and stops where a human has to be the one to act — which is why it is queued beside
 * it rather than built as a separate mechanism.
 *
 * A shipped card stays in the list with its date, because the guardrails that were
 * agreed before the build are the ones a later change has to keep honouring.
 *
 * The reason each card names its guardrails: an agent that touches a tenant's account
 * is spending their identity and their reputation, so the limits are part of the
 * specification, not a footnote on it.
 */
export const WORK_ANDA_QUEUE = Object.freeze([
  {
    id: 'offer-intercept',
    name: 'Offer Intercept',
    site: 'alphadome.onrender.com',
    builtFor: 'the platform itself',
    status: 'shipped',
    queuedAt: '2026-11-19',
    shippedAt: '2026-11-19',
    summary: 'Shipped: a job page now carries the application pack under its Apply button, and /go/kit records the click. The reader is never delayed — the Apply button keeps its exact destination.',
    why: 'Every Apply click today 302s to the provider: the reader leaves, the platform earns nothing at the moment of intent, and the referral pays a commission weeks later, if at all.',
    guardrails: [
      'One handler and one template. No change to any tenant\'s account, credentials or published pages.',
      'The reader is never blocked or slowed: the provider link stays on the page and the redirect still fires if the offer is skipped.',
      'Read-only against the provider. Nothing is submitted, applied for or asserted on a tenant\'s behalf.',
      'Tenant-scoped: the page belongs to one tenant, and the offer must name that tenant\'s own product or no offer is shown.'
    ],
    stopsAt: 'the reader\'s own click — no auto-redirect, no countdown, no interstitial'
  },
  {
    id: 'of-chatter-copilot',
    name: 'OF Chatter Co-pilot',
    site: 'chatterapply.com → the operator\'s chosen chat platform',
    builtFor: 'Malingu Ventures, then any tenant holding a chatter seat',
    status: 'queued',
    queuedAt: '2026-11-19',
    summary: 'A chatter seat is a paid shift (ChatterApply lists roles advertised around USD 450–600 a month). The agent drafts the replies a human chatter approves, so a shift takes less time than it does now.',
    why: 'The application half is already built (OF Chatter, `runKind: apply`). The billable half is the shift itself, and the expensive part of a shift is thinking of what to say, not typing it.',
    guardrails: [
      'The agent drafts; the chatter sends. Nothing leaves the account unattended, and no message is sent as if a person wrote it when nobody read it.',
      'The chatter is a real, identifiable person on the client\'s own contract — the agent never pretends to be them to the platform.',
      'The operator\'s account only: a tenant\'s seat is touched only with that tenant\'s own credentials and their written instruction.',
      'No client-facing medical, legal or payment commitment is ever drafted by the agent without a human rewriting it.',
      'Every draft is logged with the human who approved it, because a paid shift can be audited by the platform that pays for it.'
    ],
    stopsAt: 'the human pressing send — the agent never submits a message it wrote as the operator\'s own words',
    openQuestion: 'Running the chat account itself (not drafting for it) is the same line as OPEN_FLAGS #53/#56: a platform paying for attested human work, answered by software, misrepresents the contributor and breaks their terms. Draft-and-approve is the version that earns without risking the seat.'
  },
  {
    id: 'hashlist-console',
    name: 'Task & Referral Console',
    site: 'the data-operations platform',
    builtFor: 'the platform itself, sold as a tenant capability',
    status: 'queued',
    queuedAt: '2026-11-19',
    summary: 'One console for the three lanes that platform actually pays on: accepted tasks, referrals, and a data-set sample.',
    why: 'The cards exist (`dop/tasks/`, packaged in `dist/hashlist/`), the rate is known ($0 per task on this account; $500–$5,000 on an accepted data-set sample), and the publishing decision is still gated on ToS §11 (`docs/HASHLIST_EVALUATION.md`).',
    guardrails: [
      'Read-only until §11 is read: no task published, no sample submitted, no referral sent from a card that cannot be reused.',
      'Cards are cut from the founder\'s own working week; no client\'s data or conversation ever enters a card.',
      'A published card is treated as spent, not as inventory, until the terms say otherwise.'
    ],
    stopsAt: 'publishing — a human reads §11 and decides, once'
  }
]);

/** The queue, as a tenant sees it. Queued cards are shown as `queued`, never as buyable. */
export function queueFor() {
  return WORK_ANDA_QUEUE.map((card) => ({ ...card, guardrails: [...card.guardrails] }));
}

/** The tenants with a live agent. Compared lower-case; whitespace and empty entries are ignored. */
export function enabledTenants(env = process.env) {
  const raw = String(env.WORK_ANDA_TENANTS || env.WORK_UNDER_TENANTS || '').trim();
  if (!raw) return [...DEFAULT_WORK_ANDA_TENANTS];
  const list = raw.split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_WORK_ANDA_TENANTS];
}

/**
 * Is this tenant entitled?
 *
 * Matched on the site slug **or** the tenant's phone: the portal keeps two identifiers for one customer and the
 * site slug is derived from their name, so a tenant listed by phone must not lose the upgrade to a slug mismatch
 * that reads like a bug.
 */
export function workAndaEnabled(slug, env = process.env, phone = '') {
  const wanted = String(slug || '').trim().toLowerCase();
  const digits = String(phone || '').replace(/\D/g, '');
  const list = enabledTenants(env);
  if (wanted && list.includes(wanted)) return true;
  if (!digits) return false;
  return list.some((entry) => {
    const asDigits = String(entry).replace(/\D/g, '');
    return asDigits.length >= 9 && asDigits === digits;
  });
}

/** A tenant's live agents. Empty without the upgrade — they still get templates and onboarding. */
export function agentsFor(slug, env = process.env, phone = '') {
  return workAndaEnabled(slug, env, phone) ? WORK_ANDA_AGENTS.map((agent) => ({ ...agent })) : [];
}

/** The catalogue every tenant sees. */
export function templatesFor() {
  return WORK_ANDA_TEMPLATES.map((template) => ({ ...template }));
}

/**
 * What the section needs, in one call.
 *
 * `enabled` is not "may you see the section" â€” everybody may â€” it is "do you have a live agent". The reason
 * string exists so a tenant without one is told what to do next instead of facing an empty page.
 */
export function workAndaFor(slug, env = process.env, phone = '') {
  const enabled = workAndaEnabled(slug, env, phone);
  return {
    enabled,
    tenant: String(slug || '').trim().toLowerCase(),
    section: { ...WORK_ANDA_SECTION },
    templates: templatesFor(),
    queue: queueFor(),
    agents: agentsFor(slug, env, phone),
    onboarding: { open: true, accepts: ['siteUrl', 'htmlDump', 'brief'] },
    reason: enabled ? null : 'No Work_Anda agent is unlocked for this tenant yet â€” onboard a system below and we will build one.'
  };
}

/**
 * Validate an onboarding request.
 *
 * The dump is capped at 200 KB: it is pasted or uploaded into a browser form, and a 5 MB page dump would be read
 * by nobody while bloating a jsonb field. A few pages of markup is what building an agent actually needs.
 */
export const MAX_HTML_DUMP = 200 * 1024;
export const MAX_BRIEF = 4000;
export const MAX_REQUESTS = 5;

export function buildOnboardingRequest(body = {}) {
  const errors = [];
  const siteUrl = String(body.siteUrl || '').trim();
  if (!siteUrl) errors.push('siteUrl is required: the link to the site the worker should work in');
  else if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(siteUrl)) errors.push('siteUrl must be a full http(s) link');

  const htmlDump = String(body.htmlDump || '');
  if (htmlDump.length > MAX_HTML_DUMP) {
    errors.push(`htmlDump is too large (${Math.round(htmlDump.length / 1024)} KB, limit ${MAX_HTML_DUMP / 1024} KB)`);
  }
  const brief = String(body.brief || '').replace(/\r\n/g, '\n').trim();
  if (brief.length < 40) errors.push('brief is required: describe, in a few sentences, what the worker should do');
  if (brief.length > MAX_BRIEF) errors.push(`brief is too long (limit ${MAX_BRIEF} characters)`);

  return {
    errors,
    request: {
      id: `req_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      siteUrl,
      htmlDump,
      htmlDumpBytes: htmlDump.length,
      brief,
      status: 'submitted'
    }
  };
}

/** Keep the newest few: a jsonb field is a notebook, not a warehouse. */
export function appendRequest(existing, request, limit = MAX_REQUESTS) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  list.unshift(request);
  while (list.length > limit) list.pop();
  return list;
}


