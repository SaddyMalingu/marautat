/**
 * Geo proof (2026-10-31)
 *
 * A MoreLogin profile is only worth its proxy if the egress is where the work
 * says it is. A Kenyan tender portal read from a New York address is exactly the
 * signal that makes a portal block, rate-limit or ban an account — and worse, it
 * silently produces data that looks valid.
 *
 * So geo is treated as an assertion, not a log line: every session that claims a
 * country must prove it, and a mismatch aborts the run with `geo_mismatch`
 * instead of writing rows that cannot be trusted.
 *
 * `parseGeoProof` accepts the ipinfo.io/json shape (ip, city, region, country,
 * org, loc, bogon) and tolerates ip-api's shape (query, countryCode, isp). Pure.
 */
import { BrowserActorError } from './errors.js';

/** The URL an agent should capture to prove its egress. */
export const GEO_PROOF_URL = 'https://ipinfo.io/json';

function asCoord(value) {
  const parts = String(value || '').split(',');
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/**
 * @returns {{ip: string|null, country: string, city: string|null, region: string|null,
 *            org: string|null, loc: {lat:number, lon:number}|null, bogon: boolean, source: string}}
 */
export function parseGeoProof(payload, { source = 'ipinfo' } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new BrowserActorError('invalid_request', 'A geo proof payload is required');
  }
  const rawCountry = payload.country || payload.countryCode || payload.country_code || payload.country_code2 || '';
  const country = String(rawCountry || '').trim().toUpperCase().slice(0, 2);
  return {
    ip: payload.ip ? String(payload.ip) : payload.query ? String(payload.query) : null,
    country,
    city: payload.city ? String(payload.city) : null,
    region: payload.region ? String(payload.region) : payload.regionName ? String(payload.regionName) : null,
    org: payload.org ? String(payload.org) : payload.isp ? String(payload.isp) : null,
    loc: asCoord(payload.loc),
    // ipinfo sets `bogon` when the caller is on a private/reserved range: the
    // proxy chain is not exiting through a public address, so there is no geo.
    bogon: payload.bogon === true || payload.status === 'fail',
    source
  };
}

/** A proof that cannot be used to assert anything. */
export function isUsableProof(proof) {
  return Boolean(proof) && proof.bogon !== true && /^[A-Z]{2}$/.test(String(proof.country || ''));
}

/**
 * Assert the egress matches the country the work requires.
 * Throws `geo_mismatch` — never returns a boolean that a caller can ignore.
 */
export function assertCountry(proof, expected) {
  const want = String(expected || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(want)) {
    throw new BrowserActorError('invalid_request', 'expected country must be a two-letter ISO code', {
      details: { expected: expected ?? null }
    });
  }
  if (!isUsableProof(proof)) {
    throw new BrowserActorError('geo_mismatch', 'The profile has no usable public egress', {
      details: {
        expected: want,
        actual: proof?.country || null,
        bogon: proof?.bogon === true,
        fix: 'Check the profile proxy: a bogon/private exit means the chain is not public.'
      }
    });
  }
  if (proof.country !== want) {
    throw new BrowserActorError('geo_mismatch', `Egress is ${proof.country}, expected ${want}`, {
      details: { expected: want, actual: proof.country, city: proof.city || null, org: proof.org || null }
    });
  }
  return proof;
}

/** Keep enough of an IP to corroborate a run, not enough to reuse it. */
export function maskIp(ip) {
  const value = String(ip || '');
  if (!value) return null;
  if (value.includes(':')) {
    const head = value.split(':').filter(Boolean).slice(0, 2).join(':');
    return head ? `${head}:****` : null;
  }
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.x.x`;
}

/** The row we store with an opportunity: proof without the raw address. */
export function geoSummary(proof) {
  if (!proof) return null;
  return {
    country: proof.country || null,
    city: proof.city || null,
    org: proof.org || null,
    ip: maskIp(proof.ip),
    bogon: proof.bogon === true,
    source: proof.source || null
  };
}
