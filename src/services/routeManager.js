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

/**
 * Detect site from URL, referer header, or cookies
 * Now supports runtime database lookup with caching
 */
async function detectSite(req, allSites) {
  let siteSlug = null;
  
  // Try URL path first (most reliable)
  const urlMatch = req.url.match(/^\/vpn\/([^\/]+)\//);
  if (urlMatch) {
    siteSlug = urlMatch[1];
  } else {
    // Try referer header (full URL with path) - works for HTTP requests
    const referer = req.headers.referer || '';
    const refererMatch = referer.match(/\/vpn\/([^\/]+)\//);
    if (refererMatch) {
      siteSlug = refererMatch[1];
    } else {
      // Try origin header (might have path in some cases)
      const origin = req.headers.origin || '';
      const originMatch = origin.match(/\/vpn\/([^\/]+)\//);
      if (originMatch) {
        siteSlug = originMatch[1];
      } else {
        // Try cookie (if session-based approach was used)
        if (req.headers.cookie) {
          const cookieMatch = req.headers.cookie.match(/vpn-site=([^;]+)/);
          if (cookieMatch) {
            siteSlug = cookieMatch[1];
          }
        }
      }
    }
  }
  
  if (!siteSlug) {
    return null;
  }
  
  // First check static sites
  if (allSites[siteSlug]) {
    return allSites[siteSlug];
  }
  
  // Not in static config - try cache/database lookup
  try {
    const siteConfig = await getSiteBySlug(siteSlug);
    if (siteConfig) {
      // Add to allSites for this request (but don't modify the original object)
      // Return the cached/looked-up site
      return siteConfig;
    }
  } catch (error) {
    console.error(`❌ Error looking up site ${siteSlug}:`, error.message);
  }
  
  return null;
}

/**
 * Synchronous version of detectSite (for use in synchronous contexts)
 * Only checks static sites, not database
 */
function detectSiteSync(req, allSites) {
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
 */
function registerNeocoreRoutes(app, sitesOrGetter, server) {
  // Helper function to get current sites (supports both object and getter function)
  const getCurrentSites = () => {
    if (typeof sitesOrGetter === 'function') {
      return sitesOrGetter();
    }
    return sitesOrGetter;
  };
  
  const allSites = getCurrentSites();
  
  // Create socket.io proxies for each site FIRST (before other routes)
  const socketProxies = new Map();
  const apiProxies = new Map();
  
  Object.values(allSites).forEach(site => {
    if (site.neocore?.enabled) {
      // Use wsTarget for WebSocket if available, otherwise use target
      const wsTarget = site.neocore.wsTarget || site.neocore.target;
      
      // Socket.io proxy - site-specific (use wsTarget for WebSocket)
      const socketProxy = createProxyMiddleware({
        target: wsTarget,
        changeOrigin: true,
        // IMPORTANT: we handle ALL Socket.IO WebSocket upgrades ourselves via server.on('upgrade')
        // Keep this middleware HTTP-only (polling) to avoid double-upgrade handling and "Invalid frame header"
        ws: false,
        xfwd: true,
        secure: false,
        timeout: 0, // No timeout
        proxyTimeout: 0, // No proxy timeout
        pathRewrite: { [`^/vpn/${site.name}/neocore/socket.io`]: '/socket.io' },
        logLevel: 'warn',
        wsErrorHandler: (err, req, socket) => {
          const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
          if (!suppressErrors.includes(err.code)) {
            console.error(`⚠️  WebSocket error (${site.name}):`, err.message);
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
      socketProxies.set(site.name, socketProxy);
      
      // API proxy - site-specific (use regular target)
      const apiProxy = createProxy(
        site.neocore.target,
        { [`^/vpn/${site.name}/neocore/api`]: '/api' },
        site.name
      );
      apiProxies.set(site.name, apiProxy);
      
      console.log(`✅ Registered proxies for ${site.name}:`);
      console.log(`   🔌 /vpn/${site.name}/neocore/socket.io → ${wsTarget}/socket.io`);
      console.log(`   🌐 /vpn/${site.name}/neocore/api → ${site.neocore.target}/api`);
    }
  });

  // URL rewrite interceptors (for HTTP requests - socket.io polling, API calls)
  // Use getter function to get current sites dynamically (already defined above)
  
  // Root-level API handler (handles /api requests without site prefix - only for neocore)
  app.use('/api', async (req, res, next) => {
    // Check if request is for neocore (from referer or cookie)
    const referer = req.headers.referer || '';
    const isNeocoreRequest = referer.includes('/neocore') || req.headers.cookie?.includes('vpn-site');
    
    if (!isNeocoreRequest) {
      // Not a neocore request, skip
      return next();
    }
    
    const currentSites = getCurrentSites();
    const site = await detectSite(req, currentSites);
    
    if (site?.neocore?.enabled) {
      // Get or create API proxy for this site
      let apiProxy = apiProxies.get(site.name);
      
      // If proxy doesn't exist (dynamic site from DB), create it
      if (!apiProxy) {
        apiProxy = createProxy(
          site.neocore.target,
          { [`^/vpn/${site.name}/neocore/api`]: '/api' },
          site.name
        );
        apiProxies.set(site.name, apiProxy);
        console.log(`✅ Created dynamic API proxy for ${site.name}`);
      }
      
      // Save original URL and rewrite for proxy
      const originalUrl = req.url;
      const rewrittenUrl = `/vpn/${site.name}/neocore/api${req.url}`;
      req.url = rewrittenUrl;
      console.log(`🔄 API rewrite: ${originalUrl} → ${rewrittenUrl} (site: ${site.name})`);
      
      // Proxy the request (pathRewrite will strip the prefix back to /api)
      return apiProxy(req, res, next);
    } else {
      console.warn(`⚠️  Could not detect site for ${req.url} (referer: ${req.headers.referer || 'none'})`);
      return res.status(404).json({ error: 'Site not found or NeoCore not enabled' });
    }
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
    const currentSites = getCurrentSites();
    const site = detectSite(req, currentSites);
    if (site?.neocore?.enabled) {
      // NOTE: when mounted at '/socket.io', Express strips that prefix.
      // If the browser hits '/socket.io/?EIO=4...', then req.url here is '/?EIO=4...'
      // We must preserve the full path+query (including leading '/').
      req.url = `/vpn/${site.name}/neocore/socket.io${req.url}`;
      console.log(`🔄 Root socket.io rewrite: ${req.url} → ${site.name}`);
      const proxy = socketProxies.get(site.name);
      if (proxy) {
        return proxy(req, res, next);
      }
    }
    // Fallback to first site (not ideal, but better than failing)
    const firstSite = Object.values(currentSites).find(s => s.neocore?.enabled);
    if (firstSite) {
      req.url = `/vpn/${firstSite.name}/neocore/socket.io${req.url}`;
      console.log(`🔄 Root socket.io rewrite (fallback): ${req.url} → ${firstSite.name}`);
      const proxy = socketProxies.get(firstSite.name);
      if (proxy) {
        return proxy(req, res, next);
      }
    }
    res.status(404).json({ error: 'Socket.io endpoint not found - no site detected' });
  });

  // WebSocket upgrade handler - Manually handle upgrades for /socket.io without site prefix
  // Create reusable proxy instances per site to avoid conflicts
  if (server && socketProxies.size > 0) {
    // Create reusable proxy instances for each site
    const wsProxies = new Map();
    Object.values(allSites).forEach(site => {
      if (site.neocore?.enabled) {
        // Use wsTarget if available (direct backend connection), otherwise use target (nginx)
        const wsTarget = site.neocore.wsTarget || site.neocore.target;
        const proxy = httpProxy.createProxyServer({
          target: wsTarget,
          ws: true,
          changeOrigin: true,
          secure: false,
          timeout: 0, // No timeout - keep connection alive
          proxyTimeout: 0, // No proxy timeout
          xfwd: true, // Forward X-Forwarded-* headers
          // Don't rewrite path - keep /socket.io as is
          // Ensure WebSocket frames are forwarded immediately without buffering
          buffer: false, // Disable buffering for WebSocket
        });
        
        console.log(`   🔌 WebSocket proxy target for ${site.name}: ${wsTarget}`);
        
        // Handle proxy errors (including backend connection failures)
        proxy.on('error', (err, req, socket) => {
          const wsTarget = site.neocore.wsTarget || site.neocore.target;
          const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
          if (!suppressErrors.includes(err.code)) {
            console.error(`   ❌ WebSocket proxy error (${site.name}):`, err.message);
            console.error(`   Code: ${err.code}, Target: ${wsTarget}`);
            console.error(`   This usually means the backend is not reachable or not responding`);
          } else if (err.code === 'ECONNREFUSED') {
            // This is important - backend is not accepting connections
            console.error(`   ⚠️  Backend connection refused (${site.name}): ${wsTarget}`);
            console.error(`   Check if NeoCore backend is running and accessible`);
          }
          if (socket && !socket.destroyed) {
            try {
              socket.destroy();
            } catch (e) {}
          }
        });
        
        // Handle WebSocket proxy request (before connecting to backend)
        proxy.on('proxyReqWs', (proxyReq, req, socket) => {
          // Use wsTarget if available (direct backend), otherwise use target (nginx)
          const wsTarget = site.neocore.wsTarget || site.neocore.target;
          const targetUrl = new URL(wsTarget);
          
          // Host header: Include port if not standard (80/443)
          const port = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
          const hostHeader = (port === '80' || port === '443') ? targetUrl.hostname : `${targetUrl.hostname}:${port}`;
          
          proxyReq.setHeader('Host', hostHeader); // Critical: Socket.IO needs correct Host header
          proxyReq.setHeader('X-Forwarded-Proto', targetUrl.protocol === 'https:' ? 'wss' : 'ws');
          proxyReq.setHeader('X-Forwarded-For', req.socket.remoteAddress || req.headers['x-forwarded-for'] || '');
          proxyReq.setHeader('X-Real-IP', req.socket.remoteAddress || '');
          
          // Preserve original headers that Socket.IO might need
          if (req.headers.origin) {
            proxyReq.setHeader('Origin', req.headers.origin);
          }
          if (req.headers.cookie) {
            proxyReq.setHeader('Cookie', req.headers.cookie);
          }
          
          // Set Connection and Upgrade headers explicitly for WebSocket
          proxyReq.setHeader('Connection', 'Upgrade');
          proxyReq.setHeader('Upgrade', 'websocket');
          
          console.log(`   🔗 Connecting to backend: ${wsTarget}${req.url}`);
          console.log(`   Host header: ${hostHeader} (port: ${port})`);
        });
        
        // Handle WebSocket upgrade success (connection to backend established)
        proxy.on('open', (proxySocket) => {
          const wsTarget = site.neocore.wsTarget || site.neocore.target;
          console.log(`   ✅ WebSocket connection established to backend (${site.name})`);
          console.log(`   📡 Real-time data should now flow`);
          console.log(`   🔗 Connected to: ${wsTarget}`);
          
          // Ensure socket is in flowing mode (not paused) for immediate data forwarding
          // DO NOT add 'data' event handlers - let http-proxy handle WebSocket frames automatically
          proxySocket.resume();
          
          // Only track errors and close events - don't interfere with data flow
          proxySocket.on('error', (err) => {
            const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED'];
            if (!suppressErrors.includes(err.code)) {
              console.error(`   ❌ Proxy socket error (${site.name}):`, err.message);
            }
          });
          
          proxySocket.on('close', () => {
            console.log(`   🔌 Proxy socket closed (${site.name})`);
          });
        });
        
        // Handle WebSocket close
        proxy.on('close', (res, socket, head) => {
          console.log(`   🔌 WebSocket connection closed (${site.name})`);
        });
        
        // Handle WebSocket proxy response (backend responded)
        proxy.on('proxyRes', (proxyRes, req, res) => {
          console.log(`   📥 Backend response: ${proxyRes.statusCode} (${site.name})`);
        });
        
        // Handle WebSocket upgrade response
        proxy.on('upgrade', (res, socket, head) => {
          console.log(`   ⬆️  WebSocket upgrade response received (${site.name})`);
          console.log(`   Status: ${res.statusCode}`);
          if (res.statusCode !== 101) {
            console.error(`   ⚠️  Unexpected status code: ${res.statusCode} (expected 101)`);
          } else {
            console.log(`   ✅ Upgrade successful - WebSocket protocol established`);
            // Ensure upgrade response headers are properly set
            if (res.headers) {
              console.log(`   📋 Upgrade headers: Connection=${res.headers.connection}, Upgrade=${res.headers.upgrade}`);
            }
          }
        });
        
        // Handle WebSocket error during upgrade
        proxy.on('error', (err, req, socket) => {
          const suppressErrors = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ERR_STREAM_WRITE_AFTER_END'];
          if (!suppressErrors.includes(err.code)) {
            console.error(`   ❌ WebSocket proxy error during upgrade (${site.name}):`, err.message);
            console.error(`   Code: ${err.code}`);
          }
        });
        
        wsProxies.set(site.name, proxy);
      }
    });
    
    // Handle WebSocket upgrades for root-level /socket.io requests
    // We handle ALL socket.io websocket upgrades here (both root + site-prefixed),
    // to guarantee single handling and avoid frame corruption.
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      if (!url.includes('/socket.io')) return;
      
      // Get current sites dynamically
      const currentSites = getCurrentSites();

      // Determine site
      let targetSite = null;

      // 1) If site is already in URL (prefixed)
      const urlMatch = url.match(/^\/vpn\/([^\/]+)\/neocore\/socket\.io(\/|\?|$)/);
      if (urlMatch) {
        targetSite = currentSites[urlMatch[1]];
      }

      // 2) Cookie / referer / origin
      if (!targetSite?.neocore?.enabled) {
        const cookieHeader = req.headers.cookie || '';
        const cookieMatch = cookieHeader.match(/vpn-site=([^;,\s]+)/);
        if (cookieMatch) targetSite = currentSites[cookieMatch[1].trim()];
      }
      // Use sync version for WebSocket (async not supported in upgrade handler)
      if (!targetSite?.neocore?.enabled) targetSite = detectSiteSync(req, currentSites);
      if (!targetSite?.neocore?.enabled) targetSite = Object.values(currentSites).find(s => s.neocore?.enabled);

      console.log(`🔌 WebSocket upgrade: ${url}`);
      console.log(`   Site: ${targetSite?.name || 'NONE'}`);

      if (!targetSite?.neocore?.enabled) {
        console.error(`   ❌ No site detected, closing connection`);
        socket.destroy();
        return;
      }

      // Ensure backend sees a pure Socket.IO path: /socket.io/...
      if (url.startsWith(`/vpn/${targetSite.name}/neocore`)) {
        req.url = url.replace(new RegExp(`^/vpn/${targetSite.name}/neocore`), '');
      }

      const proxy = wsProxies.get(targetSite.name);
      if (!proxy) {
        console.error(`   ❌ wsProxy not found for site: ${targetSite.name}`);
        socket.destroy();
        return;
      }

      try {
        proxy.ws(req, socket, head);
      } catch (err) {
        console.error(`   ❌ wsProxy.ws failed (${targetSite.name}): ${err.message}`);
        if (!socket.destroyed) socket.destroy();
      }
    });
    
    console.log(`✅ WebSocket upgrade handler registered (single handler; per-site proxies reused)`);
  }

  // HTML route - with runtime database lookup
  app.get('/vpn/:siteName/neocore', async (req, res) => {
    const currentSites = getCurrentSites();
    let site = currentSites[req.params.siteName];
    
    // If not in static config, try database lookup
    if (!site?.neocore?.enabled) {
      console.log(`🔍 Site ${req.params.siteName} not in static config, checking database...`);
      try {
        site = await getSiteBySlug(req.params.siteName);
        if (site) {
          // Add to current sites temporarily for this request
          // Note: This doesn't modify the original SITES object
          console.log(`✅ Found site ${req.params.siteName} in database: VPN IP ${site.vpnIp}`);
        }
      } catch (error) {
        console.error(`❌ Error looking up site ${req.params.siteName}:`, error.message);
      }
    }
    
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

  // Root-level images/icons (detect site from referer)
  app.get(/^\/([^\/]+\.(png|jpg|jpeg|svg|ico|gif|webp))$/, (req, res) => {
    // Extract filename from URL path (remove leading slash)
    const fileName = req.path.substring(1);
    const currentSites = getCurrentSites();
    const site = detectSite(req, currentSites) || Object.values(currentSites).find(s => s.neocore?.enabled);
    
    if (!site) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
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
      console.log(`📷 Served root image: /${fileName} → ${site.name} (from ${req.headers.referer || 'direct'})`);
    }
  });

  // Site-prefixed static assets - with runtime database lookup
  app.get('/vpn/:siteName/neocore/static/:type/:fileName', async (req, res) => {
    const currentSites = getCurrentSites();
    let site = currentSites[req.params.siteName];
    
    // If not in static config, try database lookup
    if (!site?.neocore?.enabled) {
      try {
        site = await getSiteBySlug(req.params.siteName);
      } catch (error) {
        console.error(`❌ Error looking up site ${req.params.siteName}:`, error.message);
      }
    }
    
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
  app.get('/vpn/:siteName/neocore/:assetFile', async (req, res) => {
    const currentSites = getCurrentSites();
    let site = currentSites[req.params.siteName];
    
    // If not in static config, try database lookup
    if (!site?.neocore?.enabled) {
      try {
        site = await getSiteBySlug(req.params.siteName);
      } catch (error) {
        console.error(`❌ Error looking up site ${req.params.siteName}:`, error.message);
      }
    }
    
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
  app.get('/vpn/:siteName/neocore/*', async (req, res) => {
    const currentSites = getCurrentSites();
    let site = currentSites[req.params.siteName];
    
    // If not in static config, try database lookup
    if (!site?.neocore?.enabled) {
      try {
        site = await getSiteBySlug(req.params.siteName);
      } catch (error) {
        console.error(`❌ Error looking up site ${req.params.siteName}:`, error.message);
      }
    }
    
    if (!site?.neocore?.enabled || req.url.includes('/api') || req.url.includes('/socket.io')) {
      return res.status(404).json({ error: 'Not found' });
    }
    serveHTML(req, res, req.params.siteName);
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
