/**
 * Test Routes for VPN Proxy Service
 * Provides endpoints for testing and validation
 */

/**
 * Register test routes
 * @param {Express} app - Express application
 * @param {Function} getSites - Function to get current site configurations
 * @param {Pool} dbPool - Database connection pool (optional)
 */
function registerTestRoutes(app, getSites, dbPool) {
  // Get current sites helper
  const getCurrentSites = () => {
    if (typeof getSites === 'function') {
      return getSites();
    }
    return getSites || {};
  };

  /**
   * Test endpoint: List all configured sites
   * GET /test/sites
   */
  app.get('/test/sites', (req, res) => {
    try {
      const sites = getCurrentSites();
      const siteList = Object.values(sites).map(site => ({
        name: site.name,
        siteName: site.siteName || site.name,
        vpnIp: site.vpnIp,
        neocore: {
          enabled: site.neocore?.enabled || false,
          target: site.neocore?.target || null,
          wsTarget: site.neocore?.wsTarget || null,
        },
        devices: {
          enabled: site.devices?.enabled || false,
          deviceCount: site.devices?.deviceList ? Object.keys(site.devices.deviceList).length : 0,
          deviceList: site.devices?.deviceList ? Object.entries(site.devices.deviceList).map(([id, config]) => ({
            id,
            name: config.name || id,
            virtualIp: config.virtualIp,
            target: config.target,
            deviceType: config.deviceType || 'local',
          })) : [],
        },
        dashboardCount: site.dashboardCount || 0,
      }));

      res.json({
        success: true,
        siteCount: siteList.length,
        sites: siteList,
        configurationSource: dbPool ? 'database' : 'static',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Test endpoint: Validate site configuration
   * GET /test/validate/:siteName
   */
  app.get('/test/validate/:siteName', (req, res) => {
    try {
      const siteName = req.params.siteName;
      const sites = getCurrentSites();
      const site = sites[siteName];

      if (!site) {
        return res.status(404).json({
          success: false,
          error: 'Site not found',
          siteName,
        });
      }

      const validation = {
        siteName: site.name,
        siteDisplayName: site.siteName || site.name,
        valid: true,
        errors: [],
        warnings: [],
      };

      // Validate VPN IP
      if (!site.vpnIp) {
        validation.valid = false;
        validation.errors.push('VPN IP is missing');
      } else {
        const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipPattern.test(site.vpnIp)) {
          validation.valid = false;
          validation.errors.push(`Invalid VPN IP format: ${site.vpnIp}`);
        }
      }

      // Validate NeoCore configuration
      if (site.neocore?.enabled) {
        if (!site.neocore.target) {
          validation.valid = false;
          validation.errors.push('NeoCore target is missing');
        }
        if (!site.neocore.wsTarget) {
          validation.warnings.push('NeoCore WebSocket target is missing (will use regular target)');
        }
      } else {
        validation.warnings.push('NeoCore is not enabled');
      }

      // Validate devices
      if (site.devices?.enabled) {
        const deviceList = site.devices.deviceList || {};
        const deviceCount = Object.keys(deviceList).length;

        if (deviceCount === 0) {
          validation.warnings.push('Devices enabled but no devices configured');
        } else {
          Object.entries(deviceList).forEach(([deviceId, device]) => {
            if (!device.virtualIp) {
              validation.errors.push(`Device ${deviceId}: Virtual IP is missing`);
              validation.valid = false;
            } else {
              const virtualIpPattern = /^172\.16\.(\d{1,3})\.(\d{1,3})$/;
              if (!virtualIpPattern.test(device.virtualIp)) {
                validation.errors.push(`Device ${deviceId}: Invalid virtual IP format (expected 172.16.x.x)`);
                validation.valid = false;
              }
            }
            if (!device.target) {
              validation.errors.push(`Device ${deviceId}: Target URL is missing`);
              validation.valid = false;
            }
          });
        }
      }

      // Check if site has any enabled features
      if (!site.neocore?.enabled && !site.devices?.enabled) {
        validation.warnings.push('Site has no NeoCore or devices enabled');
      }

      res.json({
        success: true,
        validation,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * Test endpoint: Test database connectivity
   * GET /test/database
   */
  app.get('/test/database', async (req, res) => {
    if (!dbPool) {
      return res.json({
        success: false,
        message: 'Database not configured',
        configured: false,
      });
    }

    try {
      const startTime = Date.now();
      const result = await dbPool.query('SELECT NOW() as current_time, version() as pg_version');
      const queryTime = Date.now() - startTime;

      res.json({
        success: true,
        configured: true,
        connected: true,
        queryTime: `${queryTime}ms`,
        database: {
          currentTime: result.rows[0].current_time,
          version: result.rows[0].pg_version.split(' ')[0] + ' ' + result.rows[0].pg_version.split(' ')[1],
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        configured: true,
        connected: false,
        error: error.message,
      });
    }
  });

  /**
   * Test endpoint: Test dashboard query
   * GET /test/dashboards
   */
  app.get('/test/dashboards', async (req, res) => {
    if (!dbPool) {
      return res.json({
        success: false,
        message: 'Database not configured',
        configured: false,
      });
    }

    try {
      const { fetchDashboardsWithRemoteAccess } = require('../services/databaseService');
      const dashboards = await fetchDashboardsWithRemoteAccess(dbPool);

      res.json({
        success: true,
        dashboardCount: dashboards.length,
        dashboards: dashboards.map(d => ({
          id: d.id,
          name: d.name,
          siteSlug: d.site_slug,
          siteName: d.site_name,
          vpnIp: d.vpn_ip,
          neocoreEnabled: d.neocore_enabled,
          deviceCount: d.devices ? (Array.isArray(d.devices) ? d.devices.length : 0) : 0,
        })),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  });

  /**
   * Test endpoint: Test site configuration transformation
   * GET /test/transform
   */
  app.get('/test/transform', async (req, res) => {
    if (!dbPool) {
      return res.json({
        success: false,
        message: 'Database not configured',
        configured: false,
      });
    }

    try {
      const { getSiteConfigurations } = require('../services/databaseService');
      const sites = await getSiteConfigurations(dbPool);

      if (!sites) {
        return res.json({
          success: false,
          message: 'No site configurations found',
          sites: null,
        });
      }

      res.json({
        success: true,
        siteCount: Object.keys(sites).length,
        sites: sites,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  });

  /**
   * Test endpoint: Health check with detailed info
   * GET /test/health
   */
  app.get('/test/health', async (req, res) => {
    try {
      const sites = getCurrentSites();
      const siteCount = Object.keys(sites).length;
      const sitesWithNeoCore = Object.values(sites).filter(s => s.neocore?.enabled).length;
      const sitesWithDevices = Object.values(sites).filter(s => s.devices?.enabled).length;
      const totalDevices = Object.values(sites).reduce((sum, s) => {
        return sum + (s.devices?.deviceList ? Object.keys(s.devices.deviceList).length : 0);
      }, 0);

      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        configuration: {
          source: dbPool ? 'database' : 'static',
          siteCount,
          sitesWithNeoCore,
          sitesWithDevices,
          totalDevices,
        },
        database: dbPool ? {
          configured: true,
          connected: false, // Will be set by test
        } : {
          configured: false,
        },
      };

      // Test database connection if available
      if (dbPool) {
        try {
          await dbPool.query('SELECT 1');
          health.database.connected = true;
        } catch (error) {
          health.database.connected = false;
          health.database.error = error.message;
        }
      }

      res.json(health);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error.message,
      });
    }
  });

  console.log('✅ Test routes registered:');
  console.log('   GET /test/sites - List all configured sites');
  console.log('   GET /test/validate/:siteName - Validate site configuration');
  console.log('   GET /test/database - Test database connectivity');
  console.log('   GET /test/dashboards - Test dashboard query');
  console.log('   GET /test/transform - Test site configuration transformation');
  console.log('   GET /test/health - Detailed health check');
}

module.exports = { registerTestRoutes };
