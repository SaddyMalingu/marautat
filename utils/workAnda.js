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


