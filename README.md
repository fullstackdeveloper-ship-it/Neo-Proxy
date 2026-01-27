# VPN Proxy Service

Production-ready dynamic multi-site proxy service for Neocore and local devices.

## Features

- **Dynamic Multi-Site Support**: Add unlimited sites via configuration
- **Neocore Proxy**: Direct VPN port 80 access for each site
- **Devices Proxy**: SOCKS tunnel via OpenVPN for local devices
- **Complete Resource Handling**: Assets, API, fonts, CSS, JS all properly rewritten
- **Site Isolation**: Each site's data is completely isolated
- **Health Check Endpoint**: `/health` for monitoring
- **Graceful Shutdown**: Proper cleanup on SIGTERM/SIGINT
- **Auto-reconnect**: SOCKS tunnels automatically restart on failure

## Project Structure

```
vpn-proxy/
├── src/
│   ├── index.js                 # Main entry point
│   ├── config/
│   │   └── sites.js            # Site configuration
│   └── services/
│       ├── tunnelManager.js    # SOCKS tunnel management
│       ├── proxyFactory.js     # Proxy middleware creation
│       └── routeManager.js     # Route registration
├── package.json
└── README.md
```

## Installation

```bash
npm install
```

## Configuration

Edit `src/config/sites.js` to add your sites:

```javascript
const SITES = {
  site1: {
    name: "site1",
    vpnIp: "10.9.0.5",
    sshUser: "trinity",
    neocore: {
      enabled: true,
      target: "http://10.9.0.5:80",  // Neocore on VPN IP port 80
    },
    devices: {
      enabled: true,
      socksPort: 1080,  // Unique port for each site
      target: "http://192.168.161.242",  // Local device behind VPN
    }
  },
  
  site2: {
    name: "site2",
    vpnIp: "10.9.0.2",
    sshUser: "trinity",
    neocore: {
      enabled: true,
      target: "http://10.9.0.2:80",
    },
    devices: {
      enabled: true,
      socksPort: 1081,  // Different port for each site
      target: "http://192.168.161.243",
    }
  }
};
```

## Usage

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev

# With custom port
PORT=8080 npm start

# Debug mode (logs all requests)
DEBUG=1 npm start
```

## Endpoints

For each site configured:

- `/vpn/{site-name}/neocore/*` → Neocore (direct VPN port 80)
- `/vpn/{site-name}/devices/*` → Local devices (via SOCKS tunnel)
- `/health` → Health check endpoint

## Example URLs

If you have `site1` and `site2` configured:

- **Site1 Neocore**: `http://localhost:3003/vpn/site1/neocore`
- **Site1 Devices**: `http://localhost:3003/vpn/site1/devices`
- **Site2 Neocore**: `http://localhost:3003/vpn/site2/neocore`
- **Site2 Devices**: `http://localhost:3003/vpn/site2/devices`

## Environment Variables

- `PORT` - Server port (default: 3003)
- `HOST` - Server host (default: 0.0.0.0)
- `DEBUG` - Enable request logging (set to 1)

## Resource Rewriting

The service automatically rewrites:
- Static assets (`/static/*`)
- API endpoints (`/api/*`)
- Images, fonts, icons
- CSS and JavaScript files
- WebSocket connections

All paths are prefixed with `/vpn/{site-name}` to maintain proper routing and site isolation.

## Site Isolation

Each site is completely isolated:
- Separate SOCKS tunnels (different ports)
- Separate proxy targets
- No data leakage between sites
- Independent tunnel management

## Adding New Sites

1. Edit `src/config/sites.js`
2. Add a new site object with unique:
   - `name`: Site identifier
   - `vpnIp`: VPN IP address
   - `socksPort`: Unique SOCKS port (must be different for each site)
   - `target`: Target URL for neocore/devices
3. Restart the service

## Troubleshooting

- **Port already in use**: The service automatically kills existing processes on the SOCKS port
- **Tunnel not ready**: Wait a few seconds after startup for tunnels to establish
- **404 errors**: Check that the site name in URL matches the config
- **Connection refused**: Verify VPN IP and SSH credentials
