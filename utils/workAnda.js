/**
 * Work_Under — agents that work *for* a tenant on a specific site (2026-11-14)
 *
 * `Work_Under` is a paid upgrade, not a capability every tenant gets: an agent that logs into a third-party site
 * and acts on the tenant's behalf carries their identity, their reputation and their application. So the gate is
 * data the server checks, not a hidden button: a tenant without the flag is refused by the API, and hiding the
 * panel is only the courtesy on top.
 *
 * Who has it: `WORK_UNDER_TENANTS` (comma-separated slugs), defaulting to `malingu-ventures` — the first
 * customer, whose agent applies to OnlyFans chatter roles on ChatterApply.
 *
 * Each agent names the console that drives it. Today there is one console (`/apply`) and one agent; adding a
 * second site means adding a row here and a page beside it, not a new mechanism.
 */

/** The default: the tenant this was built for. Env overrides it, so a second customer needs no deploy. */
export const DEFAULT_WORK_UNDER_TENANTS = Object.freeze(['malingu-ventures']);

export const WORK_UNDER_SECTION = Object.freeze({ id: 'work-under', label: 'Work_Under', group: 'Growth' });

/**
 * The agents. `site` is what the tenant recognises; `consolePath` is what the panel embeds; `runKind` ties it to
 * `browser_actor_runs`, which is what makes one run at a time possible per agent.
 */
export const WORK_UNDER_AGENTS = Object.freeze([
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

/** The tenants with the upgrade. Compared lower-case; whitespace and empty entries are ignored. */
export function enabledTenants(env = process.env) {
  const raw = String(env.WORK_UNDER_TENANTS || '').trim();
  if (!raw) return [...DEFAULT_WORK_UNDER_TENANTS];
  const list = raw.split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_WORK_UNDER_TENANTS];
}

export function workUnderEnabled(slug, env = process.env) {
  const wanted = String(slug || '').trim().toLowerCase();
  return Boolean(wanted) && enabledTenants(env).includes(wanted);
}

/** What the portal shows for this tenant: no agents, no section. */
export function agentsFor(slug, env = process.env) {
  return workUnderEnabled(slug, env) ? WORK_UNDER_AGENTS.map((agent) => ({ ...agent })) : [];
}

/** The whole answer the dashboard needs, in one call. */
export function workUnderFor(slug, env = process.env) {
  const enabled = workUnderEnabled(slug, env);
  return {
    enabled,
    tenant: String(slug || '').trim().toLowerCase(),
    section: { ...WORK_UNDER_SECTION },
    agents: agentsFor(slug, env),
    // Said plainly, because a tenant who bought this needs to know why a card is missing.
    reason: enabled ? null : 'Work_Under is not enabled for this tenant.'
  };
}
