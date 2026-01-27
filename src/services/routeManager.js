/**
 * Route Manager
 * Registers routes for all sites and services
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createNeocoreProxy, createDevicesProxy } = require("./proxyFactory");

/**
 * Register routes for a single site
 */
function registerSiteRoutes(app, site) {
  const sitePrefix = `/vpn/${site.name}`;
  
  // Register neocore route
  if (site.neocore && site.neocore.enabled) {
    const neocoreProxy = createNeocoreProxy(site);
    if (neocoreProxy) {
      app.use(`${sitePrefix}/neocore`, neocoreProxy);
      console.log(`✅ Registered: ${sitePrefix}/neocore → ${site.neocore.target}`);
      
      // Direct routes for React app compatibility
      registerDirectRoutes(app, site);
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
 * These routes work within the /vpn/{site}/neocore context
 * Note: Direct /api/* and /static/* are handled by the main neocore proxy
 */
function registerDirectRoutes(app, site) {
  if (!site.neocore || !site.neocore.enabled) return;
  
  // Direct routes are already handled by the main neocore proxy
  // The proxy's pathRewrite removes /vpn/{site}/neocore prefix
  // So /vpn/{site}/neocore/api/* becomes /api/* on target
  // And /vpn/{site}/neocore/static/* becomes /static/* on target
  
  // Additional direct proxy for root-level assets accessed via neocore context
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
  
  // Register site-specific direct routes (optional - for backward compatibility)
  // These allow accessing assets directly with site prefix
  const sitePrefix = `/vpn/${site.name}/neocore`;
  
  // These routes are already covered by the main neocore proxy
  // But we can add explicit routes if needed for specific cases
  console.log(`✅ Direct routes available for ${site.name} via ${sitePrefix}/*`);
}

/**
 * Register all routes for all sites
 */
function registerAllRoutes(app, sites) {
  Object.values(sites).forEach(site => {
    registerSiteRoutes(app, site);
  });
}

module.exports = {
  registerSiteRoutes,
  registerAllRoutes
};
