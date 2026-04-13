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
        console.error('[HEOS-Client] Failed to parse:', line.substring(0, 100));
      }
    }
    return messages;
  }

  reset() {
    this.buffer = '';
  }
}

// --- Connection States ---

const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting'
};

// --- HEOS Client ---

class HeosClient {
  constructor(eventCallback) {
    this.socket = null;
    this.parser = new ResponseParser();
    this.queue = [];          // [{ command, resolve, reject, timeoutId, retries, enqueuedAt, matchKey }]
    this.pending = null;      // Currently in-flight command entry (or null)
    this.state = ConnectionState.DISCONNECTED;
    this.stateListeners = [];
    this.ip = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.reconnectAttempts = 0;
    this._retryTimer = null;
    this._retryEntry = null;       // Entry in-limbo during retry delay
    this.eventCallback = eventCallback;
    this.onInitComplete = null; // Called after successful init with no args
    this.onInitError = null;    // Called after failed init with error message string

    // Player state tracking
    this.players = [];
    this.groups = [];
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
    this._groupsChangedTimer = null;
    this._userChangedTimer = null;
    this._sourcesChangedTimer = null;

    // Init promise (resolved when init sequence completes)
    this.initPromise = Promise.resolve();
    this._initResolve = null;
    this._initReject = null;
  }

  // --- Connection State Machine ---

  onStateChange(listener) {
    this.stateListeners.push(listener);
  }

  _setState(newState) {
    const old = this.state;
    this.state = newState;
    if (old !== newState) {
      for (const fn of this.stateListeners) {
        try { fn(newState, old); } catch (e) { console.error('[HEOS-Client] State listener error:', e); }
      }
    }
  }

  // --- TCP Connection Lifecycle ---

