/**
 * VPN Proxy Service - Main Entry Point
 * Dynamic multi-site proxy service for Neocore and local devices
 */

const express = require("express");
const SITES = require("./config/sites");
const { initializeTunnels, shutdownAllTunnels } = require("./services/tunnelManager");
const { registerAllRoutes } = require("./services/routeManager");

const app = express();

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (req, res) => {
  const status = {
    status: "ok",
    timestamp: new Date().toISOString(),
    sites: Object.values(SITES).map(site => ({
      name: site.name,
      vpnIp: site.vpnIp,
      neocore: {
        enabled: site.neocore?.enabled || false,
        target: site.neocore?.target
      },
      devices: {
        enabled: site.devices?.enabled || false,
        tunnelReady: site.devices?.tunnelReady || false,
        socksPort: site.devices?.socksPort
      }
    }))
  };
  res.json(status);
});

/* =========================
   REGISTER ALL ROUTES
========================= */

registerAllRoutes(app, SITES);

/* =========================
   GRACEFUL SHUTDOWN
========================= */

process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  shutdownAllTunnels(SITES);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  shutdownAllTunnels(SITES);
  process.exit(0);
});

/* =========================
   SERVER START
========================= */

const PORT = process.env.PORT || 3003;
const HOST = process.env.HOST || "0.0.0.0";

// Initialize SOCKS tunnels for all sites
initializeTunnels(SITES);

app.listen(PORT, HOST, () => {
  console.log(`\n✅ VPN Proxy Service running → http://${HOST}:${PORT}`);
  console.log(`\n📋 Available Sites:`);
  Object.values(SITES).forEach(s => {
    console.log(`\n   🏢 Site: ${s.name} (VPN: ${s.vpnIp})`);
    if (s.neocore?.enabled) {
      console.log(`      🌐 /vpn/${s.name}/neocore → ${s.neocore.target}`);
    }
    if (s.devices?.enabled) {
      console.log(`      🔧 /vpn/${s.name}/devices → ${s.devices.target} (SOCKS:${s.devices.socksPort})`);
    }
  });
  console.log(`\n   ❤️  /health → Health check endpoint\n`);
});
