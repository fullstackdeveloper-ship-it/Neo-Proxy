/**
 * Route Manager
 * Registers routes for all sites and services
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createNeocoreProxy, createDevicesProxy } = require("./proxyFactory");

/**
 * Register routes for a single site
 */
function registerSiteRoutes(app, site, allSites) {
  const sitePrefix = `/vpn/${site.name}`;
  
  // Register neocore route
  if (site.neocore && site.neocore.enabled) {
    const neocoreProxy = createNeocoreProxy(site);
    if (neocoreProxy) {
      app.use(`${sitePrefix}/neocore`, neocoreProxy);
      console.log(`✅ Registered: ${sitePrefix}/neocore → ${site.neocore.target}`);
      
      // Direct routes for React app compatibility
      registerDirectRoutes(app, site, allSites);
    }
  }
  
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
 * Request tracking for direct routes
 */
function trackDirectRequest(site, req, path) {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  console.log(`📥 [${timestamp}] ${method} ${path} | Direct Route | Site: ${site.name} | VPN IP: ${site.vpnIp} | Client: ${ip}`);
}

// Cache for root-level proxy instances (one per site)
const rootProxyCache = new Map();

/**
 * Create or get cached proxy instance for a site
 */
function getRootProxyForSite(site) {
  if (!rootProxyCache.has(site.name)) {
    const proxy = createProxyMiddleware({
      target: site.neocore.target,
      changeOrigin: true,
      ws: true,
      xfwd: true,
      secure: false,
      timeout: 30000,
      proxyTimeout: 30000,
      // Suppress WebSocket ECONNRESET errors (normal when clients disconnect)
      wsErrorHandler: (err, req, socket, head) => {
        // Only log non-ECONNRESET errors
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error(`⚠️  WebSocket error (${site.name}):`, err.message);
        }
      },
      onProxyReq: (proxyReq, req, res) => {
        if (process.env.DEBUG) {
          console.log(`   → Root route → ${site.neocore.target}`);
          console.log(`   → VPN IP: ${site.vpnIp}`);
        }
      },
      onError: (err, req, res) => {
        // Suppress ECONNRESET errors (normal client disconnects)
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error(`❌ Root proxy error (${site.name}):`, err.message);
        }
        if (!res.headersSent && !res.writableEnded) {
          try {
            res.status(502).json({ 
              error: "Proxy error", 
              message: err.message,
              site: site.name
            });
          } catch (e) {}
        }
      }
    });
    rootProxyCache.set(site.name, proxy);
  }
  return rootProxyCache.get(site.name);
}

/**
 * Register direct routes for neocore (React app compatibility)
 * These handle requests like /static/js/main.js when React app makes direct calls
 */
function registerDirectRoutes(app, site, allSites) {
  if (!site.neocore || !site.neocore.enabled) return;
  
  const directProxy = createProxyMiddleware({
    target: site.neocore.target,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    // Suppress WebSocket ECONNRESET errors
    wsErrorHandler: (err, req, socket, head) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error(`⚠️  WebSocket error (${site.name}):`, err.message);
      }
    },
    onProxyReq: (proxyReq, req, res) => {
      trackDirectRequest(site, req, req.url);
      if (process.env.DEBUG) {
        console.log(`   → Direct route to: ${site.neocore.target}`);
        console.log(`   → VPN IP: ${site.vpnIp}`);
      }
    },
    onError: (err, req, res) => {
      // Suppress ECONNRESET errors
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error(`❌ Direct proxy error (${site.name}):`, err.message);
        console.error(`   Target: ${site.neocore.target}`);
        console.error(`   VPN IP: ${site.vpnIp}`);
      }
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({ 
            error: "Proxy error", 
            message: err.message,
            site: site.name,
            target: site.neocore.target,
            vpnIp: site.vpnIp
          });
        } catch (e) {}
      }
    }
  });
  
  // Site-specific direct routes (always register these - no conflicts)
  app.use(`/static/${site.name}`, (req, res, next) => {
    trackDirectRequest(site, req, `/static/${site.name}${req.url}`);
    directProxy(req, res, next);
  });
  
  app.use(`/api/${site.name}`, (req, res, next) => {
    trackDirectRequest(site, req, `/api/${site.name}${req.url}`);
    directProxy(req, res, next);
  });
  
  // Root-level routes with proper multi-site detection
  // Create root proxy handler that reuses cached proxy instances
  const createRootProxy = () => {
    return (req, res, next) => {
      const referer = req.headers.referer || req.headers.origin || '';
      const siteMatch = referer.match(/\/vpn\/([^\/]+)\//);
      
      if (siteMatch) {
        const detectedSiteName = siteMatch[1];
        const detectedSite = allSites[detectedSiteName];
        
        if (detectedSite && detectedSite.neocore && detectedSite.neocore.enabled) {
          trackDirectRequest(detectedSite, req, `Root route (detected: ${detectedSiteName})`);
          // Reuse cached proxy instance
          const siteProxy = getRootProxyForSite(detectedSite);
          return siteProxy(req, res, next);
        }
      }
      
      // If no referer, try first enabled site as fallback
      const firstEnabledSite = Object.values(allSites).find(s => s.neocore?.enabled);
      if (firstEnabledSite) {
        trackDirectRequest(firstEnabledSite, req, `Root route (fallback: ${firstEnabledSite.name})`);
        // Reuse cached proxy instance
        const fallbackProxy = getRootProxyForSite(firstEnabledSite);
        return fallbackProxy(req, res, next);
      }
      
      next();
    };
  };
  
  // Register root routes only once (for first site to avoid conflicts)
  const sitesArray = Object.values(allSites);
  const isFirstSite = sitesArray[0] && sitesArray[0].name === site.name;
  
  if (isFirstSite) {
    const rootProxy = createRootProxy();
    app.use('/static', rootProxy);
    app.use('/api', rootProxy);
    app.use(/^\/([^\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf|css|js))$/, rootProxy);
    console.log(`✅ Registered root-level routes with multi-site detection`);
  }
  
  console.log(`✅ Registered direct routes for ${site.name}: /static/${site.name}/*, /api/${site.name}/*`);
}

/**
 * Register all routes for all sites
 */
function registerAllRoutes(app, sites) {
  Object.values(sites).forEach(site => {
    registerSiteRoutes(app, site, sites);
  });
}

module.exports = {
  registerSiteRoutes,
  registerAllRoutes
};
