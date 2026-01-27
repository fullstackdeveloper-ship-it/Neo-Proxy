/**
 * Route Manager
 * Registers routes for all sites and services
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createDevicesProxy } = require("./proxyFactory");
const { createSession, getSiteFromSession } = require("./sessionManager");
const { serveAsset, serveHTML } = require("./assetsService");

/**
 * Register session, HTML, assets, and API routes
 */
function registerSessionRoutes(app, allSites) {
  // Serve HTML from build directory for neocore routes
  app.get('/vpn/:siteName/neocore', (req, res) => {
    const siteName = req.params.siteName;
    const site = allSites[siteName];
    
    if (!site || !site.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    // Create/validate session
    let sessionId = req.cookies?.['vpn-session-id'];
    if (!sessionId || getSiteFromSession(sessionId) !== siteName) {
      sessionId = createSession(siteName);
    }
    
    // Set session cookie
    res.cookie('vpn-session-id', sessionId, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax'
    });
    
    // Serve HTML from build directory
    serveHTML(req, res, siteName);
  });
  
  // Assets serving endpoint - handle main.js and main.css
  app.get(/^\/(main\.[^\/]+\.(js|css))$/, (req, res) => {
    const sessionId = req.cookies?.['vpn-session-id'] || req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(401).json({ 
        error: 'Session required',
        message: 'Please access through /vpn/{site}/neocore first to create a session'
      });
    }
    
    serveAsset(req, res, sessionId);
  });
  
  // Serve static assets (images, icons, etc.) from build directory
  app.get('/vpn/:siteName/neocore/:assetFile', (req, res) => {
    const siteName = req.params.siteName;
    const assetFile = req.params.assetFile;
    const site = allSites[siteName];
    
    if (!site || !site.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    // Check if it's an asset file (not API)
    if (assetFile.startsWith('api')) {
      return res.status(404).json({ error: 'Use /vpn/{site}/neocore/api/* for API calls' });
    }
    
    const fs = require('fs');
    const path = require('path');
    const assetPath = path.join(__dirname, '../build', assetFile);
    
    if (fs.existsSync(assetPath)) {
      res.sendFile(assetPath);
    } else {
      res.status(404).json({ error: 'Asset not found' });
    }
  });
  
  // API proxy routes - proxy API calls to neocore backend
  Object.values(allSites).forEach(site => {
    if (site.neocore && site.neocore.enabled) {
      const apiProxy = createProxyMiddleware({
        target: site.neocore.target,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        secure: false,
        timeout: 30000,
        proxyTimeout: 30000,
        pathRewrite: {
          [`^/vpn/${site.name}/neocore/api`]: '/api'
        },
        wsErrorHandler: (err, req, socket, head) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error(`⚠️  WebSocket error (${site.name}):`, err.message);
          }
        },
        onError: (err, req, res) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error(`❌ API proxy error (${site.name}):`, err.message);
          }
          if (!res.headersSent && !res.writableEnded) {
            try {
              res.status(502).json({ error: "Backend error", message: err.message });
            } catch (e) {}
          }
        }
      });
      
      app.use(`/vpn/${site.name}/neocore/api`, apiProxy);
      console.log(`✅ Registered API proxy: /vpn/${site.name}/neocore/api → ${site.neocore.target}/api`);
    }
  });
  
  console.log(`✅ Registered session, HTML, assets, and API routes`);
}

/**
 * Register routes for a single site
 */
function registerSiteRoutes(app, site, allSites) {
  const sitePrefix = `/vpn/${site.name}`;
  
  // Register devices route
  if (site.devices && site.devices.enabled) {
    const devicesMiddlewares = createDevicesProxy(site);
    if (devicesMiddlewares) {
      app.use(`${sitePrefix}/devices`, ...devicesMiddlewares);
      console.log(`✅ Registered: ${sitePrefix}/devices → ${site.devices.target} (SOCKS:${site.devices.socksPort})`);
    }
  }
}


/**
 * Register all routes for all sites
 */
function registerAllRoutes(app, sites) {
  // Register session routes first (before site routes)
  registerSessionRoutes(app, sites);
  
  // Register site-specific routes
  Object.values(sites).forEach(site => {
    registerSiteRoutes(app, site, sites);
  });
}

module.exports = {
  registerSiteRoutes,
  registerAllRoutes
};
