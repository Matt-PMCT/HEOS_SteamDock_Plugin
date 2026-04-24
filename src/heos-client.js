const net = require('net');
const logger = require('./logger');

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
        logger.error('[HEOS-Client] Failed to parse:', line.substring(0, 100));
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
      media: null,
      repeatMode: 'off',
      shuffleMode: 'off'
    };

    // Group volume state: { [gid]: { volume: 0, mute: false } }
    this.groupState = {};
    this.musicSources = [];

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
        try { fn(newState, old); } catch (e) { logger.error('[HEOS-Client] State listener error:', e); }
      }
    }
  }

  // --- TCP Connection Lifecycle ---

  connect(ip) {
    // Validate IPv4 format
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      logger.error('[HEOS-Client] Invalid IP address:', ip);
      return;
    }
    const octets = ip.split('.').map(Number);
    if (octets.some(o => o < 0 || o > 255)) {
      logger.error('[HEOS-Client] Invalid IP address (octet out of range):', ip);
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

    // Reset cached device state when switching to a new speaker so actions can't
    // read last-speaker's playState/volume/groups between connect() and init-complete.
    if (this.ip !== ip) {
      this.playerState = {
        playState: 'stop',
        volume: 0,
        mute: false,
        media: null,
        repeatMode: 'off',
        shuffleMode: 'off'
      };
      this.groupState = {};
      this.players = [];
      this.groups = [];
      this.musicSources = [];
      this.signedIn = false;
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
      logger.log('[HEOS-Client] Connected to', ip);
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
      logger.error('[HEOS-Client] Socket error:', err.message);
      // Do NOT reconnect here -- the close event follows
    });

    this.socket.on('close', () => {
      logger.log('[HEOS-Client] Connection closed');
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
      logger.error('[HEOS-Client] Connection timeout');
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
      logger.log('[HEOS-Client] 10 failed reconnection attempts. Speaker IP may have changed (DHCP). Check IP in Property Inspector.');
    }

    logger.log(`[HEOS-Client] Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`);
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
      this.enqueue('heos://system/heart_beat').catch(() => {
        // Heartbeat failed: socket may be half-open (writes black-holed, no FIN received).
        // Destroy the socket to force the close handler to fire and schedule a reconnect.
        if (this.socket) this.socket.destroy();
      });
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
        logger.error('[HEOS-Client] Write error:', err.message);
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
      logger.error('[HEOS-Client] Malformed message:', JSON.stringify(msg));
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
      logger.log('[HEOS-Client] Orphaned response (no pending command):', msg.heos.command);
      return;
    }
    if (msg.heos.command !== this.pending.matchKey) {
      // Mismatch indicates a queue desync. Reject the pending command and keep moving
      // instead of stalling throughput for 5s waiting on the per-command timeout.
      logger.error('[HEOS-Client] Response mismatch:', msg.heos.command, '!=', this.pending.matchKey);
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timeoutId);
      p.reject(new Error('Response mismatch: expected ' + p.matchKey + ', got ' + msg.heos.command));
      this.sendNext();
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
        logger.log('[HEOS-Client] Not signed in. Streaming presets require sign-in via Property Inspector.');
      }

      // 3. Get all players
      const playersResp = await this.enqueue('heos://player/get_players');
      this.players = playersResp.payload || [];

      // 3b. Retry once after 2s if empty (CLI module may still be spinning up)
      if (this.players.length === 0) {
        logger.log('[HEOS-Client] No players found. Retrying after 2s delay...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retryResp = await this.enqueue('heos://player/get_players');
        this.players = retryResp.payload || [];
        if (this.players.length === 0) {
          logger.log('[HEOS-Client] Still no players found. User may need to check network.');
        }
      }

      // 3c. Get groups for PI group membership display
      const groupsResp = await this.enqueue('heos://group/get_groups');
      this.groups = groupsResp.payload || [];

      // 3d. Get music sources (for input source selection)
      const sourcesResp = await this.enqueue('heos://browse/get_music_sources');
      this.musicSources = sourcesResp.payload || [];

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

      logger.log('[HEOS-Client] Init sequence complete. Player:', this.playerId, 'State:', this.playerState.playState);
      // Resolve init promise on success
      if (this._initResolve) {
        this._initResolve();
        this._initResolve = null;
        this._initReject = null;
      }
      if (this.onInitComplete) this.onInitComplete();
    } catch (err) {
      logger.error('[HEOS-Client] Init sequence failed:', err.message);
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
    // Use allSettled so one flaky subcommand doesn't abort the whole init.
    // Fields whose fetch failed keep their previous (or default) values.
    const results = await Promise.all([
      this.enqueue(`heos://player/get_play_state?pid=${pid}`).catch(err => ({ _err: err })),
      this.enqueue(`heos://player/get_volume?pid=${pid}`).catch(err => ({ _err: err })),
      this.enqueue(`heos://player/get_mute?pid=${pid}`).catch(err => ({ _err: err })),
      this.enqueue(`heos://player/get_now_playing_media?pid=${pid}`).catch(err => ({ _err: err })),
      this.enqueue(`heos://player/get_play_mode?pid=${pid}`).catch(err => ({ _err: err }))
    ]);
    const [stateResp, volResp, muteResp, mediaResp, modeResp] = results;

    const next = { ...this.playerState };

    if (!stateResp._err) {
      next.playState = parseHeosMessage(stateResp.heos.message).state;
    } else {
      logger.log('[HEOS-Client] pollPlayerState: get_play_state failed:', stateResp._err.message);
    }
    if (!volResp._err) {
      next.volume = parseInt(parseHeosMessage(volResp.heos.message).level, 10);
    } else {
      logger.log('[HEOS-Client] pollPlayerState: get_volume failed:', volResp._err.message);
    }
    if (!muteResp._err) {
      next.mute = parseHeosMessage(muteResp.heos.message).state === 'on';
    } else {
      logger.log('[HEOS-Client] pollPlayerState: get_mute failed:', muteResp._err.message);
    }
    if (!mediaResp._err) {
      next.media = mediaResp.payload || null;
    } else {
      logger.log('[HEOS-Client] pollPlayerState: get_now_playing_media failed:', mediaResp._err.message);
    }
    if (!modeResp._err) {
      const modeMsg = parseHeosMessage(modeResp.heos.message);
      next.repeatMode = modeMsg.repeat || 'off';
      next.shuffleMode = modeMsg.shuffle || 'off';
    } else {
      logger.log('[HEOS-Client] pollPlayerState: get_play_mode failed:', modeResp._err.message);
    }

    this.playerState = next;
  }

  // --- HEOS Event Handling ---

  handleHeosEvent(msg) {
    const eventName = msg.heos.command;
    const params = parseHeosMessage(msg.heos.message);
    const pid = params.pid ? parseInt(params.pid, 10) : null;

    // Only process events for our target player (or global events with no pid).
    // During init, this.playerId is null — let events through so we don't drop the
    // first register_for_change_events burst. Once playerId is set, filter strictly.
    if (pid !== null && this.playerId !== null && pid !== this.playerId) return;

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
          .then(resp => {
            this.playerState.media = resp.payload || null;
            this.eventCallback({ heos: { command: 'event/_media_updated', message: '' } });
          })
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
            .then(resp => {
              this.groups = resp.payload || [];
              // Rebuild groupState: keep entries for current groups, remove stale ones
              const currentGids = new Set(this.groups.map(g => parseInt(g.gid, 10)));
              for (const gid of Object.keys(this.groupState)) {
                if (!currentGids.has(parseInt(gid, 10))) delete this.groupState[gid];
              }
            })
            .catch(() => {});
        }, 500);
        break;

      case 'event/group_volume_changed': {
        const gid = params.gid ? parseInt(params.gid, 10) : null;
        if (gid !== null) {
          if (!this.groupState[gid]) this.groupState[gid] = { volume: 0, mute: false };
          this.groupState[gid].volume = parseInt(params.level, 10);
          if (params.mute !== undefined) this.groupState[gid].mute = params.mute === 'on';
        }
        break;
      }

      case 'event/player_playback_error':
        logger.error('[HEOS-Client] Playback error for player:', pid);
        this.playerState.playState = 'stop';
        break;

      case 'event/repeat_mode_changed':
        this.playerState.repeatMode = params.repeat || 'off';
        break;

      case 'event/shuffle_mode_changed':
        this.playerState.shuffleMode = params.shuffle || 'off';
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
          this.enqueue('heos://browse/get_music_sources')
            .then(resp => { this.musicSources = resp.payload || []; })
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

  enqueueGroupVolume(gid, level) {
    const command = `heos://group/set_volume?gid=${gid}&level=${level}`;

    this.queue = this.queue.filter(entry => {
      if (entry.command.startsWith('heos://group/set_volume?')) {
        entry.reject(new Error('Replaced by newer group volume command'));
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
