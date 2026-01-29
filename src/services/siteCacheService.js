/**
 * Site Lookup Service
 * Provides runtime lookup of site configurations by slug (no caching - fresh DB lookup every time)
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
const { transformRemoteAccessToSites } = require('./databaseService');
const { isValidSiteSlug, sanitizeSiteSlug } = require('../utils/siteSlugValidator');

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
 * Get site configuration from database (no caching - fresh lookup every time)
 * @param {string} siteSlug - Site slug to lookup
 * @returns {Promise<Object|null>} Site configuration or null if not found
 */
async function getSiteBySlug(siteSlug) {
  if (!siteSlug) {
    return null;
  }

  // Always do fresh database lookup (no caching)
  console.log(`🔍 Looking up site in database: ${siteSlug}`);
  const siteConfig = await lookupSiteBySlug(siteSlug);

  return siteConfig;
}

module.exports = {
  getSiteBySlug,
  lookupSiteBySlug,
  setDatabasePool,
  getPool,
};
