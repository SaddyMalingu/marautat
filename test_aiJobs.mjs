/**
 * AI Jobs Subsystem Tests
 * 
 * Run with: node test_aiJobs.mjs
 */

import { resolveReferralUrl, isValidReferralUrl, DEFAULT_REFERRAL_URLS, ALLOWED_REDIRECT_DOMAINS } from './utils/aiJobsConfig.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Test 1: Job-specific URL takes precedence
test('Job-specific referral URL takes precedence', () => {
  const opportunity = { referral_url: 'https://t.mercor.com/JOB123' };
  const category = { referral_url: 'https://t.mercor.com/20MWE' };
  const result = resolveReferralUrl(opportunity, category, DEFAULT_REFERRAL_URLS.general);
  assert(result === 'https://t.mercor.com/JOB123', `Expected job URL, got ${result}`);
});

// Test 2: Category URL used when no job-specific URL
test('Category URL used when no job-specific URL', () => {
  const opportunity = {};
  const category = { referral_url: 'https://t.mercor.com/20MWE' };
  const result = resolveReferralUrl(opportunity, category, DEFAULT_REFERRAL_URLS.general);
  assert(result === 'https://t.mercor.com/20MWE', `Expected category URL, got ${result}`);
});

// Test 3: General URL used as fallback
test('General URL used as fallback', () => {
  const opportunity = {};
  const category = {};
  const result = resolveReferralUrl(opportunity, category, DEFAULT_REFERRAL_URLS.general);
  assert(result === DEFAULT_REFERRAL_URLS.general, `Expected general URL, got ${result}`);
});

// Test 4: Valid Mercor URL passes validation
test('Valid Mercor URL passes validation', () => {
  assert(isValidReferralUrl('https://t.mercor.com/20MWE') === true, 'Should be valid');
});

// Test 5: Invalid URL fails validation
test('Invalid URL fails validation', () => {
  assert(isValidReferralUrl('https://evil.com/steal') === false, 'Should be invalid');
});

// Test 6: Null URL fails validation
test('Null URL fails validation', () => {
  assert(isValidReferralUrl(null) === false, 'Should be invalid');
});

// Test 7: Empty string fails validation
test('Empty string fails validation', () => {
  assert(isValidReferralUrl('') === false, 'Should be invalid');
});

// Test 8: All category referral URLs are valid
test('All category referral URLs are valid', () => {
  for (const [slug, url] of Object.entries(DEFAULT_REFERRAL_URLS.categories)) {
    assert(isValidReferralUrl(url), `Category ${slug} URL should be valid: ${url}`);
  }
});

// Test 9: General referral URL is valid
test('General referral URL is valid', () => {
  assert(isValidReferralUrl(DEFAULT_REFERRAL_URLS.general), 'General URL should be valid');
});

// Test 10: Allowed domains list includes Mercor
test('Allowed domains include Mercor', () => {
  assert(ALLOWED_REDIRECT_DOMAINS.includes('t.mercor.com'), 'Should include t.mercor.com');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
