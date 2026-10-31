/**
 * Distribution layer — turning a published Writer's Flow page into a post.
 *
 * postText.js    composes copy per platform (X's t.co weighting, LinkedIn's fold)
 * xPublisher.js  posts it through X API v2 with a per-tenant token
 */
export {
  X_LIMIT,
  X_URL_WEIGHT,
  LINKEDIN_LIMIT,
  LINKEDIN_FOLD,
  weightedLength,
  trimToWeight,
  normalizeHashtags,
  composeXPost,
  composeLinkedInPost
} from './postText.js';

export {
  SocialError,
  SOCIAL_ERROR_CODES,
  normalizeSocialCode,
  redactSecret,
  resolveXToken,
  createXPublisher
} from './xPublisher.js';
