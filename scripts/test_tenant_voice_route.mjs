#!/usr/bin/env node

/**
 * The tenant's voice control, verified end to end without a database (2026-10-25).
 *
 * The blog engine assigns every tenant one of six editorial voices. That was
 * previously invisible and unchangeable: a tenant could not see which voice its
 * pages used, let alone choose another. The portal now shows the voice and saves
 * a choice into `site_tenants.metadata.voice` (the jsonb column every deployed
 * row already has, so no migration is needed before a tenant can pick a tone).
 *
 * What this proves:
 *   1. `resolveTenantVoice()` honours `metadata.voice`, and clears back to the
 *      derived voice when the key is absent.
 *   2. server.js exposes GET /tenant/blogger with the voice + options and a
 *      POST /tenant/blogger/voice that is tenant-scoped, validates the id, merges
 *      the existing metadata (never overwrites another setting) and refuses with
 *      a named migration when the column is missing.
 *   3. tenant_dashboard.html renders the picker and posts to the endpoint.
 *
 * Usage: npm run test:tenant-voice
 * Exit codes: 0 = all passed, 1 = at least one failure.
 */
import fs from 'fs';
import { resolveTenantVoice, listVoiceProfiles } from '../utils/tenantVoice.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

// ---- 1. the resolver honours a stored choice -------------------------------
const base = { id: 'site-1', slug: 'kassangas', name: 'Kassangas Music Shop' };
const derived = resolveTenantVoice({ site: base });
ok('an unconfigured tenant gets a derived voice', derived.source === 'derived', derived.source);

const chosen = resolveTenantVoice({ site: { ...base, metadata: { voice: 'bold-challenger' } } });
ok('metadata.voice wins', chosen.id === 'bold-challenger', chosen.id);
ok('a chosen voice is reported as configured', chosen.source === 'configured', chosen.source);

const cleared = resolveTenantVoice({ site: { ...base, metadata: { voice: null } } });
ok('a cleared choice falls back to the assigned voice', cleared.id === derived.id, cleared.id + ' vs ' + derived.id);

const otherSetting = resolveTenantVoice({ site: { ...base, metadata: { voice: 'precise-operator', theme: 'dark' } } });
ok('other metadata keys do not interfere', otherSetting.id === 'precise-operator', otherSetting.id);

const ids = listVoiceProfiles();
ok('every offered id resolves', ids.every((id) => resolveTenantVoice({ site: { ...base, metadata: { voice: id } } }).id === id), ids.join(','));

// ---- 2. the routes --------------------------------------------------------
const server = fs.readFileSync('server.js', 'utf8');
const getStart = server.indexOf("app.get('/tenant/blogger'");
const postStart = server.indexOf("app.post('/tenant/blogger/voice'");
ok('GET /tenant/blogger exists', getStart > -1);
ok('POST /tenant/blogger/voice exists', postStart > -1);
ok('the voice routes are tenant-scoped', getStart > -1 && postStart > -1
  && /tenantSessionAuth/.test(server.slice(getStart, getStart + 300))
  && /tenantSessionAuth/.test(server.slice(postStart, postStart + 300)));

const getSrc = getStart > -1 ? server.slice(getStart, postStart > getStart ? postStart : getStart + 4000) : '';
ok('the portal receives the voice and the alternatives',
  /voice:\s*tbVoiceFor\(/.test(getSrc) && /voiceOptions:\s*tbVoiceOptions\(/.test(getSrc));
ok('the full prompt block is not sent to the browser',
  /return \{ id: v\.id, label: v\.label, source: v\.source, brand: v\.brand, industry: v\.industry \};/.test(server)
  && !/promptBlock/.test(getSrc));
ok('the display helpers are defined before use at module scope',
  server.indexOf('function tbVoiceFor(') > -1 && server.indexOf('function tbVoiceOptions(') > -1);

const postSrc = postStart > -1 ? server.slice(postStart, postStart + 2600) : '';
ok('the endpoint validates the requested id', /allowed\.indexOf\(requested\) === -1/.test(postSrc));
ok('an unknown voice answers 400 with the allowed list', /status\(400\)/.test(postSrc) && /allowed\.join/.test(postSrc));
ok('the choice is stored in site_tenants.metadata (no migration needed)',
  /nextMetadata\.voice = requested/.test(postSrc) && /metadata:\s*nextMetadata/.test(postSrc));
ok('existing metadata is merged, not replaced',
  /Object\.assign\(\{\}, metadata\)/.test(postSrc));
ok('clearing the choice removes the key', /delete nextMetadata\.voice/.test(postSrc));
ok('a missing metadata column answers 503 naming the migration',
  /status\(missingColumn \? 503 : 502\)/.test(postSrc) && /2026-10-11_add_site_tenants_multitenant\.sql/.test(postSrc));
ok('the write is scoped to this tenant', /\.eq\('id', ctx\.site\.id\)/.test(postSrc));

// ---- 3. the portal --------------------------------------------------------
const dash = fs.readFileSync('admin/tenant_dashboard.html', 'utf8');
ok('the portal renders a voice picker', /id="wfVoiceSelect"/.test(dash));
ok('the picker explains where the current voice came from', /assigned to your business/.test(dash) && /chosen by you/.test(dash));
ok('saving posts to the endpoint', /apiJson\('\/tenant\/blogger\/voice'/.test(dash));
ok('the tenant can revert to the assigned voice', /id="wfVoiceReset"/.test(dash) && /voice: voiceId/.test(dash));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
