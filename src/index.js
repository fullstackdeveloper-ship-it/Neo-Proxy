/**
 * VPN Proxy Service - Main Entry Point
 */

// Load environment variables from .env if present (optional; doesn't break deployments without dotenv)
try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch (e) {
  // dotenv is optional in this project; env vars may be provided by systemd/docker instead
}

const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const STATIC_SITES = require("./config/sites"); // Static fallback configuration
const { createDatabasePool, testConnection } = require("./config/database");
const { getSiteConfigurations, refreshSiteConfigurations } = require("./services/databaseService");
const { setDatabasePool, preloadAllSitesToCache } = require("./services/siteCacheService");
const { registerAllRoutes } = require("./services/routeManager");
const { registerTestRoutes } = require("./routes/testRoutes");

const app = express();
const server = http.createServer(app);

// Attach server to app for WebSocket support
app.set('server', server);

// Cookie parser middleware (for site tracking)
app.use(cookieParser());

// Initialize database connection (optional - falls back to static config if unavailable)
let dbPool = null;
let SITES = STATIC_SITES; // Default to static configuration
let routeManager = null; // Reference to route manager for re-registration

// Shared function to update SITES configuration
function updateSitesConfiguration(newSites) {
  if (newSites && Object.keys(newSites).length > 0) {
    SITES = newSites;
    console.log('✅ Site configurations updated');
    
    // Re-register routes with new configurations
    if (routeManager) {
      console.log('🔄 Re-registering routes with updated configurations...');
      // Note: Express doesn't allow removing middleware, but routes will use updated SITES
      // For WebSocket handlers, we'll need to handle them separately
      routeManager.updateSites(SITES);
    }
    
    return true;
  }
  return false;
}

async function initializeDatabase() {
  try {
    // Always try to connect to database (use defaults if env vars not set)
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'mydb';
    const dbUser = process.env.DB_USER || 'postgres';
    
    console.log(
      `📊 Initializing database connection (host=${dbHost}, port=${dbPort}, db=${dbName}, user=${dbUser})...`,
    );
    
    dbPool = createDatabasePool();
    // Make pool available to runtime lookup/caching layer
    setDatabasePool(dbPool);
    
    const connected = await testConnection(dbPool);
    if (!connected) {
      console.log('⚠️  Database connection failed. Will use static site configuration as fallback.');
      setDatabasePool(null);
      dbPool = null;
      return;
    }

    // Preload all sites from database into cache (for fast runtime lookups)
    const preloadedCount = await preloadAllSitesToCache();
    
    // Also load site configurations for route registration
    const dbSites = await getSiteConfigurations(dbPool);
    if (dbSites && Object.keys(dbSites).length > 0) {
      updateSitesConfiguration(dbSites);
      console.log(`✅ Using database-driven site configurations (${Object.keys(dbSites).length} sites, ${preloadedCount} cached)`);
    } else {
      console.log('⚠️  No database configurations found. Using static site configuration.');
    }
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    console.log('⚠️  Falling back to static site configuration.');
    setDatabasePool(null);
    dbPool = null;
  }
}

