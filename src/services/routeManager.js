/**
 * Route Manager - Registers routes for all sites and services
 * Perfect implementation for site-specific socket.io connections
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const httpProxy = require("http-proxy");
const { createDeviceProxy } = require("./proxyFactory");
const { serveAsset, serveHTML } = require("./assetsService");
const { getSiteBySlug } = require("./siteCacheService");
const fs = require('fs');
const path = require('path');

/** Helper: site has at least one neocore */
function hasNeocores(site) {
  return site?.neocores && typeof site.neocores === 'object' && Object.keys(site.neocores).length > 0;
}

/** Get site slug and neocore id from path e.g. /vpn/site1/neocore/0/... */
function getSiteAndNeocoreFromPath(url) {
  const m = url && url.match(/^\/vpn\/([^\/]+)\/neocore\/([^\/]+)(\/|$|\?)/);
  return m ? { siteSlug: m[1], neocoreId: m[2] } : null;
}

/** Get neocore id from cookie */
function getNeocoreIdFromCookie(req) {
  if (!req.headers.cookie) return null;
  const m = req.headers.cookie.match(/vpn-neocore=([^;,\s]+)/);
  return m ? m[1].trim() : null;
}

/** Get neocore id from referer e.g. .../vpn/site1/neocore/0/... */
function getNeocoreIdFromReferer(req) {
  const referer = req.headers.referer || '';
  const m = referer.match(/\/vpn\/([^\/]+)\/neocore\/([^\/]+)(\/|$|\?)/);
  return m ? m[2] : null;
}

/**
 * Detect site from URL, referer header, or cookies
 * Supports runtime database lookup
 */
