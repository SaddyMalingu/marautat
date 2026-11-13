/**
 * Tenant-owned browser access (2026-11-02)
 *
 * The tenant brings their own MoreLogin account and one profile, signs into Micro1/Turing
 * *on their own machine*, and hands Alphadome a **key** — never a password. That choice
 * buys three things the hosted model cannot:
 *
 *   1. **Custody stays with the tenant.** The cookie jar lives in their profile, on their
 *      disk, behind their account. We never see a password or an OTP, so "could an
 *      Alphadome employee log in as me?" is answered by architecture, not by a promise.
 *   2. **The daily start quota is theirs.** MoreLogin caps profile starts per day; BYO
 *      moves that ceiling off the operator's plan (OPEN_FLAGS #16), which is what limits
 *      how many tenants one host can serve.
 *   3. **The fingerprint and IP are theirs**, which is also what a marketplace expects to
 *      see for a remote worker.
 *
 * What we still hold, and therefore must protect: the API key. It is a bearer credential
 * for their MoreLogin account, so it is sealed with AES-256-GCM under `TENANT_SECRET_KEY`
 * and **never leaves the server**: `publicAccessStatus` is the only shape a tenant sees,
 * and it does not contain the key, its ciphertext, or its fingerprint.
 *
 * If `TENANT_SECRET_KEY` is absent, connecting is refused (503 with the env name) rather
 * than storing a key in the clear. Fail closed, then say what to set.
 *
 * Stored under `site_tenants.metadata.browserAccess`, because `metadata jsonb` already
 * exists on every deployed row — the same reason `metadata.voice` lives there. Adding a
 * column would mean another migration before a tenant could connect anything.
 *
 * Pure except the crypto helpers: the rules are tested without a database.
 */
import crypto from 'node:crypto';
import { maskEnvId, isValidEnvId } from './browserActor/identity.js';

/** Where the sealing key comes from. Absent = the feature refuses to run. */
export const ACCESS_KEY_ENV = 'TENANT_SECRET_KEY';

/**
 * The key being retired, if any.
 *
 * This is what makes rotation survivable. Without it, changing the sealing key makes every
 * stored tenant key unreadable at once and turns a routine security action into a support
 * queue. With it, the sequence is: set the old value here, set the new value in
 * `TENANT_SECRET_KEY`, deploy, let tenants reconnect at their own pace, then remove this.
 */
export const ACCESS_KEY_PREVIOUS_ENV = 'TENANT_SECRET_KEY_PREVIOUS';

/** Field inside site_tenants.metadata. */
export const ACCESS_FIELD = 'browserAccess';

/**
 * A browser the tenant's own worker found on their own computer (2026-11-03).
 *
 * This exists because the first design asked a recruiter to do two things they should not
 * have to do: find a MoreLogin API key, and know which profile id to pick. When the worker
 * is already running next to MoreLogin, the machine can answer both questions itself —
 * `ml-cli env list` needs no key — so the worker tells us the envId and the tenant never
 * sees one.
 *
 * It is stored separately from `browserAccess` on purpose: there is **no key** here and
 * nothing was sealed, so it must never be mistaken for a connection the tenant made with a
 * credential. It is also only ever used for runs on *that* machine (see
 * `resolveRunnerIdentity({ workerRuns: true })`) — the server cannot reach a desktop profile.
 */
export const WORKER_BROWSER_FIELD = 'workerBrowser';

const SEAL_VERSION = 'v1';
const PROVIDER = 'morelogin';

export function secretsConfigured(env = process.env) {
  return Boolean(String(env[ACCESS_KEY_ENV] || '').trim());
}

/** Current + retiring key, trimmed, or null. */
export function accessSecrets(env = process.env) {
  return {
    current: String(env[ACCESS_KEY_ENV] || '').trim() || null,
    previous: String(env[ACCESS_KEY_PREVIOUS_ENV] || '').trim() || null
  };
}


function deriveKey(secret) {
  // A passphrase or a 64-hex key both work; hashing to 32 bytes keeps the AES contract
  // simple without asking an operator to generate the "right" format.
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(plaintext, secret) {
  const value = String(plaintext == null ? '' : plaintext);
  if (!value) throw new Error('sealSecret needs a value');
  if (!secret) throw new Error(`Cannot seal a credential without ${ACCESS_KEY_ENV}`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEAL_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Returns the plaintext, or null when the seal is wrong/tampered/foreign. */
export function openSecret(sealed, secret) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION || !secret) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // A failed decrypt is indistinguishable from a wrong key, which is the honest answer:
    // either way the credential is unusable and the tenant must reconnect.
    return null;
  }
}

/** Safe correlation id for logs/support: not reversible, not the key. */
export function fingerprintSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

