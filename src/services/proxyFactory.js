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
          body = rewriteContent(body, site.name, req, 'neocore');
          
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
 * Rewrite content paths for React apps
 */
function rewriteContent(body, siteName, req, serviceType = 'neocore') {
  // Use full path including service type
  const sitePrefix = serviceType === 'neocore' 
    ? `/vpn/${siteName}/neocore`
    : `/vpn/${siteName}/devices`;
    
  const contentType = req.headers["content-type"] || "";
  const isJS = contentType.includes("javascript");
  const isHTML = contentType.includes("text/html");
  const isCSS = contentType.includes("text/css");
  
  // Track rewriting for debugging
  if (process.env.DEBUG && (isJS || isHTML || isCSS)) {
    console.log(`   🔄 Rewriting content for ${siteName}/${serviceType} (${contentType})`);
  }
  
  if (isJS) {
    // More aggressive JavaScript rewriting
    body = body
      .replace(/process\.env\.REACT_APP_API_URL\s*\|\|\s*["']([^"']+)["']/gi, 
        `process.env.REACT_APP_API_URL || "${sitePrefix}$1"`)
      .replace(/(fetch|axios|XMLHttpRequest)\(["'](\/[^"']+)["']/gi, 
        (match, method, path) => {
          // Rewrite all relative paths starting with /api or /static
          if (path.startsWith('/api/') || path.startsWith('/static/') || 
              path.startsWith('/fonts/') || /\.(png|svg|ico|jpg|jpeg|webp|gif|css|js)$/.test(path)) {
            return `${method}("${sitePrefix}${path}")`;
          }
          return match;
        })
      .replace(/["'](\/api\/[^"']+)["']/gi, `"${sitePrefix}$1"`)
      .replace(/["'](\/static\/[^"']+)["']/gi, `"${sitePrefix}$1"`)
      .replace(/url:\s*["'](\/[^"']+)["']/gi, (match, path) => {
        if (path.startsWith('/api/') || path.startsWith('/static/')) {
          return `url: "${sitePrefix}${path}"`;
        }
        return match;
      });
  }
  
  // More aggressive HTML/JS/CSS rewriting - First pass: catch-all for absolute paths
  if (isHTML || isJS) {
    // Replace all absolute paths that start with / (but not /vpn/, http, https, //)
    // This handles cases like /nslogo.png, /static/js/main.js, etc.
    body = body.replace(/(["'])(\/(?!vpn\/|http|https|\/\/)[^"']+)\1/g, (match, quote, path) => {
      // Skip if already has /vpn/ prefix
      if (path.startsWith('/vpn/')) return match;
      // Skip external URLs
      if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) return match;
      // Rewrite all other absolute paths
      return `${quote}${sitePrefix}${path}${quote}`;
    });
  }
  
  // Specific patterns for better coverage (second pass for edge cases)
  body = body
    // Static assets - handle all quote types
    .replace(/(src|href|action)=(["'])(\/static\/[^"']+)\2/gi, `$1=$2${sitePrefix}$3$2`)
    .replace(/url\(\s*(["']?)(\/static\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    
    // API endpoints
    .replace(/(fetch|axios|XMLHttpRequest)\(["'](\/api\/[^"']+)["']/gi, `$1("${sitePrefix}$2"`)
    .replace(/(src|href|action)=(["'])(\/api\/[^"']+)\2/gi, `$1=$2${sitePrefix}$3$2`)
    
    // Root assets (images, fonts, icons, CSS, JS) - handle with query strings
    .replace(/(src|href)=(["'])(\/([^"?#\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf|css|js))(\?[^"]*)?)\2/gi, 
      `$1=$2${sitePrefix}$3$2`)
    
    // Font files in CSS
    .replace(/url\(\s*(["']?)(\/fonts\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    .replace(/url\(\s*(["']?)(\/assets\/fonts\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    
    // WebSocket connections
    .replace(/(ws|wss):\/\/[^/]+(\/[^"'\s)]+)/g, `$1://${req.headers.host}${sitePrefix}$2`);
  
  return body;
}

module.exports = {
  createNeocoreProxy,
  createDevicesProxy
};
