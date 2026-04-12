const net = require('net');

// --- HEOS Message Helpers ---

function parseHeosMessage(messageString) {
  if (!messageString) return {};
  const params = {};
  for (const pair of messageString.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      params[pair] = '';
      continue;
    }
    params[pair.substring(0, eqIndex)] = decodeURIComponent(pair.substring(eqIndex + 1));
  }
  return params;
}

function heosEncode(value) {
  return String(value)
    .replace(/%/g, '%25')   // % first to avoid double-encoding
    .replace(/&/g, '%26')
    .replace(/=/g, '%3D');
}

// --- TCP Response Parser ---

class ResponseParser {
  constructor() {
    this.buffer = '';
  }

  put(data) {
    this.buffer += data;
    const lines = this.buffer.split('\r\n');
    // Last element: '' if data ended with \r\n, or incomplete fragment
    this.buffer = lines.pop();

    const messages = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        // Skip ONLY this bad line. Do NOT flush the buffer.
        console.error('[HEOS] Failed to parse:', line.substring(0, 100));
      }
    }
    return messages;
  }

  reset() {
    this.buffer = '';
  }
}

// --- HEOS Client ---

class HeosClient {
  constructor(eventCallback) {
    this.socket = null;
    this.parser = new ResponseParser();
    this.queue = [];          // [{ command, resolve, reject, timeoutId, retries, enqueuedAt, matchKey }]
    this.pending = null;      // Currently in-flight command entry (or null)
    this.connected = false;
    this.connecting = false;
    this.ip = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this._retryTimer = null;
    this._retryEntry = null;       // Entry in-limbo during retry delay
    this.eventCallback = eventCallback;

    // Init promise (resolved when TCP connect completes; Phase 2 extends to full init sequence)
    this.initPromise = Promise.resolve();
    this._initResolve = null;
    this._initReject = null;
  }

  // --- TCP Connection Lifecycle ---

