/**
 * Database Service
 * Fetches remote access configurations from NeoSphere database
 * Single table: remote_access with type ('neocore'|'device'), slug, ip, site_id
 * Port 80 for HTTP, 5001 for WebSocket (fixed)
 */

const { isValidSiteSlug, sanitizeSiteSlug } = require('../utils/siteSlugValidator');

const HTTP_PORT = 80;
const WS_PORT = 5001;

/**
 * Fetch all remote_access rows (neocore and device) with site info
 */
async function fetchRemoteAccessConfigurations(pool) {
  try {
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
      WHERE ra.ip IS NOT NULL
        AND ra.is_active = true
      ORDER BY s.slug, ra.type, ra.display_order
    `;

    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching remote access configurations:', error.message);
    throw error;
  }
}

/**
 * Transform database rows into site configuration format
 * Each row is either type='neocore' or type='device'; build site.neocores and site.devices
 */
function transformRemoteAccessToSites(remoteAccessConfigs) {
  const sitesMap = {};
  const invalidConfigs = [];

  remoteAccessConfigs.forEach((config) => {
    let siteSlug = config.site_slug;

    if (!siteSlug) {
      invalidConfigs.push({ config, reason: 'missing_site_slug' });
      return;
    }

    if (!isValidSiteSlug(siteSlug)) {
      const sanitized = sanitizeSiteSlug(siteSlug);
      if (sanitized && sanitized.length > 0) {
        siteSlug = sanitized;
      } else {
        invalidConfigs.push({ config, reason: 'invalid_site_slug' });
        return;
      }
    }

    if (!config.slug) {
      invalidConfigs.push({ config, reason: 'missing_slug' });
      return;
    }

    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(config.ip)) {
      invalidConfigs.push({ config, reason: 'invalid_ip' });
      return;
    }

    if (!sitesMap[siteSlug]) {
      sitesMap[siteSlug] = {
        name: siteSlug,
        siteName: config.site_name || siteSlug,
        neocores: {},
        devices: {
          enabled: false,
          deviceList: {},
        },
      };
    }

    const site = sitesMap[siteSlug];

    if (config.type === 'neocore') {
      site.neocores[config.slug] = {
        target: `http://${config.ip}:${HTTP_PORT}`,
        wsTarget: `http://${config.ip}:${WS_PORT}`,
        name: config.name || config.slug,
      };
    } else if (config.type === 'device') {
      site.devices.enabled = true;
      site.devices.deviceList[config.slug] = {
        name: config.name || config.slug,
        virtualIp: config.ip,
        target: `http://${config.ip}:${HTTP_PORT}`,
      };
    }
  });

  if (invalidConfigs.length > 0) {
    console.warn(`⚠️  ${invalidConfigs.length} remote access row(s) skipped:`);
    invalidConfigs.forEach(({ config, reason }) => {
      console.warn(`   - id ${config.id} (${config.type}/${config.slug}): ${reason}`);
    });
  }

  return sitesMap;
}

/**
 * Fetch and transform remote access configurations
 */
async function getSiteConfigurations(pool) {
  try {
    console.log('📊 Fetching remote access configurations from database...');

    const rows = await fetchRemoteAccessConfigurations(pool);
    console.log(`✅ Found ${rows.length} remote_access row(s)`);

    if (rows.length === 0) {
      console.log('⚠️  No remote access rows found. Using static configuration fallback.');
      return null;
    }

    const sites = transformRemoteAccessToSites(rows);
    const siteCount = Object.keys(sites).length;
    console.log(`✅ Transformed into ${siteCount} site(s)`);

    Object.values(sites).forEach((site) => {
      const neocoreCount = Object.keys(site.neocores || {}).length;
      const deviceCount = Object.keys(site.devices?.deviceList || {}).length;
      console.log(`   📍 ${site.name}: ${neocoreCount} neocore(s), ${deviceCount} device(s)`);
    });

    return sites;
  } catch (error) {
    console.error('❌ Error getting site configurations:', error.message);
    return null;
  }
}

/**
 * Refresh site configurations from database
 */
async function refreshSiteConfigurations(pool) {
  return getSiteConfigurations(pool);
}

module.exports = {
  fetchRemoteAccessConfigurations,
  transformRemoteAccessToSites,
  getSiteConfigurations,
  refreshSiteConfigurations,
  fetchDashboardsWithRemoteAccess: fetchRemoteAccessConfigurations,
  transformDashboardsToSites: transformRemoteAccessToSites,
};
