# OpenVPN Migration Plan - 10 Steps

## Overview
Migrating from SSH SOCKS tunnels to OpenVPN routing for device access.

**Current Setup:**
- Device: `192.168.161.242` (local device)
- NeoCore VPN IP: `10.9.0.5` (current VPN IP)
- Access Method: SSH SOCKS tunnel (port 1080)

**Target Setup:**
- Device: `192.168.161.242` (local device - unchanged)
- NeoCore Virtual IP: `172.16.2.100` (from OpenVPN server)
- Access Method: Direct HTTP proxy via OpenVPN routing

---

## Step 1: OpenVPN Server Setup

### 1.1 Install OpenVPN Server (if not already installed)
```bash
sudo apt update
sudo apt install openvpn easy-rsa
```

### 1.2 Configure OpenVPN Server
Create server config: `/etc/openvpn/server/server.conf`

```conf
port 1194
proto udp
dev tun

# Certificate files
ca /etc/openvpn/server/ca.crt
cert /etc/openvpn/server/server.crt
key /etc/openvpn/server/server.key
dh /etc/openvpn/server/dh.pem

# Virtual network (172.16.0.0/16)
server 172.16.0.0 255.255.0.0

# Client Configuration Directory (CCD)
client-config-dir /etc/openvpn/server/ccd

# Push routes to clients
push "route 172.16.0.0 255.255.0.0"

# Enable IP forwarding
push "redirect-gateway def1 bypass-dhcp"

# DNS (optional)
push "dhcp-option DNS 8.8.8.8"

# Keepalive
keepalive 10 120

# Logging
log /var/log/openvpn/server.log
status /var/log/openvpn/status.log

# Security
user nobody
group nogroup
persist-key
persist-tun

# Compression
comp-lzo

# Verbosity
verb 3
```

### 1.3 Create CCD Directory
```bash
sudo mkdir -p /etc/openvpn/server/ccd
```

### 1.4 Create CCD File for site1 (NeoCore at 10.9.0.5)
Create file: `/etc/openvpn/server/ccd/site1-client`

```conf
# Virtual IP for site1 NeoCore edge device
ifconfig-push 172.16.2.100 172.16.2.1

# Route to device network (192.168.161.0/24)
iroute 192.168.161.0 255.255.255.0
```

**Note:** `site1-client` should match the Common Name (CN) in the client certificate.

### 1.5 Enable IP Forwarding
```bash
sudo sysctl -w net.ipv4.ip_forward=1
sudo echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
```

### 1.6 Start OpenVPN Server
```bash
sudo systemctl enable openvpn-server@server
sudo systemctl start openvpn-server@server
sudo systemctl status openvpn-server@server
```

---

## Step 2: NeoCore Edge Device OpenVPN Client Setup

### 2.1 Install OpenVPN Client (on NeoCore device at 10.9.0.5)
```bash
sudo apt update
sudo apt install openvpn
```

### 2.2 Create Client Config
Create file: `/etc/openvpn/client/site1-client.conf`

```conf
client
dev tun
proto udp
remote YOUR_OPENVPN_SERVER_IP 1194

# Certificate files (copy from server)
ca /etc/openvpn/client/ca.crt
cert /etc/openvpn/client/site1-client.crt
key /etc/openvpn/client/site1-client.key

# Security
nobind
persist-key
persist-tun

# Compression
comp-lzo

# Verbosity
verb 3
```

### 2.3 Copy Certificates
Copy these files from OpenVPN server to NeoCore device:
- `ca.crt`
- `site1-client.crt`
- `site1-client.key`

Place them in `/etc/openvpn/client/`

### 2.4 Start OpenVPN Client
```bash
sudo systemctl enable openvpn-client@site1-client
sudo systemctl start openvpn-client@site1-client
sudo systemctl status openvpn-client@site1-client
```

### 2.5 Verify Virtual IP Assignment
```bash
# On NeoCore device, check if virtual IP is assigned
ip addr show tun0
# Should show: 172.16.2.100
```

