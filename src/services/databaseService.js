/**
 * Database Service
 * Fetches dashboard configurations from NeoSphere database
 */

const { isValidSiteSlug, sanitizeSiteSlug } = require('../utils/siteSlugValidator');

/**
 * Fetch all dashboards with remote access enabled
 * Returns dashboards grouped by site slug
 */
async function fetchRemoteAccessConfigurations(pool) {
  try {
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
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching remote access configurations:', error.message);
    throw error;
  }
}


/**
 * Transform database rows into site configuration format
 * Groups remote access configurations by site and builds site configuration object
 */
function transformRemoteAccessToSites(remoteAccessConfigs) {
  const sitesMap = {};
  const invalidConfigs = [];

  remoteAccessConfigs.forEach((config) => {
    let siteSlug = config.site_slug;
    
    // Validate and sanitize site slug
    if (!siteSlug) {
      console.warn(`⚠️  Remote access ${config.id} (${config.name}) has no site_slug - skipping`);
      invalidConfigs.push({ config, reason: 'missing_site_slug' });
      return;
    }
    
    // Sanitize slug if invalid format
    if (!isValidSiteSlug(siteSlug)) {
      const sanitized = sanitizeSiteSlug(siteSlug);
      if (sanitized && sanitized.length > 0) {
        console.warn(`⚠️  Remote access ${config.id} has invalid site_slug "${siteSlug}" - sanitized to "${sanitized}"`);
        siteSlug = sanitized;
      } else {
        console.error(`❌ Remote access ${config.id} has invalid site_slug "${siteSlug}" - cannot sanitize, skipping`);
        invalidConfigs.push({ config, reason: 'invalid_site_slug' });
        return;
      }
    }
    
    // Validate VPN IP
    if (!config.vpn_ip) {
      console.warn(`⚠️  Remote access ${config.id} (${config.name}) has no vpn_ip - skipping`);
      invalidConfigs.push({ config, reason: 'missing_vpn_ip' });
      return;
    }
    
    // Validate VPN IP format (basic check)
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(config.vpn_ip)) {
      console.error(`❌ Remote access ${config.id} has invalid vpn_ip "${config.vpn_ip}" - skipping`);
      invalidConfigs.push({ config, reason: 'invalid_vpn_ip' });
      return;
    }
    
    // Initialize site if not exists
    if (!sitesMap[siteSlug]) {
      sitesMap[siteSlug] = {
        name: siteSlug,
        vpnIp: config.vpn_ip,
        siteName: config.site_name || siteSlug, // Human-readable site name
        neocore: {
          enabled: config.neocore_enabled || false,
          target: config.neocore_enabled 
            ? `http://${config.vpn_ip}:80`
            : null,
          wsTarget: config.neocore_enabled
            ? `http://${config.vpn_ip}:5001`
            : null,
        },
        devices: {
          enabled: false,
          deviceList: {},
        },
        remoteAccessCount: 0, // Track number of remote access configs per site
      };
    }

    const site = sitesMap[siteSlug];
    site.remoteAccessCount++;

    // Update NeoCore configuration if enabled
    if (config.neocore_enabled) {
      site.neocore.enabled = true;
      site.neocore.target = `http://${config.vpn_ip}:80`;
      site.neocore.wsTarget = `http://${config.vpn_ip}:5001`;
    }

    // Add devices from remote access config
    if (config.devices && Array.isArray(config.devices) && config.devices.length > 0) {
      site.devices.enabled = true;
      
      config.devices.forEach((device) => {
        if (!device.deviceId || !device.ip) {
          console.warn(`⚠️  Device in remote access ${config.id} missing deviceId or ip - skipping`);
          return;
        }
        
        // Validate device IP format (should be 172.16.x.x for virtual IPs)
        const virtualIpPattern = /^172\.16\.(\d{1,3})\.(\d{1,3})$/;
        if (!virtualIpPattern.test(device.ip)) {
          console.warn(`⚠️  Device ${device.deviceId} in remote access ${config.id} has invalid virtual IP "${device.ip}" (expected 172.16.x.x) - skipping`);
          return;
        }
        
        // Generate device target URL from virtual IP
        const deviceTarget = `http://${device.ip}`;
        
        // Check for duplicate device IDs (same device in multiple configs)
        if (site.devices.deviceList[device.deviceId]) {
          console.warn(`⚠️  Device ${device.deviceId} already exists for site ${siteSlug} - overwriting`);
        }
        
        site.devices.deviceList[device.deviceId] = {
          name: device.name || device.deviceId,
          virtualIp: device.ip, // Virtual IP (172.16.x.x)
          target: deviceTarget,
          actualIp: device.actualIp || null, // Optional: actual device IP behind NeoCore
          icon: device.icon || null,
          deviceType: device.deviceType || 'local',
        };
      });
    }
  });

  // Log validation results
  if (invalidConfigs.length > 0) {
    console.warn(`⚠️  ${invalidConfigs.length} remote access config(s) skipped due to validation errors:`);
    invalidConfigs.forEach(({ config, reason }) => {
      console.warn(`   - Remote access ${config.id} (${config.name}): ${reason}`);
    });
  }

  return sitesMap;
}

/**
 * Fetch and transform remote access configurations
 * Returns site configuration object compatible with existing proxy structure
 */
async function getSiteConfigurations(pool) {
  try {
    console.log('📊 Fetching remote access configurations from database...');
    
    const remoteAccessConfigs = await fetchRemoteAccessConfigurations(pool);
    console.log(`✅ Found ${remoteAccessConfigs.length} remote access configuration(s)`);

    if (remoteAccessConfigs.length === 0) {
      console.log('⚠️  No remote access configurations found. Using static configuration fallback.');
      return null; // Return null to use static config fallback
    }

    const sites = transformRemoteAccessToSites(remoteAccessConfigs);
    const siteCount = Object.keys(sites).length;
    console.log(`✅ Transformed into ${siteCount} site configuration(s)`);

    // Log site details with validation info
    Object.values(sites).forEach((site) => {
      const deviceCount = site.devices.deviceList 
        ? Object.keys(site.devices.deviceList).length 
        : 0;
      const remoteAccessCount = site.remoteAccessCount || 1;
      console.log(`   📍 ${site.name} (${site.siteName || site.name}):`);
      console.log(`      VPN IP: ${site.vpnIp}`);
      console.log(`      NeoCore: ${site.neocore.enabled ? '✅ enabled' : '❌ disabled'}`);
      console.log(`      Devices: ${deviceCount}`);
      console.log(`      Remote Access Configs: ${remoteAccessCount}`);
      
      // Validate site configuration
      if (!site.neocore.enabled && deviceCount === 0) {
        console.warn(`      ⚠️  Site ${site.name} has no NeoCore or devices enabled`);
      }
    });

    return sites;
  } catch (error) {
    console.error('❌ Error getting site configurations:', error.message);
    console.error('⚠️  Falling back to static configuration.');
    return null; // Return null to use static config fallback
  }
}

/**
 * Refresh site configurations from database
 * Useful for periodic updates or manual refresh
 */
async function refreshSiteConfigurations(pool) {
  return getSiteConfigurations(pool);
}

module.exports = {
  fetchRemoteAccessConfigurations,
  transformRemoteAccessToSites,
  getSiteConfigurations,
  refreshSiteConfigurations,
  // Legacy exports for backward compatibility
  fetchDashboardsWithRemoteAccess: fetchRemoteAccessConfigurations,
  transformDashboardsToSites: transformRemoteAccessToSites,
};
