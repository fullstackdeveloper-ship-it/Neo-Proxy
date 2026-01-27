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
    onError: (err, req, res) => {
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({ error: "Proxy error", message: err.message });
        } catch (e) {}
      }
    }
  });
  
  // Site-specific direct routes (recommended approach)
  app.use(`/static/${site.name}`, directProxy);
  app.use(`/api/${site.name}`, directProxy);
  
  // Root-level routes with site detection from referer
  // This handles when React app makes direct /static/* or /api/* calls
  const rootProxy = (req, res, next) => {
    // Check referer to determine site
    const referer = req.headers.referer || req.headers.origin || '';
    const siteMatch = referer.match(/\/vpn\/([^\/]+)\//);
    
    if (siteMatch) {
      const detectedSiteName = siteMatch[1];
      if (detectedSiteName === site.name) {
        return directProxy(req, res, next);
      }
    }
    
    // If no referer or site doesn't match, try next middleware
    next();
  };
  
  // Register root routes only once (for first site to avoid conflicts)
  // Other sites will use site-specific paths
  const sitesArray = Object.values(allSites);
  const isFirstSite = sitesArray[0] && sitesArray[0].name === site.name;
  
  if (isFirstSite) {
    // Register root-level routes that detect site from referer
    app.use('/static', rootProxy);
    app.use('/api', rootProxy);
    
    // Root assets (images, icons, etc.)
    app.use(/^\/([^\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf|css|js))$/, rootProxy);
    
    console.log(`✅ Registered root-level routes with site detection for ${site.name}`);
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
