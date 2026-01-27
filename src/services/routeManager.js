/**
 * Route Manager - Registers routes for all sites and services
 * Perfect implementation for site-specific socket.io connections
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { createDevicesProxy } = require("./proxyFactory");
const { serveAsset, serveHTML } = require("./assetsService");
const fs = require('fs');
const path = require('path');

/**
 * Detect site from URL, referer header, or cookies
 */
function detectSite(req, allSites) {
  // Try URL path first (most reliable)
  const urlMatch = req.url.match(/^\/vpn\/([^\/]+)\//);
  if (urlMatch) {
    return allSites[urlMatch[1]];
  }
  
  // Try referer header (full URL with path) - works for HTTP requests
  const referer = req.headers.referer || '';
  const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
  if (refererMatch) {
    return allSites[refererMatch[1]];
  }
  
  // Try origin header (might have path in some cases)
  const origin = req.headers.origin || '';
  const originMatch = origin.match(/\/vpn\/([^\/]+)\//);
  if (originMatch) {
    return allSites[originMatch[1]];
  }
  
  // Try cookie (if session-based approach was used)
  if (req.headers.cookie) {
    const cookieMatch = req.headers.cookie.match(/vpn-site=([^;]+)/);
    if (cookieMatch) {
      return allSites[cookieMatch[1]];
    }
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
    ws: true, // Enable WebSocket support
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    pathRewrite,
    logLevel: 'warn', // Reduce noise
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
    },
    onProxyReq: (proxyReq, req, res) => {
      // Log proxy requests for debugging
      if (process.env.DEBUG) {
        console.log(`   → Proxying ${req.method} ${req.url} to ${target}`);
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
  // Create socket.io proxies for each site FIRST (before other routes)
  const socketProxies = new Map();
  const apiProxies = new Map();
  
  Object.values(allSites).forEach(site => {
    if (site.neocore?.enabled) {
      // Socket.io proxy - site-specific
      const socketProxy = createProxy(
        site.neocore.target,
        { [`^/vpn/${site.name}/neocore/socket.io`]: '/socket.io' },
        site.name
      );
      socketProxies.set(site.name, socketProxy);
      
      // API proxy - site-specific
      const apiProxy = createProxy(
        site.neocore.target,
        { [`^/vpn/${site.name}/neocore/api`]: '/api' },
        site.name
      );
      apiProxies.set(site.name, apiProxy);
      
      console.log(`✅ Registered proxies for ${site.name}:`);
      console.log(`   🔌 /vpn/${site.name}/neocore/socket.io → ${site.neocore.target}/socket.io`);
      console.log(`   🌐 /vpn/${site.name}/neocore/api → ${site.neocore.target}/api`);
    }
  });

  // URL rewrite interceptors (for HTTP requests - socket.io polling, API calls)
  app.use((req, res, next) => {
    // Only intercept socket.io and API requests without site prefix
    if ((req.url.startsWith('/socket.io') || req.url.startsWith('/api')) && !req.url.startsWith('/vpn/')) {
      const site = detectSite(req, allSites);
      if (site?.neocore?.enabled) {
        const prefix = `/vpn/${site.name}/neocore`;
        if (req.url.startsWith('/socket.io')) {
          req.url = `${prefix}/socket.io${req.url.substring(11)}`;
          console.log(`🔄 Socket.io rewrite: ${req.url} → ${site.name} (from ${req.headers.referer || 'direct'})`);
        } else if (req.url.startsWith('/api')) {
          req.url = `${prefix}/api${req.url.substring(4)}`;
          console.log(`🔄 API rewrite: ${req.url} → ${site.name} (from ${req.headers.referer || 'direct'})`);
        }
      } else {
        console.warn(`⚠️  Could not detect site for ${req.url} (referer: ${req.headers.referer || 'none'})`);
      }
    }
    next();
  });

  // Register site-specific socket.io routes (MUST be before root-level route)
  Object.values(allSites).forEach(site => {
    if (site.neocore?.enabled) {
      app.use(`/vpn/${site.name}/neocore/socket.io`, socketProxies.get(site.name));
      app.use(`/vpn/${site.name}/neocore/api`, apiProxies.get(site.name));
    }
  });

  // Root-level socket.io route (fallback - handles /socket.io/ requests)
  app.use('/socket.io', (req, res, next) => {
    const site = detectSite(req, allSites);
    if (site?.neocore?.enabled) {
      // Rewrite to site-prefixed path and use the site's proxy
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      req.url = `/vpn/${site.name}/neocore/socket.io${queryString}`;
      console.log(`🔄 Root socket.io rewrite: ${req.url} → ${site.name}`);
      const proxy = socketProxies.get(site.name);
      if (proxy) {
        return proxy(req, res, next);
      }
    }
    // Fallback to first site (not ideal, but better than failing)
    const firstSite = Object.values(allSites).find(s => s.neocore?.enabled);
    if (firstSite) {
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      req.url = `/vpn/${firstSite.name}/neocore/socket.io${queryString}`;
      console.log(`🔄 Root socket.io rewrite (fallback): ${req.url} → ${firstSite.name}`);
      const proxy = socketProxies.get(firstSite.name);
      if (proxy) {
        return proxy(req, res, next);
      }
    }
    res.status(404).json({ error: 'Socket.io endpoint not found - no site detected' });
  });

  // WebSocket upgrade handler - Rewrite URLs, let middleware handle the upgrade
  // http-proxy-middleware with ws:true automatically handles upgrades for registered routes
  // We just rewrite /socket.io/ to /vpn/{site}/neocore/socket.io/ and let middleware handle it
  if (server && socketProxies.size > 0) {
    // Add upgrade listener that runs FIRST (before middleware handlers)
    // Use prependListener to ensure it runs before middleware's handlers
    server.prependListener('upgrade', (req, socket, head) => {
      let url = req.url || '';
      
      // Only rewrite socket.io URLs without site prefix
      if (url.startsWith('/socket.io') && !url.startsWith('/vpn/')) {
        const origin = req.headers.origin || '';
        const referer = req.headers.referer || '';
        
        console.log(`🔌 WebSocket upgrade: ${url}`);
        console.log(`   Origin: ${origin}, Referer: ${referer}`);
        
        // Detect site
        const site = detectSite(req, allSites);
        let targetSite = site;
        
        if (!targetSite?.neocore?.enabled) {
          // Try referer
          if (referer) {
            const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
            if (refererMatch) {
              targetSite = allSites[refererMatch[1]];
            }
          }
          
          // Fallback to first site
          if (!targetSite?.neocore?.enabled) {
            targetSite = Object.values(allSites).find(s => s.neocore?.enabled);
            if (targetSite) {
              console.log(`   ⚠️  Using fallback: ${targetSite.name}`);
            }
          }
        }
        
        if (targetSite?.neocore?.enabled) {
          // Rewrite URL - middleware will handle the upgrade automatically
          const queryString = url.includes('?') ? url.substring(url.indexOf('?')) : '';
          url = `/vpn/${targetSite.name}/neocore/socket.io${queryString}`;
          req.url = url;
          console.log(`   ✅ Rewritten to: ${url} → ${targetSite.name}`);
        } else {
          console.error(`   ❌ No site detected, closing connection`);
          socket.destroy();
        }
      }
      // Let the request continue - middleware will handle the upgrade for matching routes
    });
    
    console.log(`✅ WebSocket URL rewrite handler registered (middleware will handle upgrades)`);
  }

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

  // Catch-all for React Router (MUST be last)
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