  connect(ip) {
    // Validate IPv4 format
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      console.error('[HEOS] Invalid IP address:', ip);
      return;
    }
    const octets = ip.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      console.error('[HEOS] Invalid IP address (octet out of range):', ip);
      return;
    }

    // Guard: already connected to this IP
    if (this.connected && this.ip === ip) return;
    // Guard: already connecting
    if (this.connecting && this.ip === ip) return;

    // If connected/connecting to a DIFFERENT IP, disconnect first
    if (this.connected || this.connecting) {
      this.disconnect();
    }

    this.connecting = true;
    this.ip = ip;
    this.parser.reset();

    // Create init promise for this connection attempt
    this.initPromise = new Promise((resolve, reject) => {
      this._initResolve = resolve;
      this._initReject = reject;
    });

    this.socket = new net.Socket();
    this.socket.setTimeout(5000); // Connection timeout

    this.socket.on('connect', () => {
      console.log('[HEOS] Connected to', ip);
      this.connected = true;
      this.connecting = false;
      this.socket.setTimeout(0); // Clear connection timeout; heartbeat handles idle detection
      this.reconnectDelay = 1000; // Reset backoff
      this.startHeartbeat();

      // Phase 1: resolve init immediately. Phase 2 adds runInitSequence() here.
      if (this._initResolve) {
        this._initResolve();
        this._initResolve = null;
        this._initReject = null;
      }

      this.sendNext(); // Drain any queued commands
    });

    this.socket.on('data', (data) => {
      const messages = this.parser.put(data.toString());
      for (const msg of messages) {
        this.routeMessage(msg);
      }
    });

    this.socket.on('error', (err) => {
      console.error('[HEOS] Socket error:', err.message);
      // Do NOT reconnect here -- the close event follows
    });

    this.socket.on('close', () => {
      console.log('[HEOS] Connection closed');
      this.connected = false;
      this.connecting = false;
      this.stopHeartbeat();
      this.rejectPending('Connection closed');

      // Reject init promise if still pending
      if (this._initReject) {
        this._initReject(new Error('Connection closed'));
        this._initResolve = null;
        this._initReject = null;
      }

      this.scheduleReconnect();
    });

    this.socket.on('timeout', () => {
      console.error('[HEOS] Connection timeout');
      this.socket.destroy();
    });

    this.socket.connect(1255, ip);
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._retryEntry) {
      this._retryEntry.reject(new Error('Disconnected'));
      this._retryEntry = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;

    // Reject init promise if still pending
    if (this._initReject) {
      this._initReject(new Error('Disconnected'));
      this._initResolve = null;
      this._initReject = null;
    }

    // Reject pending command
    this.rejectPending('Disconnected');

    // Reject all queued commands
    for (const entry of this.queue) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error('Disconnected'));
    }
    this.queue = [];
  }

  reconnect() {
    if (!this.ip) return;
    const ip = this.ip;
    this.disconnect();
    this.connect(ip);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;   // already scheduled
    if (!this.ip) return;              // no IP configured
    console.log('[HEOS] Reconnecting in', this.reconnectDelay, 'ms');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.ip);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000); // max 30s
  }

  isConnected() {
    return this.connected;
  }

  // --- Heartbeat ---

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.enqueue('heos://system/heart_beat').catch(() => {});
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Command Queue ---

  enqueue(command) {
    return new Promise((resolve, reject) => {
      const entry = {
        command,
        resolve,
        reject,
        timeoutId: null,
        retries: 0,
        enqueuedAt: Date.now(),
        matchKey: null
      };
      this.queue.push(entry);
      if (this.pending === null && this.connected) {
        this.sendNext();
      }
    });
  }

  sendNext() {
    if (this.queue.length === 0) return;
    if (this.pending !== null) return;   // still waiting for response
    if (!this.connected) return;         // commands buffer until reconnect

    // Drop stale commands (queued > 30s ago)
    const now = Date.now();
    while (this.queue.length > 0 && now - this.queue[0].enqueuedAt > 30000) {
      const stale = this.queue.shift();
      stale.reject(new Error('Command expired: ' + stale.command));
    }
    if (this.queue.length === 0) return;

    this.pending = this.queue.shift();

    // Extract match key: "heos://player/set_volume?pid=123&level=50" -> "player/set_volume"
    this.pending.matchKey = this.pending.command
      .replace('heos://', '')
      .split('?')[0];

    // Write to socket
    this.socket.write(this.pending.command + '\r\n', (err) => {
      if (err) {
        console.error('[HEOS] Write error:', err.message);
        // Socket error/close handlers will reject pending and schedule reconnect
      }
    });

    // Start per-command timeout (5 seconds)
    this.pending.timeoutId = setTimeout(() => {
      const p = this.pending;
      this.pending = null;
      p.reject(new Error('Command timeout: ' + p.command));
      this.sendNext();
    }, 5000);
  }

  // --- Message Routing ---

  routeMessage(msg) {
    if (!msg || !msg.heos || !msg.heos.command) {
      console.error('[HEOS] Malformed message:', JSON.stringify(msg));
      return;
    }

    const command = msg.heos.command;

    // 1. Is it an event?
    if (command.startsWith('event/')) {
      this.eventCallback(msg);
      return;
    }

    // 2. Is it a "command under process" interim response?
    //    Both conditions must match: empty result string AND the specific message text.
    if (msg.heos.result === '' && msg.heos.message === 'command under process') {
      // Do NOT resolve the pending command. The real response comes later.
      // Reset timeout so it doesn't expire while waiting.
      if (this.pending && this.pending.timeoutId) {
        clearTimeout(this.pending.timeoutId);
        this.pending.timeoutId = setTimeout(() => {
          const p = this.pending;
          this.pending = null;
          p.reject(new Error('Command timeout (after CUP): ' + p.command));
          this.sendNext();
        }, 5000);
      }
      return;
    }

    // 3. Command response
    this.resolveQueuedCommand(msg);
  }

  resolveQueuedCommand(msg) {
    if (!this.pending) {
      console.warn('[HEOS] Orphaned response (no pending command):', msg.heos.command);
      return;
    }
    if (msg.heos.command !== this.pending.matchKey) {
      // Log at error level -- mismatch means queue is blocked until 5s timeout
      console.error('[HEOS] Response mismatch:', msg.heos.command, '!=', this.pending.matchKey);
      return;
    }

    clearTimeout(this.pending.timeoutId);

    // Check for retryable errors
    if (msg.heos.result === 'fail') {
      const parsed = parseHeosMessage(msg.heos.message);
      const eid = parseInt(parsed.eid, 10);

      if ((eid === 13 || eid === 16) && this.pending.retries < 3) {
        this.pending.retries++;
        const entry = this.pending;
        this.pending = null;
        this._retryEntry = entry;  // Track in-limbo entry so disconnect() can reject it
        const retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this._retryEntry = null;
          if (!this.connected) {
            entry.reject(new Error('Disconnected during retry'));
            return;
          }
          entry.enqueuedAt = Date.now(); // Reset so stale-command filter doesn't drop retries
          this.queue.unshift(entry);
          this.sendNext();
        }, 200 + Math.random() * 300); // 200-500ms jitter
        this._retryTimer = retryTimer;
        return;
      }

      // Non-retryable error
      const p = this.pending;
      this.pending = null;
      p.reject(new Error('HEOS error ' + eid + ': ' + (parsed.text || '')));
      this.sendNext();
      return;
    }

    // Success
    const p = this.pending;
    this.pending = null;
    p.resolve(msg);
    this.sendNext();
  }

  // --- Internal Helpers ---

  rejectPending(reason) {
    if (this.pending) {
      clearTimeout(this.pending.timeoutId);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
  }
}

module.exports = { HeosClient, parseHeosMessage, heosEncode };