---

## Step 3: NAT/DNAT Rules on NeoCore Edge Device

### 3.1 Enable IP Forwarding (on NeoCore device)
```bash
sudo sysctl -w net.ipv4.ip_forward=1
sudo echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
```

### 3.2 Configure NAT Rules (on NeoCore device)
```bash
# DNAT: Forward incoming traffic from virtual IP to device
sudo iptables -t nat -A PREROUTING -d 172.16.2.100 -p tcp --dport 80 -j DNAT --to-destination 192.168.161.242:80
sudo iptables -t nat -A PREROUTING -d 172.16.2.100 -p tcp --dport 443 -j DNAT --to-destination 192.168.161.242:443

# SNAT: Masquerade return traffic
sudo iptables -t nat -A POSTROUTING -s 192.168.161.242 -j MASQUERADE

# Forward traffic between interfaces
sudo iptables -A FORWARD -i tun0 -o eth0 -d 192.168.161.242 -j ACCEPT
sudo iptables -A FORWARD -i eth0 -o tun0 -s 192.168.161.242 -j ACCEPT
```

### 3.3 Make Rules Persistent
```bash
# Install iptables-persistent
sudo apt install iptables-persistent

# Save current rules
sudo iptables-save > /etc/iptables/rules.v4
```

### 3.4 Test NAT Rules
```bash
# From OpenVPN server, test connectivity
ping 172.16.2.100
curl http://172.16.2.100
```

---

## Step 4: Update Site Configuration

### 4.1 Update `src/config/sites.js`

**Before (SSH SOCKS):**
```javascript
devices: {
  enabled: true,
  socksPort: 1080,
  target: "http://192.168.161.242",
}
```

**After (OpenVPN Direct):**
```javascript
devices: {
  enabled: true,
  virtualIp: "172.16.2.100",  // OpenVPN virtual IP
  target: "http://172.16.2.100",  // Direct access via virtual IP
}
```

**Complete updated config:**
```javascript
const SITES = {
  site1: {
    name: "site1",
    vpnIp: "10.9.0.5",  // Original VPN IP (for reference)
    virtualIp: "172.16.2.100",  // OpenVPN virtual IP
    neocore: {
      enabled: true,
      target: "http://10.9.0.5:80",  // Neocore still uses original VPN IP
    },
    devices: {
      enabled: true,
      virtualIp: "172.16.2.100",  // OpenVPN virtual IP for devices
      target: "http://172.16.2.100",  // Direct access via OpenVPN
    }
  },
  
  site2: {
    name: "site2",
    vpnIp: "10.9.0.2",
    virtualIp: "172.16.2.101",  // Different virtual IP for site2
    neocore: {
      enabled: true,
      target: "http://10.9.0.2:80",
    },
    devices: {
      enabled: true,
      virtualIp: "172.16.2.101",
      target: "http://172.16.2.101",
    }
  }
};
```

---

## Step 5: Remove Tunnel Manager

### 5.1 Delete `src/services/tunnelManager.js`
This file is no longer needed as OpenVPN handles tunneling automatically.

### 5.2 Remove from `src/index.js`
Remove tunnel manager imports and initialization.

---

## Step 6: Simplify Proxy Factory

### 6.1 Remove SOCKS Agent Code
Remove `createSocksAgent()` function and SOCKS-related imports.

### 6.2 Simplify `createDevicesProxy()`
Remove:
- `tunnelCheck` middleware (no tunnel readiness check needed)
- `agent: createSocksAgent(...)` from proxy config
- `socksPort` references
- `tunnelReady` checks

**New simplified version:**
```javascript
function createDevicesProxy(site) {
  if (!site.devices || !site.devices.enabled) return null;

  const proxy = createProxyMiddleware({
    target: site.devices.target,  // Direct virtual IP
    changeOrigin: true,
    ws: true,
    xfwd: true,
    secure: false,
    timeout: 30000,
    proxyTimeout: 30000,
    pathRewrite: {
      [`^/vpn/${site.name}/devices`]: ""
    },
    // ... rest of config (error handlers, etc.)
  });

  return proxy;  // Return proxy directly, no middleware array
}
```

