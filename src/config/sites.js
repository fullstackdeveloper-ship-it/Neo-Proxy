/**
 * Site Configuration
 * Add your sites here - each site can have neocore and devices
 */

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
      socksPort: 1080,
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
      target: "http://192.168.161.243",  // Different device IP
    }
  }
  
  // Add more sites as needed
  // site3: { ... }
};

module.exports = SITES;
