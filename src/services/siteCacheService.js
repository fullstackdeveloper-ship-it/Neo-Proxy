/**
 * Site Cache Service
 * Provides runtime lookup and caching of site configurations by slug
 */

const { createDatabasePool } = require('../config/database');
const { transformRemoteAccessToSites } = require('./databaseService');
const { isValidSiteSlug, sanitizeSiteSlug } = require('../utils/siteSlugValidator');

// Get pool instance (will be set by index.js)
let dbPool = null;

function setDatabasePool(pool) {
  dbPool = pool;
}

function getPool() {
  return dbPool;
}

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
    // (databaseService exports this transformer under the legacy name transformDashboardsToSites)
    const sitesMap = transformDashboardsToSites(result.rows);
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
 * Preload all sites from database into cache
 * This should be called at startup to populate cache with all available sites
 * @returns {Promise<number>} Number of sites preloaded
 */
async function preloadAllSitesToCache() {
  const pool = getPool();
  if (!pool) {
    console.warn('⚠️  Database pool not available - cannot preload sites to cache');
    return 0;
  }

  try {
    console.log('📊 Preloading all sites from database into cache...');
    
    // Fetch all remote access configurations
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
      WHERE ra.vpn_ip IS NOT NULL
        AND ra.is_active = true
      ORDER BY s.slug, ra.display_order
    `;

    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      console.log('ℹ️  No remote access configurations found to preload');
      return 0;
    }

    // Transform and group by site slug
    const sitesMap = transformRemoteAccessToSites(result.rows);
    const siteSlugs = Object.keys(sitesMap);
    
    // Preload each site into cache
    const now = Date.now();
    let preloadedCount = 0;
    
    siteSlugs.forEach((siteSlug) => {
      const siteConfig = sitesMap[siteSlug];
      if (siteConfig) {
        siteCache.set(siteSlug, {
          siteConfig,
          lastUpdated: now,
          expiresAt: now + CACHE_TTL_MS,
        });
        preloadedCount++;
      }
    });

    console.log(`✅ Preloaded ${preloadedCount} site(s) into cache: ${siteSlugs.join(', ')}`);
    return preloadedCount;
  } catch (error) {
    console.error(`❌ Error preloading sites to cache: ${error.message}`);
    return 0;
  }
}

/**
 * Get site configuration from cache or database
 * Uses cache-first approach: check cache, if miss and DB available, lookup and cache
 * @param {string} siteSlug - Site slug to lookup
 * @returns {Promise<Object|null>} Site configuration or null if not found
 */
async function getSiteBySlug(siteSlug) {
  if (!siteSlug) {
    return null;
  }

  // Check cache first (cache hit)
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

  // Cache miss - try database lookup if available
  const pool = getPool();
  if (!pool) {
    console.warn(`⚠️  Cache miss for site: ${siteSlug} - database not available`);
    return null;
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
  preloadAllSitesToCache,
  invalidateSiteCache,
  clearSiteCache,
  getCacheStats,
  setDatabasePool,
  getPool,
};
