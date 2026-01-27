/**
 * SOCKS Tunnel Manager
 * Manages SSH SOCKS tunnels for each site's devices
 */

const { spawn, exec } = require("child_process");
const net = require("net");

/**
 * Kill existing process on port
 */
function killProcessOnPort(port, callback) {
  exec(`lsof -ti:${port}`, (err, stdout) => {
    if (err || !stdout) {
      return callback();
    }
    const pids = stdout.trim().split('\n').filter(Boolean);
    if (pids.length > 0) {
      console.log(`🔪 Killing existing process on port ${port}...`);
      exec(`kill -9 ${pids.join(' ')}`, callback);
    } else {
      callback();
    }
  });
}

/**
 * Wait for port to be available
 */
function waitForPort(port, maxAttempts = 20, callback) {
  let attempts = 0;
  const check = () => {
    attempts++;
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      callback(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      if (attempts >= maxAttempts) {
        callback(false);
      } else {
        setTimeout(check, 500);
      }
    });
    socket.once('error', () => {
      if (attempts >= maxAttempts) {
        callback(false);
      } else {
        setTimeout(check, 500);
      }
    });
    socket.connect(port, '127.0.0.1');
  };
  check();
}

/**
 * Start SOCKS tunnel for a site's devices
 */
function startSocksTunnel(site) {
  if (!site.devices || !site.devices.enabled) return;
  if (site.devices.ssh && !site.devices.ssh.killed) return;

  const socksPort = site.devices.socksPort;
  const vpnIp = site.vpnIp;
  const sshUser = site.sshUser;

  // Kill existing process on port if any
  killProcessOnPort(socksPort, () => {
    console.log(`🔐 Starting SOCKS tunnel → ${site.name} (${vpnIp}:${socksPort})`);

    site.devices.ssh = spawn("ssh", [
      "-N",
      "-D", `127.0.0.1:${socksPort}`,
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${sshUser}@${vpnIp}`
    ], { stdio: "inherit" });

    site.devices.ssh.on("error", (err) => {
      console.error(`❌ SSH tunnel error (${site.name}):`, err.message);
      site.devices.ssh = null;
      site.devices.tunnelReady = false;
      setTimeout(() => startSocksTunnel(site), 5000);
    });

    site.devices.ssh.on("exit", (code) => {
      if (code !== 0) {
        console.log(`⚠️ Tunnel closed (${site.name}, code: ${code}) — restarting in 5s`);
      }
      site.devices.ssh = null;
      site.devices.tunnelReady = false;
      setTimeout(() => startSocksTunnel(site), 5000);
    });

    // Wait for tunnel to be ready
    site.devices.tunnelReady = false;
    waitForPort(socksPort, 20, (ready) => {
      if (ready && site.devices.ssh && !site.devices.ssh.killed) {
        site.devices.tunnelReady = true;
        console.log(`✅ SOCKS tunnel ready → ${site.name}`);
      } else {
        site.devices.tunnelReady = false;
        console.error(`❌ SOCKS tunnel failed to start → ${site.name}`);
      }
    });
  });
}

/**
 * Stop SOCKS tunnel for a site
 */
function stopSocksTunnel(site) {
  if (site.devices && site.devices.ssh && !site.devices.ssh.killed) {
    site.devices.ssh.kill();
    site.devices.ssh = null;
    site.devices.tunnelReady = false;
  }
}

/**
 * Initialize tunnels for all sites
 */
function initializeTunnels(sites) {
  Object.values(sites).forEach(site => {
    if (site.devices && site.devices.enabled) {
      startSocksTunnel(site);
    }
  });
}

/**
 * Shutdown all tunnels
 */
function shutdownAllTunnels(sites) {
  Object.values(sites).forEach(site => {
    stopSocksTunnel(site);
  });
}

module.exports = {
  startSocksTunnel,
  stopSocksTunnel,
  initializeTunnels,
  shutdownAllTunnels
};