/**
 * Open a seal with whatever the environment currently offers.
 *
 * Current key first, then the retiring one. Returns a `source` so an operator can see a
 * seal that still needs the old key — the signal that a rotation is half-finished.
 */
export function openSecretFromEnv(sealed, env = process.env) {
  const { current, previous } = accessSecrets(env);
  if (current) {
    const opened = openSecret(sealed, current);
    if (opened) return { value: opened, source: 'current' };
  }
  if (previous) {
    const opened = openSecret(sealed, previous);
    if (opened) return { value: opened, source: 'previous' };
  }
  return { value: null, source: null };
}

/** Seal with the current key. Refuses (rather than storing plaintext) when unset. */
export function sealSecretWithEnv(plaintext, env = process.env) {
  const { current } = accessSecrets(env);
  if (!current) throw new Error(`Cannot seal a credential without ${ACCESS_KEY_ENV}`);
  return sealSecret(plaintext, current);
}


/** The stored record, normalised — or null when the tenant has connected nothing. */
export function readAccess(metadata) {
  const raw = metadata && typeof metadata === 'object' ? metadata[ACCESS_FIELD] : null;
  if (!raw || typeof raw !== 'object') return null;
  const envId = String(raw.envId || '').trim();
  if (!envId) return null;
  return {
    provider: String(raw.provider || PROVIDER),
    envId,
    runtime: String(raw.runtime || 'cloud').toLowerCase() === 'local' ? 'local' : 'cloud',
    label: raw.label ? String(raw.label).slice(0, 120) : null,
    keySealed: raw.keySealed ? String(raw.keySealed) : null,
    keyFingerprint: raw.keyFingerprint ? String(raw.keyFingerprint) : null,
    connectedAt: raw.connectedAt || null,
    verifiedAt: raw.verifiedAt || null,
    verifiedPlatforms: Array.isArray(raw.verifiedPlatforms) ? raw.verifiedPlatforms.filter(Boolean) : [],
    reauthRequired: raw.reauthRequired === true,
    reauthPlatforms: Array.isArray(raw.reauthPlatforms) ? raw.reauthPlatforms.filter(Boolean) : [],
    lastCheckedAt: raw.lastCheckedAt || null
  };
}

/** Merge a patch into `metadata.browserAccess` without touching any other key. */
export function writeAccess(metadata, patch = {}) {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const current = base[ACCESS_FIELD] && typeof base[ACCESS_FIELD] === 'object' ? base[ACCESS_FIELD] : {};
  base[ACCESS_FIELD] = { ...current, ...patch, provider: PROVIDER };
  return base;
}

/** Disconnect: drop the field entirely, leaving the rest of metadata alone. */
export function clearAccess(metadata) {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  delete base[ACCESS_FIELD];
  return base;
}

/**
 * The profile a tenant's worker reported from its own machine — or null.
 *
 * Validated like any other envId: a worker is authenticated but still untrusted input, and a
 * malformed id here would be discovered at `env start`, after the run had been claimed.
 */
export function readWorkerBrowser(metadata) {
  const raw = metadata && typeof metadata === 'object' ? metadata[WORKER_BROWSER_FIELD] : null;
  if (!raw || typeof raw !== 'object') return null;
  const envId = String(raw.envId || '').trim();
  if (!isValidEnvId(envId)) return null;
  return {
    envId,
    // A label is what the tenant recognises in their own MoreLogin window ("P-4"), so it is
    // kept — it is not a credential and the tenant typed it themselves.
    label: raw.label ? String(raw.label).slice(0, 120) : null,
    machine: raw.machine ? String(raw.machine).slice(0, 120) : null,
    reportedAt: raw.reportedAt || null,
    // Who put this here: the worker (discovered via ml-cli) or the tenant (typed into the
    // portal because ml-cli was not installed). Same value, different support story — and
    // without this the panel cannot tell the two apart.
    origin: raw.origin === 'tenant' ? 'tenant' : 'worker'
  };
}

export function writeWorkerBrowser(metadata, { envId, label = null, machine = null, reportedAt = null, origin = 'worker' } = {}) {
  const value = String(envId || '').trim();
  if (!isValidEnvId(value)) throw new Error('writeWorkerBrowser needs a decimal MoreLogin envId');
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  base[WORKER_BROWSER_FIELD] = {
    envId: value,
    label: label ? String(label).slice(0, 120) : null,
    machine: machine ? String(machine).slice(0, 120) : null,
    reportedAt: reportedAt || new Date().toISOString(),
    origin: origin === 'tenant' ? 'tenant' : 'worker'
  };
  return base;
}

export function clearWorkerBrowser(metadata) {
  const base = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  delete base[WORKER_BROWSER_FIELD];
  return base;
}

