/**
 * Route Manager
 * Registers routes for all sites and services
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createDevicesProxy } = require("./proxyFactory");
const { serveAsset, serveHTML } = require("./assetsService");

/**
 * Register HTML, assets, and API routes
 */
function registerNeocoreRoutes(app, allSites) {
  // API interceptor - detects site from URL path (more reliable than referer)
  // This runs for ALL requests, but only rewrites /api/* ones
  app.use((req, res, next) => {
    // Only intercept /api/* requests
    if (req.url.startsWith('/api')) {
      // Method 1: Try to detect from URL path first (most reliable)
      let siteName = null;
      const urlMatch = req.url.match(/^\/vpn\/([^\/]+)\/neocore\/api/);
      if (urlMatch) {
        siteName = urlMatch[1];
      } else {
        // Method 2: Fallback to referer header
        const referer = req.headers.referer || req.headers.origin || '';
        const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
        if (refererMatch) {
          siteName = refererMatch[1];
        }
      }
      
      if (siteName) {
        const site = allSites[siteName];
        if (site && site.neocore?.enabled) {
          // If URL already has site prefix, keep it; otherwise add it
          if (!req.url.startsWith(`/vpn/${siteName}/neocore/api`)) {
            req.url = `/vpn/${siteName}/neocore/api${req.url.substring(4)}`; // Remove '/api' prefix
            console.log(`🔄 API rewrite: ${req.originalUrl} → ${req.url} (site: ${siteName})`);
          }
        }
      }
    }
    
    next(); // Continue to next middleware/route
  });
  
  // Serve HTML from build directory for neocore routes (root and all sub-routes)
  app.get('/vpn/:siteName/neocore', (req, res) => {
    const siteName = req.params.siteName;
    const site = allSites[siteName];
    
    if (!site || !site.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    // Serve HTML with base tag injection
    serveHTML(req, res, siteName);
  });
  
  // Catch-all route for React Router client-side navigation
  // This handles routes like /vpn/site1/neocore/overview, /vpn/site1/neocore/logs, etc.
  app.get('/vpn/:siteName/neocore/*', (req, res) => {
    const siteName = req.params.siteName;
    const site = allSites[siteName];
    
    if (!site || !site.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    // Serve HTML with base tag injection (React Router will handle the routing)
    serveHTML(req, res, siteName);
  });
  
  // Assets serving endpoint - serve files as-is (no rewriting)
  app.get(/^\/(main\.[^\/]+\.(js|css))$/, (req, res) => {
    serveAsset(req, res);
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
  
  console.log(`✅ Registered HTML, assets, and API routes`);
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
  // Register neocore routes first (HTML, assets, API)
  registerNeocoreRoutes(app, sites);
  
  // Register site-specific routes (devices)
  Object.values(sites).forEach(site => {
    registerSiteRoutes(app, site, sites);
  });
}

module.exports = {
  registerSiteRoutes,
  registerAllRoutes
};
