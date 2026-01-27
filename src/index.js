/**
 * VPN Proxy Service - Main Entry Point
 */

const express = require("express");
const http = require("http");
const SITES = require("./config/sites");
const { initializeTunnels, shutdownAllTunnels } = require("./services/tunnelManager");
const { registerAllRoutes } = require("./services/routeManager");

const app = express();
const server = http.createServer(app);

// Attach server to app for WebSocket support
app.set('server', server);

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
    sites: Object.values(SITES).map(site => ({
      name: site.name,
      vpnIp: site.vpnIp,
      neocore: { enabled: site.neocore?.enabled || false, target: site.neocore?.target },
      devices: { enabled: site.devices?.enabled || false, tunnelReady: site.devices?.tunnelReady || false }
    }))
  });
});

// Graceful shutdown
const shutdown = () => {
  console.log("🛑 Shutting down gracefully...");
  shutdownAllTunnels(SITES);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Initialize
const PORT = process.env.PORT || 3003;
const HOST = process.env.HOST || "0.0.0.0";

initializeTunnels(SITES);
registerAllRoutes(app, SITES, server);

server.listen(PORT, HOST, () => {
  console.log(`\n✅ VPN Proxy Service → http://${HOST}:${PORT}\n`);
  Object.values(SITES).forEach(s => {
    if (s.neocore?.enabled) {
      console.log(`   🌐 /vpn/${s.name}/neocore → ${s.neocore.target}`);
    }
    if (s.devices?.enabled) {
      console.log(`   🔧 /vpn/${s.name}/devices → ${s.devices.target} (SOCKS:${s.devices.socksPort})`);
    }
  });
  console.log(`   ❤️  /health\n`);
});
