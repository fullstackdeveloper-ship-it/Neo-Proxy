/**
 * Site Configuration (static fallback)
 * New shape: multiple neocores per site, multiple devices per site
 * URL: /vpn/{site}/neocore/{neocoreId}, /vpn/{site}/devices/{deviceId}
 * Port 80 for HTTP, 5001 for WebSocket (fixed)
 */

const SITES = {
  site1: {
    name: 'site1',
    siteName: 'Site 1',
    neocores: {
      '0': {
        target: 'http://10.9.0.5:80',
        wsTarget: 'http://10.9.0.5:5001',
        name: 'NeoCore 0',
      },
      '1': {
        target: 'http://10.9.0.2:80',
        wsTarget: 'http://10.9.0.2:5001',
        name: 'NeoCore 1',
      },
    },
    devices: {
      enabled: true,
      deviceList: {
        device1: {
          name: 'Edge Device',
          virtualIp: '172.16.2.100',
          target: 'http://172.16.2.100:80',
        },
        device2: {
          name: 'Device 2',
          virtualIp: '172.16.2.101',
          target: 'http://172.16.2.101:80',
        },
      },
    },
  },

  site2: {
    name: 'site2',
    siteName: 'Site 2',
    neocores: {
      '0': {
        target: 'http://10.9.0.2:80',
        wsTarget: 'http://10.9.0.2:5001',
        name: 'NeoCore 0',
      },
    },
    devices: {
      enabled: true,
      deviceList: {
        device1: {
          name: 'Device 1',
          virtualIp: '172.16.3.100',
          target: 'http://172.16.3.100:80',
        },
      },
    },
  },
};

module.exports = SITES;
