/**
 * Site Cache Service
 * Provides runtime lookup and caching of site configurations by slug
 */

const { createDatabasePool } = require('../config/database');

// Get pool instance (will be set by index.js)
let dbPool = null;

function setDatabasePool(pool) {
  dbPool = pool;
}

function getPool() {
  return dbPool;
}
const { transformDashboardsToSites } = require('./databaseService');
const { isValidSiteSlug, sanitizeSiteSlug } = require('../utils/siteSlugValidator');

// In-memory cache: { siteSlug: { siteConfig, lastUpdated, expiresAt } }
const siteCache = new Map();

// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Lookup site configuration by slug from database
 * @param {string} siteSlug - Site slug to lookup
 * @returns {Promise<Object|null>} Site configuration or null if not found
 */
async function lookupSiteBySlug(siteSlug) {
  const pool = getPool();
  if (!pool) {
    console.warn(`⚠️  Database not available for site lookup: ${siteSlug}`);
    return null;
  }

  try {
    // Validate and sanitize slug
    let validSlug = siteSlug;
    if (!isValidSiteSlug(siteSlug)) {
      const sanitized = sanitizeSiteSlug(siteSlug);
      if (sanitized && sanitized.length > 0) {
        console.warn(`⚠️  Invalid site slug "${siteSlug}" - sanitized to "${sanitized}"`);
        validSlug = sanitized;
      } else {
        console.error(`❌ Invalid site slug "${siteSlug}" - cannot sanitize`);
        return null;
      }
    }

    // Query database for remote access configurations with this site slug
    const query = `
      SELECT 
        ra.id,
        ra.name,
        ra.site_id,
        ra.vpn_config_id,
        ra.vpn_ip,
        ra.neocore_enabled,
        ra.devices,
        ra.is_active,
        ra.display_order,
        s.slug as site_slug,
        s.name as site_name
      FROM remote_access ra
      INNER JOIN sites s ON ra.site_id = s.id
      WHERE s.slug = $1
        AND ra.vpn_ip IS NOT NULL
        AND ra.is_active = true
      ORDER BY ra.display_order
    `;

    const result = await pool.query(query, [validSlug]);
    
    if (result.rows.length === 0) {
      console.log(`ℹ️  No remote access configurations found for site slug: ${validSlug}`);
      return null;
    }

    // Transform remote access configs to site configuration
    const sitesMap = transformRemoteAccessToSites(result.rows);
    const siteConfig = sitesMap[validSlug];

    if (!siteConfig) {
      console.warn(`⚠️  Site configuration not found after transformation for slug: ${validSlug}`);
      return null;
    }

    console.log(`✅ Found site configuration for ${validSlug}: VPN IP ${siteConfig.vpnIp}, NeoCore: ${siteConfig.neocore?.enabled ? 'enabled' : 'disabled'}, Devices: ${Object.keys(siteConfig.devices?.deviceList || {}).length}`);
    
    return siteConfig;
  } catch (error) {
    console.error(`❌ Error looking up site ${siteSlug}:`, error.message);
    return null;
  }
}

/**
 * Get site configuration from cache or database
 * @param {string} siteSlug - Site slug to lookup
 * @returns {Promise<Object|null>} Site configuration or null if not found
 */
async function getSiteBySlug(siteSlug) {
  if (!siteSlug) {
    return null;
  }

  // Check cache first
  const cached = siteCache.get(siteSlug);
  if (cached) {
    const now = Date.now();
    if (cached.expiresAt > now) {
      // Cache hit - return cached configuration
      console.log(`💾 Cache hit for site: ${siteSlug}`);
      return cached.siteConfig;
    } else {
      // Cache expired - remove it
      console.log(`⏰ Cache expired for site: ${siteSlug}`);
      siteCache.delete(siteSlug);
    }
  }

  // Cache miss - lookup from database
  console.log(`🔍 Cache miss for site: ${siteSlug} - looking up in database...`);
  const siteConfig = await lookupSiteBySlug(siteSlug);

  if (siteConfig) {
    // Store in cache
    const now = Date.now();
    siteCache.set(siteSlug, {
      siteConfig,
      lastUpdated: now,
      expiresAt: now + CACHE_TTL_MS,
    });
    console.log(`💾 Cached site configuration for: ${siteSlug}`);
  } else {
    // Not found - cache negative result for shorter time (1 minute)
    const now = Date.now();
    siteCache.set(siteSlug, {
      siteConfig: null,
      lastUpdated: now,
      expiresAt: now + 60 * 1000, // 1 minute for negative cache
    });
    console.log(`⚠️  Site not found: ${siteSlug} - cached negative result`);
  }

  return siteConfig;
}

/**
 * Invalidate cache for a specific site slug
 * @param {string} siteSlug - Site slug to invalidate
 */
function invalidateSiteCache(siteSlug) {
  if (siteSlug) {
    siteCache.delete(siteSlug);
    console.log(`🗑️  Invalidated cache for site: ${siteSlug}`);
  }
}

/**
 * Clear all site cache
 */
function clearSiteCache() {
  siteCache.clear();
  console.log('🗑️  Cleared all site cache');
}

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
function getCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  siteCache.forEach((cached) => {
    if (cached.expiresAt > now) {
      validEntries++;
    } else {
      expiredEntries++;
    }
  });

  return {
    totalEntries: siteCache.size,
    validEntries,
    expiredEntries,
  };
}

module.exports = {
  getSiteBySlug,
  lookupSiteBySlug,
  invalidateSiteCache,
  clearSiteCache,
  getCacheStats,
  setDatabasePool,
  getPool,
};
