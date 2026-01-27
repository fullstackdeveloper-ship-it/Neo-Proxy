/**
 * Route Manager - Registers routes for all sites and services
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createDevicesProxy } = require("./proxyFactory");
const { serveAsset, serveHTML } = require("./assetsService");
const fs = require('fs');
const path = require('path');

/**
 * Detect site from URL or referer header
 */
function detectSite(req, allSites) {
  // Try URL path first
  const urlMatch = req.url.match(/^\/vpn\/([^\/]+)\//);
  if (urlMatch) {
    return allSites[urlMatch[1]];
  }
  
  // Fallback to referer
  const referer = req.headers.referer || req.headers.origin || '';
  const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
  if (refererMatch) {
    return allSites[refererMatch[1]];
  }
  
  return null;
}

/**
 * Create proxy middleware with common configuration
 */
function createProxy(target, pathRewrite, siteName) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true, // Enable WebSocket support - middleware handles upgrades automatically
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    pathRewrite,
    wsErrorHandler: (err, req, socket) => {
      // Suppress common WebSocket errors (normal disconnects)
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ECONNREFUSED') {
        console.error(`⚠️  WebSocket error (${siteName}):`, err.message);
      }
    },
    onError: (err, req, res) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && !res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({ error: "Proxy error", message: err.message });
        } catch (e) {}
      }
    }
  });
}

/**
 * Serve static asset file
 */
function serveStaticFile(filePath, res, contentType) {
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
    return true;
  }
  return false;
}

/**
 * Register Neocore routes (HTML, assets, API, Socket.io)
 */
function registerNeocoreRoutes(app, allSites, server) {
  // URL rewrite interceptors
  app.use((req, res, next) => {
    if (req.url.startsWith('/socket.io') || req.url.startsWith('/api')) {
      const site = detectSite(req, allSites);
      if (site?.neocore?.enabled) {
        const prefix = `/vpn/${site.name}/neocore`;
        if (req.url.startsWith('/socket.io') && !req.url.startsWith(prefix)) {
          req.url = `${prefix}/socket.io${req.url.substring(11)}`;
        } else if (req.url.startsWith('/api') && !req.url.startsWith(prefix)) {
          req.url = `${prefix}/api${req.url.substring(4)}`;
        }
      }
    }
    next();
  });

  // HTML route
  app.get('/vpn/:siteName/neocore', (req, res) => {
    const site = allSites[req.params.siteName];
    if (!site?.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    serveHTML(req, res, req.params.siteName);
  });

  // Root-level assets
  app.get(/^\/(main\.[^\/]+\.(js|css))$/, serveAsset);
  app.get('/static/:type/:fileName', (req, res) => {
    const assetPath = path.join(__dirname, '../build/static', req.params.type, req.params.fileName);
    const contentType = req.params.type === 'js' ? 'application/javascript' : 'text/css';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // Site-prefixed static assets
  app.get('/vpn/:siteName/neocore/static/:type/:fileName', (req, res) => {
    const site = allSites[req.params.siteName];
    if (!site?.neocore?.enabled) {
      return res.status(404).json({ error: 'Site not found' });
    }
    const assetPath = path.join(__dirname, '../build/static', req.params.type, req.params.fileName);
    const contentType = req.params.type === 'js' ? 'application/javascript' : 'text/css';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // Root-level images/icons
  app.get('/vpn/:siteName/neocore/:assetFile', (req, res) => {
    const site = allSites[req.params.siteName];
    if (!site?.neocore?.enabled || req.params.assetFile.startsWith('api') || req.params.assetFile === 'static') {
      return res.status(404).json({ error: 'Not found' });
    }
    const assetPath = path.join(__dirname, '../build', req.params.assetFile);
    const ext = path.extname(req.params.assetFile).toLowerCase();
    const contentTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // Socket.io and API proxies
  const socketProxies = new Map();
  
  Object.values(allSites).forEach(site => {
    if (site.neocore?.enabled) {
      // Socket.io proxy
      const socketProxy = createProxy(
        site.neocore.target,
        { [`^/vpn/${site.name}/neocore/socket.io`]: '/socket.io' },
        site.name
      );
      socketProxies.set(site.name, socketProxy);
      app.use(`/vpn/${site.name}/neocore/socket.io`, socketProxy);

      // API proxy
      const apiProxy = createProxy(
        site.neocore.target,
        { [`^/vpn/${site.name}/neocore/api`]: '/api' },
        site.name
      );
      app.use(`/vpn/${site.name}/neocore/api`, apiProxy);
    }
  });

  // WebSocket upgrade handler - route upgrades to correct proxy
  if (server && socketProxies.size > 0) {
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      for (const [siteName, proxy] of socketProxies.entries()) {
        if (url.startsWith(`/vpn/${siteName}/neocore/socket.io`)) {
          proxy.upgrade(req, socket, head);
          return;
        }
      }
      // No match - close connection
      socket.destroy();
    });
  }

  // Catch-all for React Router
  app.get('/vpn/:siteName/neocore/*', (req, res) => {
    const site = allSites[req.params.siteName];
    if (!site?.neocore?.enabled || req.url.includes('/api') || req.url.includes('/socket.io')) {
      return res.status(404).json({ error: 'Not found' });
    }
    serveHTML(req, res, req.params.siteName);
  });
}

/**
 * Register device routes for a site
 */
function registerSiteRoutes(app, site, allSites) {
  if (site.devices?.enabled) {
    const middlewares = createDevicesProxy(site);
    if (middlewares) {
      app.use(`/vpn/${site.name}/devices`, ...middlewares);
    }
  }
}

/**
 * Register all routes
 */
function registerAllRoutes(app, sites, server) {
  registerNeocoreRoutes(app, sites, server);
  Object.values(sites).forEach(site => registerSiteRoutes(app, site, sites));
}

module.exports = { registerAllRoutes };
