/**
 * Proxy Factory
 * Creates proxy middleware for neocore and devices
 */

const { createProxyMiddleware } = require("http-proxy-middleware");
const { SocksProxyAgent } = require("socks-proxy-agent");

/**
 * Create agent for SOCKS tunnel
 */
function createSocksAgent(socksPort) {
  try {
    return new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`, {
      timeout: 30000,
      keepAlive: true
    });
  } catch (err) {
    console.error(`❌ Failed to create SOCKS agent:`, err.message);
    return undefined;
  }
}

/**
 * Request tracking utility
 */
function trackRequest(site, service, req, status = 'start') {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  
  if (status === 'start') {
    console.log(`📥 [${timestamp}] ${method} ${url} | Site: ${site.name} | Service: ${service} | VPN IP: ${site.vpnIp} | Client: ${ip}`);
  } else if (status === 'success') {
    console.log(`✅ [${timestamp}] ${method} ${url} | Site: ${site.name} | Service: ${service} | Status: Success`);
  } else if (status === 'error') {
    console.log(`❌ [${timestamp}] ${method} ${url} | Site: ${site.name} | Service: ${service} | Status: Error`);
  }
}

/**
 * Create proxy for neocore (direct VPN access)
 */
function createNeocoreProxy(site) {
  if (!site.neocore || !site.neocore.enabled) return null;

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
        console.error(`⚠️  WebSocket error (${site.name}/neocore):`, err.message);
      }
    },

    pathRewrite: {
      [`^/vpn/${site.name}/neocore`]: ""
    },

    onProxyReq: (proxyReq, req, res) => {
      trackRequest(site, 'neocore', req, 'start');
      if (process.env.DEBUG) {
        console.log(`   → Target: ${site.neocore.target}`);
        console.log(`   → VPN IP: ${site.vpnIp}`);
        console.log(`   → Rewritten path: ${proxyReq.path}`);
      }
    },

    onError: (err, req, res) => {
      // Suppress ECONNRESET errors (normal client disconnects)
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        trackRequest(site, 'neocore', req, 'error');
        console.error(`❌ Neocore proxy error (${site.name}):`, err.message);
        console.error(`   Target: ${site.neocore.target}`);
        console.error(`   VPN IP: ${site.vpnIp}`);
      }
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({
            error: "Proxy error",
            message: err.message,
            site: site.name,
            service: "neocore",
            target: site.neocore.target,
            vpnIp: site.vpnIp
          });
        } catch (e) {}
      }
    },

    onProxyRes: (proxyRes, req, res) => {
      // Remove CORS restrictions
      proxyRes.headers["access-control-allow-origin"] = "*";
      proxyRes.headers["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      proxyRes.headers["access-control-allow-headers"] = "*";

      const contentType = proxyRes.headers["content-type"] || "";
      const isTextContent = 
        contentType.includes("text/html") ||
        contentType.includes("text/css") ||
        contentType.includes("javascript") ||
        contentType.includes("application/json") ||
        contentType.includes("text/plain") ||
        contentType.includes("application/javascript") ||
        contentType.includes("text/javascript");

      if (!isTextContent) {
        proxyRes.pipe(res);
        return;
      }

      let body = "";
      proxyRes.on("data", chunk => {
        body += chunk.toString();
      });

      proxyRes.on("end", () => {
        try {
          // Only rewrite HTML to point to local assets, skip JS/CSS (served separately)
          if (contentType.includes("text/html")) {
            body = rewriteContent(body, site.name, req, 'neocore');
          }
          
          if (!res.headersSent && !res.writableEnded) {
            res.setHeader("content-type", contentType);
            res.setHeader("content-length", Buffer.byteLength(body));
            res.end(body);
          }
        } catch (err) {
          console.error(`❌ Error rewriting content (${site.name}/neocore):`, err.message);
          if (!res.headersSent && !res.writableEnded) {
            try {
              res.status(500).json({ error: "Content processing error" });
            } catch (e) {}
          }
        }
      });

      proxyRes.on("error", (err) => {
        // Suppress ECONNRESET errors
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          trackRequest(site, 'neocore', req, 'error');
          console.error(`❌ Proxy response error (${site.name}/neocore):`, err.message);
        }
        if (!res.headersSent && !res.writableEnded) {
          try {
            res.status(502).json({ error: "Proxy response error" });
          } catch (e) {}
        }
      });

      proxyRes.on("end", () => {
        trackRequest(site, 'neocore', req, 'success');
      });
    }
  });

  return proxy;
}

/**
 * Create proxy for devices (via SOCKS tunnel)
 */
function createDevicesProxy(site) {
  if (!site.devices || !site.devices.enabled) return null;

  // Middleware to check tunnel readiness
  const tunnelCheck = (req, res, next) => {
    if (!site.devices.tunnelReady) {
      trackRequest(site, 'devices', req, 'error');
      console.error(`⚠️  Tunnel not ready for ${site.name} (SOCKS:${site.devices.socksPort})`);
      return res.status(503).json({
        error: "SOCKS tunnel not ready",
        message: "Please wait for tunnel to establish",
        site: site.name,
        service: "devices",
        vpnIp: site.vpnIp,
        socksPort: site.devices.socksPort,
        retryAfter: 2
      });
    }
    next();
  };

  const proxy = createProxyMiddleware({
    target: site.devices.target,
    changeOrigin: true,
    ws: true,
    agent: createSocksAgent(site.devices.socksPort),
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    // Suppress WebSocket ECONNRESET errors
    wsErrorHandler: (err, req, socket, head) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error(`⚠️  WebSocket error (${site.name}/devices):`, err.message);
      }
    },

    pathRewrite: {
      [`^/vpn/${site.name}/devices`]: ""
    },

    onError: (err, req, res) => {
      // Suppress ECONNRESET errors
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        trackRequest(site, 'devices', req, 'error');
        console.error(`❌ Devices proxy error (${site.name}):`, err.message);
        console.error(`   Target: ${site.devices.target}`);
        console.error(`   VPN IP: ${site.vpnIp}`);
        console.error(`   SOCKS Port: ${site.devices.socksPort}`);
      }
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({
            error: "Proxy error",
            message: err.message,
            site: site.name,
            service: "devices",
            target: site.devices.target,
            vpnIp: site.vpnIp,
            socksPort: site.devices.socksPort
          });
        } catch (e) {}
      }
    },

    onProxyReq: (proxyReq, req, res) => {
      trackRequest(site, 'devices', req, 'start');
      // Recreate agent if needed
      if (site.devices.tunnelReady) {
        const agent = createSocksAgent(site.devices.socksPort);
        if (agent) {
          proxyReq.agent = agent;
        }
      }
      
      if (process.env.DEBUG) {
        console.log(`   → Target: ${site.devices.target}`);
        console.log(`   → VPN IP: ${site.vpnIp}`);
        console.log(`   → SOCKS Port: ${site.devices.socksPort}`);
        console.log(`   → Tunnel Ready: ${site.devices.tunnelReady}`);
        console.log(`   → Rewritten path: ${proxyReq.path}`);
      }
    },

    onProxyRes: (proxyRes, req, res) => {
      proxyRes.headers["access-control-allow-origin"] = "*";
      proxyRes.headers["access-control-allow-methods"] = "GET, POST, PUT, DELETE, OPTIONS";
      proxyRes.headers["access-control-allow-headers"] = "*";

      const contentType = proxyRes.headers["content-type"] || "";
      const isTextContent = 
        contentType.includes("text/html") ||
        contentType.includes("text/css") ||
        contentType.includes("javascript") ||
        contentType.includes("application/json") ||
        contentType.includes("text/plain");

      if (!isTextContent) {
        proxyRes.pipe(res);
        return;
      }

      let body = "";
      proxyRes.on("data", chunk => {
        body += chunk.toString();
      });

      proxyRes.on("end", () => {
        try {
          body = rewriteContent(body, site.name, req, 'devices');
          
          if (!res.headersSent && !res.writableEnded) {
            res.setHeader("content-type", contentType);
            res.setHeader("content-length", Buffer.byteLength(body));
            res.end(body);
            trackRequest(site, 'devices', req, 'success');
          }
        } catch (err) {
          trackRequest(site, 'devices', req, 'error');
          console.error(`❌ Error rewriting content (${site.name}/devices):`, err.message);
          if (!res.headersSent && !res.writableEnded) {
            try {
              res.status(500).json({ error: "Content processing error" });
            } catch (e) {}
          }
        }
      });

      proxyRes.on("error", (err) => {
        // Suppress ECONNRESET errors
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          trackRequest(site, 'devices', req, 'error');
          console.error(`❌ Proxy response error (${site.name}/devices):`, err.message);
        }
        if (!res.headersSent && !res.writableEnded) {
          try {
            res.status(502).json({ error: "Proxy response error" });
          } catch (e) {}
        }
      });
    }
  });

  return [tunnelCheck, proxy];
}

/**
 * Rewrite HTML content to point to local assets and correct API paths
 * For devices: Rewrites all relative paths to include site prefix
 * For neocore: Rewrites main.js/css and API paths
 */
function rewriteContent(body, siteName, req, serviceType = 'neocore') {
  // Use full path including service type
  const sitePrefix = serviceType === 'neocore' 
    ? `/vpn/${siteName}/neocore`
    : `/vpn/${siteName}/devices`;
    
  // Track rewriting for debugging
  if (process.env.DEBUG) {
    console.log(`   🔄 Rewriting HTML content for ${siteName}/${serviceType}`);
  }
  
  if (serviceType === 'devices') {
    // DEVICE-SPECIFIC REWRITING - Comprehensive path rewriting for device HTML
    // Rewrite all relative paths to include /vpn/site/devices prefix
    
    body = body
      // 1. Rewrite relative hrefs (links, CSS) - matches href="file.ext" or href='file.ext'
      .replace(/(href)=(["'])(?!http|https|\/\/|#|javascript:|vpn\/)([^"']+)\2/gi,
        (match, attr, quote, path) => {
          // Skip if already absolute or special protocol
          if (path.startsWith('/vpn/') || path.startsWith('http://') || 
              path.startsWith('https://') || path.startsWith('//') ||
              path.startsWith('#') || path.startsWith('javascript:')) {
            return match;
          }
          // Make path absolute if relative
          const absolutePath = path.startsWith('/') ? path : `/${path}`;
          return `${attr}=${quote}${sitePrefix}${absolutePath}${quote}`;
        })
      
      // 2. Rewrite relative srcs (images, scripts, iframes) - matches src="file.ext" or src='file.ext'
      .replace(/(src)=(["'])(?!http|https|\/\/|data:|javascript:|vpn\/)([^"']+)\2/gi,
        (match, attr, quote, path) => {
          // Skip if already absolute or special protocol
          if (path.startsWith('/vpn/') || path.startsWith('http://') || 
              path.startsWith('https://') || path.startsWith('//') ||
              path.startsWith('data:') || path.startsWith('javascript:')) {
            return match;
          }
          // Make path absolute if relative
          const absolutePath = path.startsWith('/') ? path : `/${path}`;
          return `${attr}=${quote}${sitePrefix}${absolutePath}${quote}`;
        })
      
      // 3. Rewrite form actions - matches action="file.ext" or action='file.ext'
      .replace(/(action)=(["'])(?!http|https|\/\/|javascript:|vpn\/)([^"']+)\2/gi,
        (match, attr, quote, path) => {
          // Skip if already absolute or special protocol
          if (path.startsWith('/vpn/') || path.startsWith('http://') || 
              path.startsWith('https://') || path.startsWith('//') ||
              path.startsWith('javascript:')) {
            return match;
          }
          // Make path absolute if relative
          const absolutePath = path.startsWith('/') ? path : `/${path}`;
          return `${attr}=${quote}${sitePrefix}${absolutePath}${quote}`;
        })
      
      // 4. Rewrite iframe src attributes specifically
      .replace(/(<iframe[^>]*\ssrc)=(["'])(?!http|https|\/\/|data:|vpn\/)([^"']+)\2/gi,
        (match, attr, quote, path) => {
          if (path.startsWith('/vpn/') || path.startsWith('http://') || 
              path.startsWith('https://') || path.startsWith('//') ||
              path.startsWith('data:')) {
            return match;
          }
          const absolutePath = path.startsWith('/') ? path : `/${path}`;
          return `${attr}=${quote}${sitePrefix}${absolutePath}${quote}`;
        })
      
      // 5. Rewrite WebSocket connections in JavaScript
      .replace(/(ws|wss):\/\/[^/]+(\/[^"'\s)]+)/g, 
        `$1://${req.headers.host}${sitePrefix}$2`)
      
      // 6. Rewrite fetch/XMLHttpRequest URLs in JavaScript (basic pattern)
      .replace(/(fetch|XMLHttpRequest|open)\s*\(["']([^"']+)["']/gi,
        (match, method, url) => {
          if (url.startsWith('/vpn/') || url.startsWith('http://') || 
              url.startsWith('https://') || url.startsWith('//')) {
            return match;
          }
          const absoluteUrl = url.startsWith('/') ? url : `/${url}`;
          return `${method}("${sitePrefix}${absoluteUrl}"`;
        });
    
  } else {
    // NEOCORE-SPECIFIC REWRITING - Simplified for React app
    body = body
      // Rewrite main.js and main.css to local assets endpoint
      .replace(/(src|href)=(["'])(\/static\/js\/main\.[^"']+\.js)\2/gi, 
        (match, attr, quote, path) => {
          const fileName = path.split('/').pop();
          return `${attr}=${quote}/${fileName}${quote}`;
        })
      .replace(/(src|href)=(["'])(\/static\/css\/main\.[^"']+\.css)\2/gi, 
        (match, attr, quote, path) => {
          const fileName = path.split('/').pop();
          return `${attr}=${quote}/${fileName}${quote}`;
        })
      
      // API endpoints - point to correct site
      .replace(/(src|href|action)=(["'])(\/api\/[^"']+)\2/gi, `$1=$2${sitePrefix}$3$2`)
      
      // Other static assets (images, fonts, etc.) - point to correct site
      .replace(/(src|href)=(["'])(\/(?!vpn\/|http|https|\/\/|main\.)[^"']+)\2/gi, 
        (match, attr, quote, path) => {
          if (path.startsWith('/vpn/') || path.startsWith('http://') || 
              path.startsWith('https://') || path.startsWith('//')) {
            return match;
          }
          return `${attr}=${quote}${sitePrefix}${path}${quote}`;
        })
      
      // WebSocket connections
      .replace(/(ws|wss):\/\/[^/]+(\/[^"'\s)]+)/g, `$1://${req.headers.host}${sitePrefix}$2`);
  }
  
  return body;
}

module.exports = {
  createNeocoreProxy,
  createDevicesProxy
};
