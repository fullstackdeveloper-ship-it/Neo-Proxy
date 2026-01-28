/**
 * Site Configuration
 * According to SRS: OpenVPN-based site-to-site architecture
 * 
 * URL Structure:
 * - /vpn/{site}/neocore              → NeoCore hardware services
 * - /vpn/{site}/devices/{deviceId}   → Local devices (multiple per site)
 * 
 * Addressing Model:
 * - VPN Transport: 10.9.0.0/24 (VPN tunnel IPs)
 * - Virtual Routed Networks: 172.16.0.0/12 (per-site virtual IPs for device access)
 * 
 * Each site:
 * - vpnIp: VPN transport IP (10.9.0.x) - for NeoCore services
 * - devices.deviceList: Object with multiple devices, each with virtual IP
 */

const SITES = {
  site1: {
    name: "site1",
    vpnIp: "10.9.0.5",           // VPN transport IP (from 10.9.0.0/24)
    neocore: {
      enabled: true,
      target: "http://10.9.0.5:80",  // NeoCore services on VPN IP port 80 (nginx)
      wsTarget: "http://10.9.0.5:5001",  // Direct WebSocket connection to backend (bypass nginx)
      // Routes: /vpn/site1/neocore/*
    },
    devices: {
      enabled: true,
      // Multiple devices per site
      // Routes: /vpn/site1/devices/{deviceId}/*
      deviceList: {
        device1: {
          name: "Edge Device",
          virtualIp: "172.16.2.100",        // Virtual IP (routed via OpenVPN)
          target: "http://172.16.2.100",    // Proxy target (virtual IP)
          actualIp: "192.168.161.242",      // Actual device IP (behind NeoCore)
          // NeoCore DNAT rule required:
          // iptables -t nat -A PREROUTING -i tun0 -d 172.16.2.100 -p tcp --dport 80 -j DNAT --to-destination 192.168.161.242:80
        },
        device2: {
          name: "Device 2",
          virtualIp: "172.16.2.101",
          target: "http://172.16.2.101",
          actualIp: "192.168.161.243",
          // NeoCore DNAT rule: 172.16.2.101:80 -> 192.168.161.243:80
        }
      }
    }
  },
  
  site2: {
    name: "site2",
    vpnIp: "10.9.0.2",           // VPN transport IP
    neocore: {
      enabled: true,
      target: "http://10.9.0.2:80",
      wsTarget: "http://10.9.0.2:5001",  // Direct WebSocket connection to backend
      // Routes: /vpn/site2/neocore/*
    },
    devices: {
      enabled: true,
      deviceList: {
        device1: {
          name: "Device 1",
          virtualIp: "172.16.3.100",
          target: "http://172.16.3.100",
          // NeoCore DNAT rule: 172.16.3.100:80 -> 192.168.161.244:80
        }
      }
    }
  }
  
  // Add more sites as needed
  // site3: {
  //   name: "site3",
  //   vpnIp: "10.9.0.10",
  //   neocore: { enabled: true, target: "http://10.9.0.10:80" },
  //   devices: {
  //     enabled: true,
  //     deviceList: {
  //       device1: { name: "Device 1", virtualIp: "172.16.4.100", target: "http://172.16.4.100" }
  //     }
  //   }
  // }
};

module.exports = SITES;