// Refresh site configurations periodically (every 5 minutes)
let refreshInterval = null;
function startConfigurationRefresh() {
  if (!dbPool) return;

  refreshInterval = setInterval(async () => {
    try {
      console.log('🔄 Refreshing site configurations from database...');
      const dbSites = await refreshSiteConfigurations(dbPool);
      updateSitesConfiguration(dbSites);
      // Also refresh cache
      await preloadAllSitesToCache();
    } catch (error) {
      console.error('❌ Error refreshing configurations:', error.message);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// Manual refresh endpoint
app.get("/refresh-config", async (req, res) => {
  if (!dbPool) {
    return res.status(503).json({ 
      error: "Database not configured",
      message: "Using static configuration. Set DB_HOST to enable database-driven configurations."
    });
  }

  try {
    const dbSites = await refreshSiteConfigurations(dbPool);
    const updated = updateSitesConfiguration(dbSites);
    // Also refresh cache
    const preloadedCount = await preloadAllSitesToCache();
    
    if (updated) {
      res.json({ 
        success: true, 
        message: "Configurations refreshed",
        siteCount: Object.keys(SITES).length,
        cachedSites: preloadedCount
      });
    } else {
      res.json({ 
        success: false, 
        message: "No configurations found in database",
        usingStatic: true
      });
    }
  } catch (error) {
    res.status(500).json({ 
      error: "Refresh failed",
      message: error.message
    });
  }
});

// Request logging
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url} | ${req.ip || 'unknown'}`);
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    architecture: "OpenVPN-based site-to-site routing",
    configurationSource: dbPool ? "database" : "static",
    sites: Object.values(SITES).map(site => ({
      name: site.name,
      vpnIp: site.vpnIp,              // VPN transport IP (10.9.0.x)
      neocore: { 
        enabled: site.neocore?.enabled || false, 
        target: site.neocore?.target 
      },
      devices: { 
        enabled: site.devices?.enabled || false,
        deviceCount: site.devices?.deviceList ? Object.keys(site.devices.deviceList).length : 0,
        deviceList: site.devices?.deviceList ? Object.entries(site.devices.deviceList).map(([id, config]) => ({
          id,
          name: config.name || id,
          virtualIp: config.virtualIp,
          target: config.target
        })) : []
      }
    }))
  });
});

// Backend connectivity test endpoint
app.get("/test-backend/:siteName", async (req, res) => {
  const siteName = req.params.siteName;
  const site = SITES[siteName];
  
  if (!site || !site.neocore?.enabled) {
    return res.status(404).json({ error: "Site not found or not enabled" });
  }
  
  const http = require('http');
  const url = require('url');
  const targetUrl = url.parse(site.neocore.target);
  
  // Test HTTP connectivity
  const testHttp = () => {
    return new Promise((resolve) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: '/api/health',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        resolve({ success: true, statusCode: res.statusCode });
      });
      
      req.on('error', (err) => {
        resolve({ success: false, error: err.message, code: err.code });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      });
      
      req.end();
    });
  };
  
  // Test WebSocket endpoint (socket.io polling)
  const testSocketIO = () => {
    return new Promise((resolve) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: '/socket.io/?EIO=4&transport=polling',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        resolve({ success: true, statusCode: res.statusCode });
      });
      
      req.on('error', (err) => {
        resolve({ success: false, error: err.message, code: err.code });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      });
      
      req.end();
    });
  };
  
  const [httpTest, socketIOTest] = await Promise.all([testHttp(), testSocketIO()]);
  
  res.json({
    site: siteName,
    target: site.neocore.target,
    vpnIp: site.vpnIp,
    tests: {
      http: httpTest,
      socketIO: socketIOTest
    },
    status: httpTest.success && socketIOTest.success ? 'healthy' : 'unhealthy'
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log("🛑 Shutting down gracefully...");
  
  // Stop configuration refresh
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  
  // Close database pool
  if (dbPool) {
    await dbPool.end();
    console.log("✅ Database connection closed");
  }
  
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Initialize
async function startServer() {
  const PORT = process.env.PORT || 3003;
  const HOST = process.env.HOST || "0.0.0.0";

  // Initialize database and load configurations
  await initializeDatabase();

  // Register routes with current site configurations
  // Pass a getter function so routes always use current SITES
  registerAllRoutes(app, () => SITES, server);
  
  // Register test routes for validation and testing
  registerTestRoutes(app, () => SITES, dbPool);
  
  // Store reference for route updates
  routeManager = { updateSites: (newSites) => { SITES = newSites; } };

  // Start configuration refresh if database is available
  if (dbPool) {
    startConfigurationRefresh();
  }

  server.listen(PORT, HOST, () => {
    console.log(`\n✅ VPN Proxy Service → http://${HOST}:${PORT}\n`);
    console.log(`   📡 Architecture: OpenVPN-based site-to-site routing (SRS compliant)`);
    console.log(`   📊 Configuration: ${dbPool ? 'Database-driven' : 'Static file'}\n`);
    
    Object.values(SITES).forEach(s => {
      if (s.neocore?.enabled) {
        console.log(`   🌐 /vpn/${s.name}/neocore → ${s.neocore.target} (VPN IP: ${s.vpnIp})`);
      }
      if (s.devices?.enabled && s.devices.deviceList) {
        const deviceCount = Object.keys(s.devices.deviceList).length;
        console.log(`   🔧 /vpn/${s.name}/devices/* → ${deviceCount} device(s) configured`);
        Object.entries(s.devices.deviceList).forEach(([deviceId, deviceConfig]) => {
          console.log(`      └─ /vpn/${s.name}/devices/${deviceId} → ${deviceConfig.target} (${deviceConfig.name || deviceId})`);
        });
      }
    });
    console.log(`   ❤️  /health`);
    console.log(`   🔄 /refresh-config (manual refresh)\n`);
  });
}

// Start the server
startServer().catch((error) => {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
