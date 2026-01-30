/**
 * Site Lookup Service
 * Runtime lookup of site configurations by slug (fresh DB lookup)
 * Supports new schema: remote_access with type, slug, ip
 */

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
 */
async function lookupSiteBySlug(siteSlug) {
  const pool = getPool();
  if (!pool) {
    console.warn(`⚠️  Database not available for site lookup: ${siteSlug}`);
    return null;
  }

  try {
    let validSlug = siteSlug;
    if (!isValidSiteSlug(siteSlug)) {
      const sanitized = sanitizeSiteSlug(siteSlug);
      if (sanitized && sanitized.length > 0) {
        validSlug = sanitized;
      } else {
        return null;
      }
    }

    const query = `
      SELECT 
        ra.id,
        ra.site_id,
        ra.type,
        ra.slug,
        ra.name,
        ra.ip,
        ra.is_active,
        ra.display_order,
        s.slug as site_slug,
        s.name as site_name
      FROM remote_access ra
      INNER JOIN sites s ON ra.site_id = s.id
      WHERE s.slug = $1
        AND ra.ip IS NOT NULL
        AND ra.is_active = true
      ORDER BY ra.type, ra.display_order
    `;

    const result = await pool.query(query, [validSlug]);

    if (result.rows.length === 0) {
      return null;
    }

    const sitesMap = transformRemoteAccessToSites(result.rows);
    const siteConfig = sitesMap[validSlug];

    if (siteConfig) {
      const nc = Object.keys(siteConfig.neocores || {}).length;
      const dc = Object.keys(siteConfig.devices?.deviceList || {}).length;
      console.log(`✅ Found site ${validSlug}: ${nc} neocore(s), ${dc} device(s)`);
    }

    return siteConfig || null;
  } catch (error) {
    console.error(`❌ Error looking up site ${siteSlug}:`, error.message);
    return null;
  }
}

async function getSiteBySlug(siteSlug) {
  if (!siteSlug) return null;
  console.log(`🔍 Looking up site in database: ${siteSlug}`);
  return lookupSiteBySlug(siteSlug);
}

module.exports = {
  getSiteBySlug,
  lookupSiteBySlug,
  setDatabasePool,
  getPool,
};
