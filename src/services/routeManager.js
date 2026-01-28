/**
 * Route Manager - Registers routes for all sites and services
 * Perfect implementation for site-specific socket.io connections
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const httpProxy = require("http-proxy");
const { createDeviceProxy } = require("./proxyFactory");
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
function registerNeocoreRoutes(app, allSites, server) {
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
  app.use((req, res, next) => {
    // Only intercept API requests without site prefix
    // IMPORTANT: Do NOT rewrite /socket.io here. Express mounts strip prefixes (e.g. '/socket.io' -> '/'),
    // and doing it in two places causes subtle path/query bugs that break Engine.IO.
    if (req.url.startsWith('/api') && !req.url.startsWith('/vpn/')) {
      const site = detectSite(req, allSites);
      if (site?.neocore?.enabled) {
        const prefix = `/vpn/${site.name}/neocore`;
        req.url = `${prefix}${req.url}`;
        console.log(`🔄 API rewrite: ${req.url} → ${site.name} (from ${req.headers.referer || 'direct'})`);
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
    const firstSite = Object.values(allSites).find(s => s.neocore?.enabled);
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

      // Determine site
      let targetSite = null;

      // 1) If site is already in URL (prefixed)
      const urlMatch = url.match(/^\/vpn\/([^\/]+)\/neocore\/socket\.io(\/|\?|$)/);
      if (urlMatch) {
        targetSite = allSites[urlMatch[1]];
      }

      // 2) Cookie / referer / origin
      if (!targetSite?.neocore?.enabled) {
        const cookieHeader = req.headers.cookie || '';
        const cookieMatch = cookieHeader.match(/vpn-site=([^;,\s]+)/);
        if (cookieMatch) targetSite = allSites[cookieMatch[1].trim()];
      }
      if (!targetSite?.neocore?.enabled) targetSite = detectSite(req, allSites);
      if (!targetSite?.neocore?.enabled) targetSite = Object.values(allSites).find(s => s.neocore?.enabled);

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

  // Root-level images/icons (detect site from referer)
  app.get(/^\/([^\/]+\.(png|jpg|jpeg|svg|ico|gif|webp))$/, (req, res) => {
    // Extract filename from URL path (remove leading slash)
    const fileName = req.path.substring(1);
    const site = detectSite(req, allSites) || Object.values(allSites).find(s => s.neocore?.enabled);
    
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
 * Register device routes for all sites
 * URL Structure: /vpn/{site}/devices/{deviceId}/*
 * Devices routes MUST be registered BEFORE neocore routes to avoid conflicts
 */
function registerDevicesRoutes(app, allSites) {
  // Register individual device routes for each site
  Object.values(allSites).forEach(site => {
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
}

/**
 * Register all routes
 * IMPORTANT: Device routes MUST be registered BEFORE neocore routes
 */
function registerAllRoutes(app, sites, server) {
  // Register devices routes FIRST to avoid conflicts
  registerDevicesRoutes(app, sites);
  
  // Then register neocore routes
  registerNeocoreRoutes(app, sites, server);
}

module.exports = { registerAllRoutes };
