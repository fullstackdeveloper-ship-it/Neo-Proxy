/**
 * VPN Proxy Service - Main Entry Point
 */

const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const SITES = require("./config/sites");
const { registerAllRoutes } = require("./services/routeManager");

const app = express();
const server = http.createServer(app);

// Attach server to app for WebSocket support
app.set('server', server);

// Cookie parser middleware (for site tracking)
app.use(cookieParser());

// Request logging
app.use((req, res, next) => {
  console.log(`🌐 ${req.method} ${req.url} | ${req.ip || 'unknown'}`);
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    architecture: "OpenVPN-based site-to-site routing",
    sites: Object.values(SITES).map(site => ({
      name: site.name,
      vpnIp: site.vpnIp,              // VPN transport IP (10.9.0.x)
      neocore: { 
        enabled: site.neocore?.enabled || false, 
        target: site.neocore?.target 
      },
      devices: { 
        enabled: site.devices?.enabled || false,
        deviceCount: site.devices?.deviceList ? Object.keys(site.devices.deviceList).length : 0,
        deviceList: site.devices?.deviceList ? Object.entries(site.devices.deviceList).map(([id, config]) => ({
          id,
          name: config.name || id,
          virtualIp: config.virtualIp,
          target: config.target
        })) : []
      }
    }))
  });
});

// Backend connectivity test endpoint
app.get("/test-backend/:siteName", async (req, res) => {
  const siteName = req.params.siteName;
  const site = SITES[siteName];
  
  if (!site || !site.neocore?.enabled) {
    return res.status(404).json({ error: "Site not found or not enabled" });
  }
  
  const http = require('http');
  const url = require('url');
  const targetUrl = url.parse(site.neocore.target);
  
  // Test HTTP connectivity
  const testHttp = () => {
    return new Promise((resolve) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: '/api/health',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        resolve({ success: true, statusCode: res.statusCode });
      });
      
      req.on('error', (err) => {
        resolve({ success: false, error: err.message, code: err.code });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      });
      
      req.end();
    });
  };
  
  // Test WebSocket endpoint (socket.io polling)
  const testSocketIO = () => {
    return new Promise((resolve) => {
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: '/socket.io/?EIO=4&transport=polling',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        resolve({ success: true, statusCode: res.statusCode });
      });
      
      req.on('error', (err) => {
        resolve({ success: false, error: err.message, code: err.code });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      });
      
      req.end();
    });
  };
  
  const [httpTest, socketIOTest] = await Promise.all([testHttp(), testSocketIO()]);
  
  res.json({
    site: siteName,
    target: site.neocore.target,
    vpnIp: site.vpnIp,
    tests: {
      http: httpTest,
      socketIO: socketIOTest
    },
    status: httpTest.success && socketIOTest.success ? 'healthy' : 'unhealthy'
  });
});

// Graceful shutdown
const shutdown = () => {
  console.log("🛑 Shutting down gracefully...");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Initialize
const PORT = process.env.PORT || 3003;
const HOST = process.env.HOST || "0.0.0.0";

registerAllRoutes(app, SITES, server);

server.listen(PORT, HOST, () => {
  console.log(`\n✅ VPN Proxy Service → http://${HOST}:${PORT}\n`);
  console.log(`   📡 Architecture: OpenVPN-based site-to-site routing (SRS compliant)\n`);
  Object.values(SITES).forEach(s => {
    if (s.neocore?.enabled) {
      console.log(`   🌐 /vpn/${s.name}/neocore → ${s.neocore.target} (VPN IP: ${s.vpnIp})`);
    }
    if (s.devices?.enabled && s.devices.deviceList) {
      const deviceCount = Object.keys(s.devices.deviceList).length;
      console.log(`   🔧 /vpn/${s.name}/devices/* → ${deviceCount} device(s) configured`);
      Object.entries(s.devices.deviceList).forEach(([deviceId, deviceConfig]) => {
        console.log(`      └─ /vpn/${s.name}/devices/${deviceId} → ${deviceConfig.target} (${deviceConfig.name || deviceId})`);
      });
    }
  });
  console.log(`   ❤️  /health\n`);
});
