const dgram = require('dgram');

const SSDP_MULTICAST_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGET = 'urn:schemas-denon-com:device:ACT-Denon:1';

/**
 * Discover HEOS speakers on the LAN via SSDP multicast.
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Array<{ip: string, location: string}>>}
 */
function discoverHeosSpeakers(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const searchMessage = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: ' + SSDP_MULTICAST_ADDR + ':' + SSDP_PORT + '\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: ' + SEARCH_TARGET + '\r\n\r\n'
    );

    let closed = false;

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (text.includes(SEARCH_TARGET) || text.toLowerCase().includes('denon')) {
        const locationMatch = text.match(/LOCATION:\s*(.+)/i);
        found.set(rinfo.address, {
          ip: rinfo.address,
          location: locationMatch ? locationMatch[1].trim() : ''
        });
      }
    });

    socket.on('error', (err) => {
      console.error('[SSDP] Socket error:', err.message);
      if (closed) return;
      closed = true;
      socket.close();
      // Return whatever we'd already collected, not an empty list — on a flaky
      // multicast socket we may have received one response before the error.
      resolve(Array.from(found.values()));
    });

    socket.bind(() => {
      try {
        socket.addMembership(SSDP_MULTICAST_ADDR);
      } catch (e) {
        console.error('[SSDP] Failed to join multicast group:', e.message);
      }
      try {
        socket.send(searchMessage, 0, searchMessage.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
      } catch (e) {
        console.error('[SSDP] Send failed:', e.message);
      }

      // Send a second search after 1s for reliability
      setTimeout(() => {
        if (closed) return;
        try {
          socket.send(searchMessage, 0, searchMessage.length, SSDP_PORT, SSDP_MULTICAST_ADDR);
        } catch (e) {
          console.error('[SSDP] Second send failed:', e.message);
        }
      }, 1000);
    });

    setTimeout(() => {
      if (!closed) { closed = true; socket.close(); }
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}

module.exports = { discoverHeosSpeakers };
