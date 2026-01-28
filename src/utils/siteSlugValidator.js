/**
 * Site Slug Validation Utilities
 * Ensures site slugs are URL-safe and valid for routing
 */

/**
 * Validate site slug format
 * Site slugs should be URL-safe (alphanumeric, hyphens, underscores)
 * 
 * @param {string} slug - Site slug to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function isValidSiteSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return false;
  }
  // URL-safe: alphanumeric, hyphens, underscores, no spaces
  const slugPattern = /^[a-zA-Z0-9_-]+$/;
  return slugPattern.test(slug) && slug.length > 0 && slug.length <= 255;
}

/**
 * Sanitize site slug for URL usage
 * Converts to lowercase and replaces invalid characters
 * 
 * @param {string} slug - Site slug to sanitize
 * @returns {string|null} - Sanitized slug or null if invalid
 */
function sanitizeSiteSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return null;
  }
  return slug
    .toLowerCase()
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-') // Replace invalid chars with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Normalize site slug (ensure consistent format)
 * 
 * @param {string} slug - Site slug to normalize
 * @returns {string|null} - Normalized slug or null if invalid
 */
function normalizeSiteSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    return null;
  }
  
  // First sanitize
  const sanitized = sanitizeSiteSlug(slug);
  if (!sanitized || sanitized.length === 0) {
    return null;
  }
  
  // Then validate
  if (!isValidSiteSlug(sanitized)) {
    return null;
  }
  
  return sanitized;
}

module.exports = {
  isValidSiteSlug,
  sanitizeSiteSlug,
  normalizeSiteSlug,
};