---

## Step 7: Update Route Manager

### 7.1 Remove Tunnel Checks
In `registerDevicesRoutes()`, remove:
- `tunnelCheck` middleware calls
- `tunnelReady` checks

### 7.2 Simplify Device Route Registration
```javascript
function registerDevicesRoutes(app, allSites) {
  Object.values(allSites).forEach(site => {
    if (site.devices?.enabled) {
      const proxy = createDevicesProxy(site);
      if (proxy) {
        app.use(`/vpn/${site.name}/devices`, proxy);
      }
    }
  });
  
  // Device-specific file patterns (unchanged)
  // ...
}
```

---

## Step 8: Update Main Entry Point

### 8.1 Remove Tunnel Initialization
In `src/index.js`, remove:
- `initializeTunnels(SITES)` call
- `shutdownAllTunnels(SITES)` call
- Tunnel manager imports

### 8.2 Update Health Check
Remove `tunnelReady` from health check response.

---

## Step 9: Remove Dependencies

### 9.1 Update `package.json`
Remove:
```json
"socks-proxy-agent": "^..."
```

### 9.2 Run npm install
```bash
npm install
```

---

## Step 10: Test & Verify

### 10.1 Test OpenVPN Connection
```bash
# On NeoCore device
sudo systemctl status openvpn-client@site1-client
ip addr show tun0  # Should show 172.16.2.100
```

### 10.2 Test Device Access via Virtual IP
```bash
# From proxy server
curl http://172.16.2.100
```

### 10.3 Test Proxy Service
```bash
# Start proxy service
npm start

# Test device access
curl http://localhost:3003/vpn/site1/devices
```

### 10.4 Verify Health Check
```bash
curl http://localhost:3003/health
```

### 10.5 Test in Browser
```
http://YOUR_PROXY_IP:3003/vpn/site1/devices
```

---

## Summary of Changes

### Files to Delete:
- `src/services/tunnelManager.js` ❌

### Files to Modify:
- `src/config/sites.js` ✏️ (update config)
- `src/services/proxyFactory.js` ✏️ (remove SOCKS code)
- `src/services/routeManager.js` ✏️ (remove tunnel checks)
- `src/index.js` ✏️ (remove tunnel init)
- `package.json` ✏️ (remove socks-proxy-agent)

### Code Reduction:
- **Before:** ~500+ lines
- **After:** ~200 lines
- **Reduction:** ~300 lines removed! 🎉

---

## Benefits After Migration

✅ **Simpler Code:** No tunnel management  
✅ **Better Performance:** Direct routing  
✅ **More Reliable:** OpenVPN handles reconnection  
✅ **Easier Maintenance:** Config-based setup  
✅ **Better Scalability:** Add sites via config only  

---

## Troubleshooting

### Issue: Virtual IP not assigned
- Check OpenVPN client status: `sudo systemctl status openvpn-client@site1-client`
- Verify CCD file matches client certificate CN
- Check OpenVPN server logs: `sudo tail -f /var/log/openvpn/server.log`

### Issue: Device not accessible via virtual IP
- Verify NAT rules: `sudo iptables -t nat -L -n -v`
- Test connectivity: `ping 172.16.2.100`
- Check IP forwarding: `sysctl net.ipv4.ip_forward`

### Issue: Proxy returns 502 error
- Verify device target URL in config
- Check OpenVPN connection status
- Test direct access: `curl http://172.16.2.100`

---

## Next Steps After Migration

1. ✅ Test all device endpoints
2. ✅ Monitor OpenVPN connection stability
3. ✅ Update documentation
4. ✅ Remove old SSH tunnel code completely
5. ✅ Add monitoring for OpenVPN status