/** What the portal may show about a worker-detected profile. Masked, like everything else. */
export function publicWorkerBrowser(metadata) {
  const found = readWorkerBrowser(metadata);
  if (!found) return null;
  return {
    envIdMasked: maskEnvId(found.envId),
    label: found.label,
    machine: found.machine,
    reportedAt: found.reportedAt
  };
}

/**
 * What the tenant is allowed to see.
 *
 * Deliberately excludes `keySealed` and `keyFingerprint`: a fingerprint is harmless in a
 * support log, but it does not belong in a browser response either, because tenants read
 * those responses and "sha256:…" invites the question of what it is.
 */
export function publicAccessStatus(metadata, { secretConfigured: canStore = true } = {}) {
  const access = readAccess(metadata);
  // Either way the panel needs this, and either way it is masked: it answers "which browser
  // will a run on your computer use" without handing back an id the vendor API accepts.
  const workerBrowser = publicWorkerBrowser(metadata);
  if (!access) {
    return {
      connected: false,
      provider: PROVIDER,
      canStore,
      envIdMasked: null,
      runtime: null,
      label: null,
      connectedAt: null,
      verifiedAt: null,
      platforms: [],
      reauthRequired: false,
      reauthPlatforms: [],
      lastCheckedAt: null,
      workerBrowser,
      hint: workerBrowser
        // The convenience case: the worker found the profile by itself, so there is nothing
        // for the tenant to paste. Say so instead of asking for a key they do not need.
        ? `Your worker reported the browser on this computer (${workerBrowser.label || workerBrowser.envIdMasked}). Captures run there — no key to paste.`
        : canStore
          ? 'Connect your own MoreLogin profile: sign into Micro1/Turing there first, then paste your MoreLogin API key here.'
          : `Connecting your own browser is unavailable on this server until ${ACCESS_KEY_ENV} is set.`
    };
  }

  return {
    connected: true,
    provider: access.provider,
    canStore,
    // Masked on purpose: enough to tell two profiles apart in a screenshot, not enough
    // to be reused against the vendor API.
    envIdMasked: isValidEnvId(access.envId) ? maskEnvId(access.envId) : null,
    runtime: access.runtime,
    label: access.label,
    connectedAt: access.connectedAt,
    verifiedAt: access.verifiedAt,
    platforms: access.verifiedPlatforms,
    reauthRequired: access.reauthRequired,
    reauthPlatforms: access.reauthPlatforms,
    lastCheckedAt: access.lastCheckedAt,
    workerBrowser,
    hint: access.reauthRequired
      ? 'One of your marketplace sessions has expired. Open your MoreLogin profile, sign in again, then press Verify.'
      : access.verifiedAt
        ? 'Connected. Runs read your own profile, so nothing to re-enter here.'
        : 'Connected, not yet verified. Press Verify to confirm the profile is signed in.'
  };
}


/**
 * Which profile and key a run should use for this tenant.
 *
 * Order is deliberate: the tenant's own binding wins, so a tenant that has connected their
 * own MoreLogin is never silently run through the operator's hosted profile. The hosted
 * env map stays as the fallback because that is how the first tenant was onboarded, and a
 * tenant with neither is refused (never guessed).
 *
 * `workerRuns` adds one last resort: the profile the tenant's own worker found on its own
 * machine (`workerBrowser`). It sits **below** hosted and default on purpose — filling the
 * empty case cannot change how any existing tenant resolves, which is the only way to add a
 * fallback without re-testing every pilot. When a worker reports a profile that disagrees
 * with a hosted mapping, `source: 'hosted'` wins and the caller logs the conflict.
 */
export function resolveAccessIdentity({ tenantSlug, metadata, envMap = {}, defaultEnvId = '', workerRuns = false } = {}) {
  const access = readAccess(metadata);
  if (access && access.keySealed) {
    return {
      source: 'tenant',
      envId: access.envId,
      runtime: access.runtime,
      sealedKey: access.keySealed,
      label: access.label
    };
  }
  const slug = String(tenantSlug || '').trim();
  const hosted = envMap && envMap[slug] ? envMap[slug] : null;
  if (hosted && hosted.envId) {
    return { source: 'hosted', envId: String(hosted.envId), runtime: hosted.runtime || 'local', sealedKey: null, label: hosted.label || null };
  }
  const fallback = String(defaultEnvId || '').trim();
  if (fallback) {
    return { source: 'default', envId: fallback, runtime: 'local', sealedKey: null, label: 'default' };
  }
  const reported = workerRuns ? readWorkerBrowser(metadata) : null;
  if (reported) {
    return { source: 'worker', envId: reported.envId, runtime: 'local', sealedKey: null, label: reported.label };
  }
  return null;
}

