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

    pathRewrite: {
      [`^/vpn/${site.name}/neocore`]: ""
    },

    onError: (err, req, res) => {
      console.error(`❌ Neocore proxy error (${site.name}):`, err.message);
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({
            error: "Proxy error",
            message: err.message,
            site: site.name,
            service: "neocore"
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
        console.error(`❌ Proxy response error (${site.name}/neocore):`, err.message);
        if (!res.headersSent && !res.writableEnded) {
          try {
            res.status(502).json({ error: "Proxy response error" });
          } catch (e) {}
        }
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
      return res.status(503).json({
        error: "SOCKS tunnel not ready",
        message: "Please wait for tunnel to establish",
        site: site.name,
        service: "devices",
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

    pathRewrite: {
      [`^/vpn/${site.name}/devices`]: ""
    },

    onError: (err, req, res) => {
      console.error(`❌ Devices proxy error (${site.name}):`, err.message);
      if (!res.headersSent && !res.writableEnded) {
        try {
          res.status(502).json({
            error: "Proxy error",
            message: err.message,
            site: site.name,
            service: "devices"
          });
        } catch (e) {}
      }
    },

    onProxyReq: (proxyReq, req, res) => {
      // Recreate agent if needed
      if (site.devices.tunnelReady) {
        const agent = createSocksAgent(site.devices.socksPort);
        if (agent) {
          proxyReq.agent = agent;
        }
      }
      
      if (process.env.DEBUG) {
        console.log(`📤 ${req.method} ${req.url} → ${site.devices.target}`);
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
          }
        } catch (err) {
          console.error(`❌ Error rewriting content (${site.name}/devices):`, err.message);
          if (!res.headersSent && !res.writableEnded) {
            try {
              res.status(500).json({ error: "Content processing error" });
            } catch (e) {}
          }
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
  
  // Comprehensive HTML/JS/CSS rewriting
  body = body
    // Static assets - handle all quote types
    .replace(/(src|href|action)=(["'])(\/static\/[^"']+)\2/gi, `$1=$2${sitePrefix}$3$2`)
    .replace(/url\(\s*(["']?)(\/static\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    
    // API endpoints
    .replace(/(fetch|axios|XMLHttpRequest)\(["'](\/api\/[^"']+)["']/gi, `$1("${sitePrefix}$2"`)
    .replace(/(src|href|action)=(["'])(\/api\/[^"']+)\2/gi, `$1=$2${sitePrefix}$3$2`)
    
    // Root assets (images, fonts, icons, CSS, JS) - must be before catch-all
    .replace(/(src|href)=(["'])(\/([^"?#\/]+\.(png|svg|ico|jpg|jpeg|webp|gif|woff|woff2|ttf|eot|otf|css|js))(\?[^"]*)?)\2/gi, 
      `$1=$2${sitePrefix}$3$2`)
    
    // Font files in CSS
    .replace(/url\(\s*(["']?)(\/fonts\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    .replace(/url\(\s*(["']?)(\/assets\/fonts\/[^"')]+)\1\s*\)/gi, `url(${sitePrefix}$2)`)
    
    // WebSocket connections
    .replace(/(ws|wss):\/\/[^/]+(\/[^"'\s)]+)/g, `$1://${req.headers.host}${sitePrefix}$2`)
    
    // Catch-all for any absolute path (but not external URLs or already prefixed)
    .replace(/(src|href|action)=(["'])(\/(?!vpn\/|http|https|\/\/)[^"']+)\2/gi, 
      (match, attr, quote, path) => {
        // Skip if already has /vpn/ prefix
        if (path.startsWith('/vpn/')) return match;
        // Skip external URLs
        if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) return match;
        return `${attr}=${quote}${sitePrefix}${path}${quote}`;
      });
  
  return body;
}

module.exports = {
  createNeocoreProxy,
  createDevicesProxy
};