  connect(ip) {
    // Validate IPv4 format
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      console.error('[HEOS-Client] Invalid IP address:', ip);
      return;
    }
    const octets = ip.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      console.error('[HEOS-Client] Invalid IP address (octet out of range):', ip);
      return;
    }

    // Guard: already connected to this IP
    if (this.state === ConnectionState.CONNECTED && this.ip === ip) return;
    // Guard: already connecting
    if (this.state === ConnectionState.CONNECTING && this.ip === ip) return;

    // If connected/connecting to a DIFFERENT IP, disconnect first
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
      this.disconnect();
    }

    // Clear any pending reconnect timer (e.g. called from didReceiveGlobalSettings during RECONNECTING)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean up any leftover destroyed socket (e.g. from RECONNECTING state)
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this._setState(ConnectionState.CONNECTING);
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
      console.log('[HEOS-Client] Connected to', ip);
      this._setState(ConnectionState.CONNECTED);
      this.socket.setTimeout(0); // Clear connection timeout; heartbeat handles idle detection
      this.reconnectDelay = 1000; // Reset backoff
      this.reconnectAttempts = 0;
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
      console.error('[HEOS-Client] Socket error:', err.message);
      // Do NOT reconnect here -- the close event follows
    });

    this.socket.on('close', () => {
      console.log('[HEOS-Client] Connection closed');
      this._setState(ConnectionState.DISCONNECTED);
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
      console.error('[HEOS-Client] Connection timeout');
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
    if (this._groupsChangedTimer) {
      clearTimeout(this._groupsChangedTimer);
      this._groupsChangedTimer = null;
    }
    if (this._userChangedTimer) {
      clearTimeout(this._userChangedTimer);
      this._userChangedTimer = null;
    }
    if (this._sourcesChangedTimer) {
      clearTimeout(this._sourcesChangedTimer);
      this._sourcesChangedTimer = null;
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
    this._setState(ConnectionState.DISCONNECTED);

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

    // Clear reconnect scheduling
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 1000;
    this.reconnectAttempts = 0;

    // Teardown socket without triggering close handler's scheduleReconnect
    this.stopHeartbeat();
    this._initRunning = false;
    this._pendingInitPid = undefined;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._retryEntry) {
      this._retryEntry.reject(new Error('Reconnecting'));
      this._retryEntry = null;
    }
    // Clear event debounce timers to prevent stale commands buffering
    if (this._playersChangedTimer) { clearTimeout(this._playersChangedTimer); this._playersChangedTimer = null; }
    if (this._groupsChangedTimer) { clearTimeout(this._groupsChangedTimer); this._groupsChangedTimer = null; }
    if (this._userChangedTimer) { clearTimeout(this._userChangedTimer); this._userChangedTimer = null; }
    if (this._sourcesChangedTimer) { clearTimeout(this._sourcesChangedTimer); this._sourcesChangedTimer = null; }
    if (this.socket) {
      this.socket.removeAllListeners(); // Prevent close handler double-reconnecting
      this.socket.destroy();
      this.socket = null;
    }
    this.parser.reset();

    // Reject pending and queued commands (they may reference stale player state)
    this.rejectPending('Reconnecting');
    for (const entry of this.queue) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error('Reconnecting'));
    }
    this.queue = [];

    // Reject init promise if still pending
    if (this._initReject) {
      this._initReject(new Error('Reconnecting'));
      this._initResolve = null;
      this._initReject = null;
    }

    // Go directly to connect() -- avoid intermediate DISCONNECTED state
    // which would flash alerts on buttons unnecessarily
    this.state = ConnectionState.DISCONNECTED; // Set without notifying listeners
    this.connect(ip);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;   // already scheduled
    if (!this.ip) return;              // no IP configured
    if (this.state === ConnectionState.CONNECTED) return; // already connected

    this._setState(ConnectionState.RECONNECTING);
    this.reconnectAttempts++;

    if (this.reconnectAttempts === 10) {
      console.warn('[HEOS-Client] 10 failed reconnection attempts. Speaker IP may have changed (DHCP). Check IP in Property Inspector.');
    }

    console.log(`[HEOS-Client] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.ip);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000); // max 30s
  }

  isConnected() {
    return this.state === ConnectionState.CONNECTED;
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
      if (this.pending === null && this.state === ConnectionState.CONNECTED) {
        this.sendNext();
      }
    });
  }

  sendNext() {
    if (this.queue.length === 0) return;
    if (this.pending !== null) return;   // still waiting for response
    if (this.state !== ConnectionState.CONNECTED) return; // commands buffer until reconnect

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
        console.error('[HEOS-Client] Write error:', err.message);
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
      console.error('[HEOS-Client] Malformed message:', JSON.stringify(msg));
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
      console.warn('[HEOS-Client] Orphaned response (no pending command):', msg.heos.command);
      return;
    }
    if (msg.heos.command !== this.pending.matchKey) {
      // Log at error level -- mismatch means queue is blocked until 5s timeout
      console.error('[HEOS-Client] Response mismatch:', msg.heos.command, '!=', this.pending.matchKey);
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
          if (this.state !== ConnectionState.CONNECTED) {
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
        console.warn('[HEOS-Client] Not signed in. Streaming presets require sign-in via Property Inspector.');
      }

      // 3. Get all players
      const playersResp = await this.enqueue('heos://player/get_players');
      this.players = playersResp.payload || [];

      // 3b. Retry once after 2s if empty (CLI module may still be spinning up)
      if (this.players.length === 0) {
        console.warn('[HEOS-Client] No players found. Retrying after 2s delay...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryResp = await this.enqueue('heos://player/get_players');
        this.players = retryResp.payload || [];
        if (this.players.length === 0) {
          console.warn('[HEOS-Client] Still no players found. User may need to check network.');
        }
      }

      // 3c. Get groups for PI group membership display
      const groupsResp = await this.enqueue('heos://group/get_groups');
      this.groups = groupsResp.payload || [];

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

      console.log('[HEOS-Client] Init sequence complete. Player:', this.playerId, 'State:', this.playerState.playState);
      // Resolve init promise on success
      if (this._initResolve) {
        this._initResolve();
        this._initResolve = null;
        this._initReject = null;
      }
      if (this.onInitComplete) this.onInitComplete();
    } catch (err) {
      console.error('[HEOS-Client] Init sequence failed:', err.message);
      // Reject init promise so callers know it failed
      if (this._initReject) {
        this._initReject(err);
        this._initResolve = null;
        this._initReject = null;
      }
      if (this.onInitError) this.onInitError(err.message);
    } finally {
      this._initRunning = false;

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

      case 'event/groups_changed':
        clearTimeout(this._groupsChangedTimer);
        this._groupsChangedTimer = setTimeout(() => {
          this.enqueue('heos://group/get_groups')
            .then(resp => { this.groups = resp.payload || []; })
            .catch(() => {});
        }, 500);
        break;

      case 'event/player_playback_error':
        console.error('[HEOS-Client] Playback error for player:', pid);
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

      case 'event/sources_changed':
        clearTimeout(this._sourcesChangedTimer);
        this._sourcesChangedTimer = setTimeout(() => {
          // Debounced -- no action needed currently, but prevents burst event flooding
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

module.exports = { HeosClient, ConnectionState, parseHeosMessage, heosEncode };
