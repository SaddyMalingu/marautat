/**
 * Alphadome Browser Actor Runtime — public entry point.
 *
 * An agent imports from here; it never imports moreloginClient.js or
 * cdp.js directly, so the transport and the driver stay swappable.
 */
export {
  BrowserActorError,
  BROWSER_ACTOR_CODES,
  isBrowserActorError,
  toPublicError,
  httpStatusForCode
} from './errors.js';

export {
  IDENTITY_TABLE,
  SESSION_TABLE,
  IDENTITY_MIGRATION,
  normalizeTenantSlug,
  parseProfileMap,
  resolveIdentity,
  listIdentities,
  describeIdentity,
  maskEnvId,
  isValidEnvId
} from './identity.js';

export {
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  clampLease,
  createSessionBroker,
  publicSession
} from './sessions.js';

export { createMoreloginClient, resolveConfig, parseJsonLoose, redact, isBusinessFailure } from './moreloginClient.js';

export {
  createBrowserRuntime,
  normalizeStartResult,
  extractList,
  extractTotal
} from './runtime.js';

export { resolveDebugTarget, CdpSession, capturePage, captureScreenshot, buildCaptureExpression } from './cdp.js';

export {
  GEO_PROOF_URL,
  parseGeoProof,
  isUsableProof,
  assertCountry,
  maskIp,
  geoSummary
} from './geo.js';