async function detectSite(req, allSites) {
  let siteSlug = null;

  const pathInfo = getSiteAndNeocoreFromPath(req.url);
  if (pathInfo) siteSlug = pathInfo.siteSlug;
  if (!siteSlug) {
    const referer = req.headers.referer || '';
    const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
    if (refererMatch) siteSlug = refererMatch[1];
  }
  if (!siteSlug) {
    const origin = req.headers.origin || '';
    const originMatch = origin.match(/\/vpn\/([^\/]+)\//);
    if (originMatch) siteSlug = originMatch[1];
  }
  if (!siteSlug && req.headers.cookie) {
    const cookieMatch = req.headers.cookie.match(/vpn-site=([^;]+)/);
    if (cookieMatch) siteSlug = cookieMatch[1].trim();
  }

  if (!siteSlug) return null;

  if (allSites[siteSlug]) return allSites[siteSlug];

  try {
    const siteConfig = await getSiteBySlug(siteSlug);
    return siteConfig || null;
  } catch (error) {
    console.error(`❌ Error looking up site ${siteSlug}:`, error.message);
    return null;
  }
}

/**
 * Synchronous version of detectSite (for use in synchronous contexts)
 * Only checks static sites, not database
 */
function detectSiteSync(req, allSites) {
  const pathInfo = getSiteAndNeocoreFromPath(req.url);
  if (pathInfo) {
    const site = allSites[pathInfo.siteSlug];
    if (site) return site;
  }
  const urlMatch = req.url.match(/^\/vpn\/([^\/]+)\//);
  if (urlMatch) return allSites[urlMatch[1]] || null;
  const referer = req.headers.referer || '';
  const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
  if (refererMatch) return allSites[refererMatch[1]] || null;
  const origin = req.headers.origin || '';
  const originMatch = origin.match(/\/vpn\/([^\/]+)\//);
  if (originMatch) return allSites[originMatch[1]] || null;
  if (req.headers.cookie) {
    const cookieMatch = req.headers.cookie.match(/vpn-site=([^;]+)/);
    if (cookieMatch) return allSites[cookieMatch[1].trim()] || null;
  }
  return null;
}

/**
 * Detect site and neocore id for neocore routes (from path, referer, or cookie)
 * Returns { site, neocoreId } or null
 */
async function detectSiteAndNeocore(req, allSites) {
  const pathInfo = getSiteAndNeocoreFromPath(req.url);
  let siteSlug = pathInfo?.siteSlug;
  let neocoreId = pathInfo?.neocoreId;
  if (!neocoreId) neocoreId = getNeocoreIdFromReferer(req);
  if (!neocoreId) neocoreId = getNeocoreIdFromCookie(req);
  if (!siteSlug) {
    const referer = req.headers.referer || '';
    const m = referer.match(/\/vpn\/([^\/]+)\//);
    if (m) siteSlug = m[1];
  }
  if (!siteSlug && req.headers.cookie) {
    const m = req.headers.cookie.match(/vpn-site=([^;]+)/);
    if (m) siteSlug = m[1].trim();
  }
  if (!siteSlug || !neocoreId) return null;
  let site = allSites[siteSlug];
  if (!site) {
    try { site = await getSiteBySlug(siteSlug); } catch (e) {}
  }
  if (!site || !hasNeocores(site) || !site.neocores[neocoreId]) return null;
  return { site, neocoreId };
}

/**
 * Detect device from referer header
 * Returns: { site, deviceId } or null
 */
/**
 * Detect device from referer header
 * Returns: { site, deviceId } or null
 * Now supports runtime database lookup with caching
 */
async function detectDeviceFromReferer(referer, allSites) {
  if (!referer) return null;
  
  // Match pattern: /vpn/{site}/devices/{deviceId}
  const deviceMatch = referer.match(/\/vpn\/([^\/]+)\/devices\/([^\/\?]+)/);
  if (deviceMatch) {
    const siteSlug = deviceMatch[1];
    const deviceId = deviceMatch[2];
    let site = allSites[siteSlug];
    
    // If not in static config, try database lookup
    if (!site?.devices?.deviceList?.[deviceId]) {
      try {
        site = await getSiteBySlug(siteSlug);
      } catch (error) {
        console.error(`❌ Error looking up site ${siteSlug} for device ${deviceId}:`, error.message);
      }
    }
    
    if (site?.devices?.enabled && site.devices.deviceList?.[deviceId]) {
      return { site, deviceId };
    }
  }
  
  return null;
}

/**
 * Synchronous version of detectDeviceFromReferer (for use in synchronous contexts)
 * Only checks static sites, not database
 */
function detectDeviceFromRefererSync(referer, allSites) {
  if (!referer) return null;
  
  // Match pattern: /vpn/{site}/devices/{deviceId}
  const deviceMatch = referer.match(/\/vpn\/([^\/]+)\/devices\/([^\/\?]+)/);
  if (deviceMatch) {
    const siteName = deviceMatch[1];
    const deviceId = deviceMatch[2];
    const site = allSites[siteName];
    
    if (site?.devices?.enabled && site.devices.deviceList?.[deviceId]) {
      return { site, deviceId };
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
    // IMPORTANT: Do NOT enable ws here.
    // WebSocket upgrades are handled centrally in registerNeocoreRoutes() via server.on('upgrade')
    // to avoid double-handling and "Invalid frame header".
    ws: false,
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    pathRewrite,
    logLevel: 'warn', // Reduce noise
    wsErrorHandler: (err, req, socket) => {
      // Suppress common WebSocket errors (normal disconnects and stream conflicts)
      const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
      if (!suppressErrors.includes(err.code)) {
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
 * URL: /vpn/{site}/neocore/{neocoreId}/... for multiple neocores per site
 */
function registerNeocoreRoutes(app, sitesOrGetter, server) {
  const getCurrentSites = () => {
    if (typeof sitesOrGetter === 'function') return sitesOrGetter();
    return sitesOrGetter;
  };

  const allSites = getCurrentSites();
  const socketProxies = new Map();
  const apiProxies = new Map();

  Object.values(allSites).forEach(site => {
    if (!hasNeocores(site)) return;
    Object.entries(site.neocores).forEach(([neocoreId, neocoreConfig]) => {
      const wsTarget = neocoreConfig.wsTarget || neocoreConfig.target;
      const key = `${site.name}:${neocoreId}`;

      const socketProxy = createProxyMiddleware({
        target: wsTarget,
        changeOrigin: true,
        ws: false,
        xfwd: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0,
        pathRewrite: { [`^/vpn/${site.name}/neocore/${neocoreId}/socket.io`]: '/socket.io' },
        logLevel: 'warn',
        wsErrorHandler: (err, req, socket) => {
          const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
          if (!suppressErrors.includes(err.code)) {
            console.error(`⚠️  WebSocket error (${site.name}/${neocoreId}):`, err.message);
          }
        },
        onError: (err, req, res) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && !res.headersSent && !res.writableEnded) {
            try { res.status(502).json({ error: 'Proxy error', message: err.message }); } catch (e) {}
          }
        },
      });
      socketProxies.set(key, socketProxy);

      const apiProxy = createProxy(
        neocoreConfig.target,
        { [`^/vpn/${site.name}/neocore/${neocoreId}/api`]: '/api' },
        `${site.name}/${neocoreId}`
      );
      apiProxies.set(key, apiProxy);

      console.log(`✅ Registered proxies for ${site.name} neocore ${neocoreId}:`);
      console.log(`   🔌 /vpn/${site.name}/neocore/${neocoreId}/socket.io → ${wsTarget}/socket.io`);
      console.log(`   🌐 /vpn/${site.name}/neocore/${neocoreId}/api → ${neocoreConfig.target}/api`);
    });
  });

  // Root-level API handler (from referer/cookie: site + neocore)
  app.use('/api', async (req, res, next) => {
    const referer = req.headers.referer || '';
    const isNeocoreRequest = referer.includes('/neocore') || req.headers.cookie?.includes('vpn-site');
    if (!isNeocoreRequest) return next();

    const currentSites = getCurrentSites();
    const detected = await detectSiteAndNeocore(req, currentSites);
    if (!detected) {
      return res.status(404).json({ error: 'Site or NeoCore not found' });
    }
    const { site, neocoreId } = detected;
    const key = `${site.name}:${neocoreId}`;
    let apiProxy = apiProxies.get(key);
    if (!apiProxy) {
      const neocoreConfig = site.neocores[neocoreId];
      apiProxy = createProxy(
        neocoreConfig.target,
        { [`^/vpn/${site.name}/neocore/${neocoreId}/api`]: '/api' },
        `${site.name}/${neocoreId}`
      );
      apiProxies.set(key, apiProxy);
    }
    const originalUrl = req.url;
    req.url = `/vpn/${site.name}/neocore/${neocoreId}/api${req.url}`;
    if (process.env.DEBUG) console.log(`🔄 API rewrite: ${originalUrl} → ${req.url}`);
    return apiProxy(req, res, next);
  });

  // Register per-site per-neocore socket.io and api routes (from initial config)
  Object.values(allSites).forEach(site => {
    if (!hasNeocores(site)) return;
    Object.keys(site.neocores).forEach(neocoreId => {
      const key = `${site.name}:${neocoreId}`;
      app.use(`/vpn/${site.name}/neocore/${neocoreId}/socket.io`, socketProxies.get(key));
      app.use(`/vpn/${site.name}/neocore/${neocoreId}/api`, apiProxies.get(key));
    });
  });

  // Dynamic neocore api/socket.io (for DB-loaded sites not in initial config)
  app.use('/vpn/:siteName/neocore/:neocoreId/api', async (req, res, next) => {
    const { siteName, neocoreId } = req.params;
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];
    if (!site?.neocores?.[neocoreId]) {
      try { site = await getSiteBySlug(siteName); } catch (e) {}
    }
    if (!site?.neocores?.[neocoreId]) return next();
    const key = `${site.name}:${neocoreId}`;
    let apiProxy = apiProxies.get(key);
    if (!apiProxy) {
      const nc = site.neocores[neocoreId];
      apiProxy = createProxy(nc.target, { [`^/vpn/${site.name}/neocore/${neocoreId}/api`]: '/api' }, key);
      apiProxies.set(key, apiProxy);
    }
    return apiProxy(req, res, next);
  });
  app.use('/vpn/:siteName/neocore/:neocoreId/socket.io', async (req, res, next) => {
    const { siteName, neocoreId } = req.params;
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];
    if (!site?.neocores?.[neocoreId]) {
      try { site = await getSiteBySlug(siteName); } catch (e) {}
    }
    if (!site?.neocores?.[neocoreId]) return next();
    const key = `${site.name}:${neocoreId}`;
    let socketProxy = socketProxies.get(key);
    if (!socketProxy) {
      const nc = site.neocores[neocoreId];
      const wsTarget = nc.wsTarget || nc.target;
      socketProxy = createProxyMiddleware({
        target: wsTarget,
        changeOrigin: true,
        ws: false,
        xfwd: true,
        secure: false,
        timeout: 0,
        proxyTimeout: 0,
        pathRewrite: { [`^/vpn/${site.name}/neocore/${neocoreId}/socket.io`]: '/socket.io' },
        logLevel: 'warn',
        onError: (err, req, res) => {
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && !res.headersSent && !res.writableEnded) {
            try { res.status(502).json({ error: 'Proxy error', message: err.message }); } catch (e) {}
          }
        },
      });
      socketProxies.set(key, socketProxy);
    }
    return socketProxy(req, res, next);
  });

  // Root-level socket.io (from referer/cookie: site + neocore)
  app.use('/socket.io', async (req, res, next) => {
    const currentSites = getCurrentSites();
    const detected = await detectSiteAndNeocore(req, currentSites);
    if (detected) {
      const { site, neocoreId } = detected;
      const key = `${site.name}:${neocoreId}`;
      req.url = `/vpn/${site.name}/neocore/${neocoreId}/socket.io${req.url}`;
      const proxy = socketProxies.get(key);
      if (proxy) return proxy(req, res, next);
    }
    const firstSite = Object.values(currentSites).find(s => hasNeocores(s));
    const firstNeocoreId = firstSite && Object.keys(firstSite.neocores)[0];
    if (firstSite && firstNeocoreId) {
      req.url = `/vpn/${firstSite.name}/neocore/${firstNeocoreId}/socket.io${req.url}`;
      const proxy = socketProxies.get(`${firstSite.name}:${firstNeocoreId}`);
      if (proxy) return proxy(req, res, next);
    }
    res.status(404).json({ error: 'Socket.io endpoint not found - no site/neocore detected' });
  });

  // WebSocket upgrade handler - per-site per-neocore (key = site:neocoreId)
  if (server && socketProxies.size > 0) {
    const wsProxies = new Map();
    Object.values(allSites).forEach(site => {
      if (!hasNeocores(site)) return;
      Object.entries(site.neocores).forEach(([neocoreId, neocoreConfig]) => {
        const wsTarget = neocoreConfig.wsTarget || neocoreConfig.target;
        const key = `${site.name}:${neocoreId}`;
        const proxy = httpProxy.createProxyServer({
          target: wsTarget,
          ws: true,
          changeOrigin: true,
          secure: false,
          timeout: 0,
          proxyTimeout: 0,
          xfwd: true,
          buffer: false,
        });
        proxy.on('error', (err, req, socket) => {
          const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
          if (!suppressErrors.includes(err.code)) {
            console.error(`   ❌ WebSocket proxy error (${site.name}/${neocoreId}):`, err.message);
          }
          if (socket && !socket.destroyed) try { socket.destroy(); } catch (e) {}
        });
        proxy.on('proxyReqWs', (proxyReq, req, socket) => {
          const targetUrl = new URL(wsTarget);
          const port = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
          const hostHeader = (port === '80' || port === '443') ? targetUrl.hostname : `${targetUrl.hostname}:${port}`;
          proxyReq.setHeader('Host', hostHeader);
          proxyReq.setHeader('X-Forwarded-Proto', targetUrl.protocol === 'https:' ? 'wss' : 'ws');
          proxyReq.setHeader('X-Forwarded-For', req.socket.remoteAddress || req.headers['x-forwarded-for'] || '');
          proxyReq.setHeader('X-Real-IP', req.socket.remoteAddress || '');
          if (req.headers.origin) proxyReq.setHeader('Origin', req.headers.origin);
          if (req.headers.cookie) proxyReq.setHeader('Cookie', req.headers.cookie);
          proxyReq.setHeader('Connection', 'Upgrade');
          proxyReq.setHeader('Upgrade', 'websocket');
        });
        proxy.on('open', (proxySocket) => {
          proxySocket.resume();
          proxySocket.on('error', (err) => {
            if (!['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(err.code)) {
              console.error(`   ❌ Proxy socket error (${site.name}/${neocoreId}):`, err.message);
            }
          });
        });
        wsProxies.set(key, proxy);
      });
    });

    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      if (!url.includes('/socket.io')) return;

      const currentSites = getCurrentSites();
      let targetSite = null;
      let targetNeocoreId = null;

      const pathInfo = getSiteAndNeocoreFromPath(url);
      if (pathInfo) {
        targetSite = currentSites[pathInfo.siteSlug];
        targetNeocoreId = pathInfo.neocoreId;
      }
      if (!targetSite || !targetNeocoreId) {
        const cookieHeader = req.headers.cookie || '';
        const siteMatch = cookieHeader.match(/vpn-site=([^;,\s]+)/);
        const neocoreMatch = cookieHeader.match(/vpn-neocore=([^;,\s]+)/);
        if (siteMatch) targetSite = currentSites[siteMatch[1].trim()];
        if (neocoreMatch) targetNeocoreId = neocoreMatch[1].trim();
      }
      if (!targetSite) targetSite = detectSiteSync(req, currentSites);
      if (targetSite && !targetNeocoreId) targetNeocoreId = Object.keys(targetSite.neocores || {})[0];
      if (!targetSite && currentSites) {
        targetSite = Object.values(currentSites).find(s => hasNeocores(s));
        if (targetSite) targetNeocoreId = Object.keys(targetSite.neocores)[0];
      }

      if (!targetSite || !hasNeocores(targetSite) || !targetNeocoreId || !targetSite.neocores[targetNeocoreId]) {
        console.error('   ❌ No site/neocore detected for WebSocket, closing');
        socket.destroy();
        return;
      }

      if (pathInfo && url.startsWith(`/vpn/${targetSite.name}/neocore/${targetNeocoreId}`)) {
        req.url = url.replace(new RegExp(`^/vpn/${targetSite.name}/neocore/${targetNeocoreId}`), '');
      }

      const key = `${targetSite.name}:${targetNeocoreId}`;
      const proxy = wsProxies.get(key);
      if (!proxy) {
        console.error(`   ❌ wsProxy not found for ${key}`);
        socket.destroy();
        return;
      }

      try {
        proxy.ws(req, socket, head);
      } catch (err) {
        console.error(`   ❌ wsProxy.ws failed (${key}): ${err.message}`);
        if (!socket.destroyed) socket.destroy();
      }
    });

    console.log('✅ WebSocket upgrade handler registered (per-site per-neocore)');
  }

  // HTML route: /vpn/:siteName/neocore/:neocoreId (multiple neocores per site)
  app.get('/vpn/:siteName/neocore/:neocoreId', async (req, res) => {
    const { siteName, neocoreId } = req.params;
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];

    if (!site || !site.neocores?.[neocoreId]) {
      try {
        site = await getSiteBySlug(siteName);
      } catch (error) {
        console.error(`❌ Error looking up site ${siteName}:`, error.message);
      }
    }

    if (!site || !hasNeocores(site) || !site.neocores[neocoreId]) {
      return res.status(404).json({ error: 'Site or NeoCore not found' });
    }
    serveHTML(req, res, siteName, neocoreId);
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

  // Root-level images/icons (detect site from referer)
  app.get(/^\/([^\/]+\.(png|jpg|jpeg|svg|ico|gif|webp))$/, (req, res) => {
    const fileName = req.path.substring(1);
    const currentSites = getCurrentSites();
    const site = detectSite(req, currentSites) || Object.values(currentSites).find(s => hasNeocores(s));
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const assetPath = path.join(__dirname, '../build', fileName);
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Image not found' });
    } else if (process.env.DEBUG) {
      console.log(`📷 Served root image: /${fileName} → ${site.name}`);
    }
  });

  // Site-prefixed neocore static assets: /vpn/:siteName/neocore/:neocoreId/static/:type/:fileName
  app.get('/vpn/:siteName/neocore/:neocoreId/static/:type/:fileName', async (req, res) => {
    const { siteName, neocoreId } = req.params;
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];
    if (!site?.neocores?.[neocoreId]) {
      try { site = await getSiteBySlug(siteName); } catch (e) {}
    }
    if (!site || !site.neocores?.[neocoreId]) {
      return res.status(404).json({ error: 'Site or NeoCore not found' });
    }
    const assetPath = path.join(__dirname, '../build/static', req.params.type, req.params.fileName);
    const contentType = req.params.type === 'js' ? 'application/javascript' : 'text/css';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // Site-prefixed neocore images: /vpn/:siteName/neocore/:neocoreId/:assetFile
  app.get('/vpn/:siteName/neocore/:neocoreId/:assetFile', async (req, res) => {
    const { siteName, neocoreId, assetFile } = req.params;
    if (assetFile.startsWith('api') || assetFile === 'static') {
      return res.status(404).json({ error: 'Not found' });
    }
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];
    if (!site?.neocores?.[neocoreId]) {
      try { site = await getSiteBySlug(siteName); } catch (e) {}
    }
    if (!site || !site.neocores?.[neocoreId]) {
      return res.status(404).json({ error: 'Site or NeoCore not found' });
    }
    const assetPath = path.join(__dirname, '../build', assetFile);
    const ext = path.extname(assetFile).toLowerCase();
    const contentTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';
    if (!serveStaticFile(assetPath, res, contentType)) {
      res.status(404).json({ error: 'Asset not found' });
    }
  });

  // Catch-all for React Router: /vpn/:siteName/neocore/:neocoreId/*
  app.get('/vpn/:siteName/neocore/:neocoreId/*', async (req, res) => {
    const { siteName, neocoreId } = req.params;
    if (req.url.includes('/api') || req.url.includes('/socket.io')) {
      return res.status(404).json({ error: 'Not found' });
    }
    const currentSites = getCurrentSites();
    let site = currentSites[siteName];
    if (!site?.neocores?.[neocoreId]) {
      try { site = await getSiteBySlug(siteName); } catch (e) {}
    }
    if (!site || !site.neocores?.[neocoreId]) {
      return res.status(404).json({ error: 'Site or NeoCore not found' });
    }
    serveHTML(req, res, siteName, neocoreId);
  });
}

/**
 * Register device routes for all sites
 * URL Structure: /vpn/{site}/devices/{deviceId}/*
 * Devices routes MUST be registered BEFORE neocore routes to avoid conflicts
 * 
 * @param {Express} app - Express application instance
 * @param {Object|Function} sitesOrGetter - Site configuration object OR function that returns current sites
 */
function registerDevicesRoutes(app, sitesOrGetter) {
  // Helper function to get current sites (supports both object and getter function)
  const getCurrentSites = () => {
    if (typeof sitesOrGetter === 'function') {
      return sitesOrGetter();
    }
    return sitesOrGetter;
  };

  // CRITICAL: Universal middleware for ALL device assets
  // Catches root-level requests and rewrites them to device-specific paths
  // This handles ANY asset file from ANY device (JS, CSS, images, etc.)
  app.use(async (req, res, next) => {
    const url = req.url || '';
    
    // Skip routes that shouldn't be rewritten
    if (url.startsWith('/vpn/') || 
        url.startsWith('/api') || 
        url.startsWith('/socket.io') || 
        url.startsWith('/health') ||
        url.startsWith('/static/') ||
        url.match(/^\/main\.[^\/]+\.(js|css)$/)) {
      return next();
    }
    
    // Detect device from referer (with runtime database lookup)
    const referer = req.headers.referer || '';
    const currentSites = getCurrentSites();
    const deviceInfo = await detectDeviceFromReferer(referer, getCurrentSites);
    
    if (deviceInfo) {
      const { site, deviceId } = deviceInfo;
      const originalUrl = req.url;
      req.url = `/vpn/${site.name}/devices/${deviceId}${url}`;
      console.log(`🔄 Device asset: ${originalUrl} → ${req.url} (${site.name}/${deviceId})`);
    }
    
    next();
  });

  // Register individual device routes for each site (from static config)
  const currentSitesForRegistration = getCurrentSites();
  Object.values(currentSitesForRegistration).forEach(site => {
    if (site.devices?.enabled && site.devices.deviceList) {
      // Register route for each device in deviceList
      Object.entries(site.devices.deviceList).forEach(([deviceId, deviceConfig]) => {
        const proxy = createDeviceProxy(site, deviceId, deviceConfig);
        if (proxy) {
          // Route: /vpn/{site}/devices/{deviceId}/*
          app.use(`/vpn/${site.name}/devices/${deviceId}`, proxy);
          console.log(`✅ Registered device: /vpn/${site.name}/devices/${deviceId} → ${deviceConfig.target} (${deviceConfig.name || deviceId})`);
        } else {
          console.error(`❌ Failed to create proxy for device: ${site.name}/devices/${deviceId}`);
        }
      });
    } else if (site.devices?.enabled && !site.devices.deviceList) {
      console.warn(`⚠️  Site ${site.name} has devices enabled but no deviceList configured`);
    }
  });
  
  // Dynamic device route handler - handles devices from database (runtime lookup)
  app.use('/vpn/:siteName/devices/:deviceId', async (req, res, next) => {
    const siteSlug = req.params.siteName;
    const deviceId = req.params.deviceId;
    
    // Check static config first
    const currentSites = getCurrentSites();
    let site = currentSites[siteSlug];
    
    // If not in static config, try database lookup
    if (!site || !site.devices?.deviceList?.[deviceId]) {
      console.log(`🔍 Device ${deviceId} not in static config for site ${siteSlug}, checking database...`);
      try {
        site = await getSiteBySlug(siteSlug);
        if (site && site.devices?.deviceList?.[deviceId]) {
          console.log(`✅ Found device ${deviceId} for site ${siteSlug} in database`);
        } else {
          console.log(`⚠️  Device ${deviceId} not found for site ${siteSlug}`);
        }
      } catch (error) {
        console.error(`❌ Error looking up site ${siteSlug}:`, error.message);
      }
    }
    
    // If site/device found, create proxy on-the-fly
    if (site?.devices?.deviceList?.[deviceId]) {
      const deviceConfig = site.devices.deviceList[deviceId];
      const proxy = createDeviceProxy(site, deviceId, deviceConfig);
      if (proxy) {
        // Remove the route prefix and pass to proxy
        const originalUrl = req.url;
        req.url = req.url.replace(`/vpn/${siteSlug}/devices/${deviceId}`, '') || '/';
        console.log(`🔄 Dynamic device proxy: ${originalUrl} → ${deviceConfig.target}${req.url}`);
        return proxy(req, res, next);
      }
    }
    
    // Not found - continue to next middleware (will return 404)
    next();
  });
  
  console.log(`✅ Universal device asset handler active - handles ANY device from ANY site (static + dynamic)`);
}

/**
 * Register all routes
 * IMPORTANT: Device routes MUST be registered BEFORE neocore routes
 * 
 * @param {Express} app - Express application instance
 * @param {Object|Function} sitesOrGetter - Site configuration object OR function that returns current sites
 * @param {http.Server} server - HTTP server instance for WebSocket support
 */
function registerAllRoutes(app, sitesOrGetter, server) {
  // Helper function to get current sites (supports both object and getter function)
  const getSites = () => {
    if (typeof sitesOrGetter === 'function') {
      return sitesOrGetter();
    }
    return sitesOrGetter;
  };
  
  // Register devices routes FIRST to avoid conflicts
  registerDevicesRoutes(app, getSites);
  
  // Then register neocore routes
  registerNeocoreRoutes(app, getSites, server);
}

module.exports = { registerAllRoutes };
