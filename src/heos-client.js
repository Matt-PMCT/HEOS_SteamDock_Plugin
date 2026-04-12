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

    // Player state tracking
    this.players = [];
    this.playerId = null;
    this.signedIn = false;
    this.playerState = {
      playState: 'stop',
      volume: 0,
      mute: false,
      media: null
    };

    // Init sequence guard and debounce timers
    this._initRunning = false;
    this._pendingInitPid = undefined; // queued re-run if init called while running
    this._playersChangedTimer = null;
    this._userChangedTimer = null;

    // Init promise (resolved when init sequence completes)
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
      this.sendNext(); // Drain any queued commands

      // Run init sequence (handles first connect and reconnection)
      this.runInitSequence(this.playerId);
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
    this._initRunning = false;
    this._pendingInitPid = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._playersChangedTimer) {
      clearTimeout(this._playersChangedTimer);
      this._playersChangedTimer = null;
    }
    if (this._userChangedTimer) {
      clearTimeout(this._userChangedTimer);
      this._userChangedTimer = null;
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
      this.handleHeosEvent(msg);
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

  // --- Init Sequence ---

  async runInitSequence(playerId) {
    if (this._initRunning) {
      this._pendingInitPid = playerId;
      return;
    }
    this._initRunning = true;
    this._pendingInitPid = undefined;

    try {
      // 1. Unregister for events (defensive reset)
      await this.enqueue('heos://system/register_for_change_events?enable=off');

      // 2. Check account status
      const accountResp = await this.enqueue('heos://system/check_account');
      const accountMsg = parseHeosMessage(accountResp.heos.message);
      this.signedIn = accountMsg.signed_in === 'true' || !!accountMsg.un;

      if (!this.signedIn) {
        console.warn('[HEOS] Not signed in. Streaming presets require sign-in via Property Inspector.');
      }

      // 3. Get all players
      const playersResp = await this.enqueue('heos://player/get_players');
      this.players = playersResp.payload || [];

      // 3b. Retry once after 2s if empty (CLI module may still be spinning up)
      if (this.players.length === 0) {
        console.warn('[HEOS] No players found. Retrying after 2s delay...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryResp = await this.enqueue('heos://player/get_players');
        this.players = retryResp.payload || [];
        if (this.players.length === 0) {
          console.warn('[HEOS] Still no players found. User may need to check network.');
        }
      }

      // 4. Set player ID and poll state
      if (playerId != null) {
        this.playerId = typeof playerId === 'string' ? parseInt(playerId, 10) : playerId;
      } else if (this.players.length > 0) {
        this.playerId = this.players[0].pid;
      }

      if (this.playerId != null) {
        await this.pollPlayerState(this.playerId);
      }

      // 5. Register for change events
      await this.enqueue('heos://system/register_for_change_events?enable=on');

      console.log('[HEOS] Init sequence complete. Player:', this.playerId, 'State:', this.playerState.playState);
    } catch (err) {
      console.error('[HEOS] Init sequence failed:', err.message);
    } finally {
      this._initRunning = false;

      // Resolve init promise regardless of success/failure
      if (this._initResolve) {
        this._initResolve();
        this._initResolve = null;
        this._initReject = null;
      }

      // Re-run if a new init was requested while we were running
      if (this._pendingInitPid !== undefined) {
        const pid = this._pendingInitPid;
        this._pendingInitPid = undefined;
        this.runInitSequence(pid);
      }
    }
  }

  async pollPlayerState(pid) {
    const stateResp = await this.enqueue(`heos://player/get_play_state?pid=${pid}`);
    const volResp = await this.enqueue(`heos://player/get_volume?pid=${pid}`);
    const muteResp = await this.enqueue(`heos://player/get_mute?pid=${pid}`);
    const mediaResp = await this.enqueue(`heos://player/get_now_playing_media?pid=${pid}`);

    const stateMsg = parseHeosMessage(stateResp.heos.message);
    const volMsg = parseHeosMessage(volResp.heos.message);
    const muteMsg = parseHeosMessage(muteResp.heos.message);

    this.playerState = {
      playState: stateMsg.state,
      volume: parseInt(volMsg.level, 10),
      mute: muteMsg.state === 'on',
      media: mediaResp.payload || null
    };
  }

  // --- HEOS Event Handling ---

  handleHeosEvent(msg) {
    const eventName = msg.heos.command;
    const params = parseHeosMessage(msg.heos.message);
    const pid = params.pid ? parseInt(params.pid, 10) : null;

    // Only process events for our target player (or global events with no pid)
    if (pid !== null && pid !== this.playerId) return;

    switch (eventName) {
      case 'event/player_state_changed':
        this.playerState.playState = params.state;
        break;

      case 'event/player_volume_changed':
        this.playerState.volume = parseInt(params.level, 10);
        this.playerState.mute = params.mute === 'on';
        break;

      case 'event/player_now_playing_changed':
        this.enqueue(`heos://player/get_now_playing_media?pid=${this.playerId}`)
          .then(resp => { this.playerState.media = resp.payload || null; })
          .catch(() => {});
        break;

      case 'event/players_changed':
        clearTimeout(this._playersChangedTimer);
        this._playersChangedTimer = setTimeout(() => {
          this.enqueue('heos://player/get_players')
            .then(resp => { this.players = resp.payload || []; })
            .catch(() => {});
        }, 500);
        break;

      case 'event/player_playback_error':
        console.error('[HEOS] Playback error for player:', pid);
        this.playerState.playState = 'stop';
        break;

      case 'event/user_changed':
        clearTimeout(this._userChangedTimer);
        this._userChangedTimer = setTimeout(() => {
          this.enqueue('heos://system/check_account')
            .then(resp => {
              const accountMsg = parseHeosMessage(resp.heos.message);
              this.signedIn = accountMsg.signed_in === 'true' || !!accountMsg.un;
            })
            .catch(() => {});
        }, 500);
        break;
    }

    // Forward to index.js callback for button state updates
    this.eventCallback(msg);
  }

  // --- Volume Queue Replacement ---

  enqueueVolume(pid, level) {
    const command = `heos://player/set_volume?pid=${pid}&level=${level}`;

    // Remove stale volume commands from queue (not the in-flight one)
    this.queue = this.queue.filter(entry => {
      if (entry.command.startsWith('heos://player/set_volume?')) {
        entry.reject(new Error('Replaced by newer volume command'));
        return false;
      }
      return true;
    });

    return this.enqueue(command);
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
