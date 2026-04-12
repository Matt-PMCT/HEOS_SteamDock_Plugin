# Phase 6: Resilience and Polish

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 5](./05-PROPERTY-INSPECTOR.md) | Next: [Phase 7 -- Future Enhancements](./07-FUTURE-ENHANCEMENTS.md)

## Objective

Harden the plugin for production use. The command queue, parser, and error retry were built in Phase 1. This phase adds connection lifecycle management (reconnection with exponential backoff, sleep/wake handling, command buffering during disconnect), UX polish (visual feedback, error states), event debouncing, production icons, and distribution prep.

**Done when:** The plugin survives sleep/wake cycles, network hiccups, and speaker restarts without manual intervention.

## Dependencies

All previous phases (1-5) must be complete.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/heos-client.js` | **Modify** -- connection state machine, command buffering, enhanced reconnection |
| `src/index.js` | **Modify** -- `systemDidWakeUp`, button state on connection changes |
| `src/actions/*.js` | **Modify** -- showOk/showAlert feedback, disconnected guards |
| `com.vsd.craft.heos.sdPlugin/images/` | **Replace** -- production icons |
| `com.vsd.craft.heos.sdPlugin/manifest.json` | **Modify** -- remove Debug line |

---

## Step 1: Connection State Machine (`heos-client.js`)

### Define Explicit States

```js
const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting'
};
```

### State Change Emitter

```js
// In constructor:
this.state = ConnectionState.DISCONNECTED;
this.stateListeners = [];

// Methods:
onStateChange(listener) {
  this.stateListeners.push(listener);
}

_setState(newState) {
  const old = this.state;
  this.state = newState;
  if (old !== newState) {
    for (const fn of this.stateListeners) {
      try { fn(newState, old); } catch (e) { console.error(e); }
    }
  }
}
```

**Important: Replace Phase 1's boolean flags with the state machine.** Remove `this.connected` and `this.connecting` entirely. Update ALL guards throughout `heos-client.js`:
- `sendNext()`: check `this.state === ConnectionState.CONNECTED` instead of `this.connected`
- `connect()`: check `this.state !== ConnectionState.CONNECTED` and `this.state !== ConnectionState.CONNECTING`
- `enqueue()`: same connected check
- `isConnected()`: return `this.state === ConnectionState.CONNECTED`
- `reconnect()`: use `_setState(ConnectionState.DISCONNECTED)` instead of setting boolean flags

Update `connect()`, `disconnect()`, `scheduleReconnect()`, `reconnect()` to call `_setState()` at all transitions. Never set `this.connected` or `this.connecting` directly -- use `_setState()` exclusively.

---

## Step 2: Command Buffering During Disconnect

Commands already buffer in the queue when `this.connected` is false (Phase 1's `sendNext()` returns early). Enhancements:

### Expire stale commands on reconnect

Add `enqueuedAt` timestamp to queue entries (already in Phase 1 spec). Before sending in `sendNext()`:

```js
const age = Date.now() - this.pending.enqueuedAt;
if (age > 30000) { // 30 second max buffer time
  this.pending.reject(new Error('Command expired during disconnect'));
  this.pending = null;
  this.sendNext();
  return;
}
```

### Drain order on reconnect

After init sequence completes on reconnection, `sendNext()` drains the queue. Init commands are enqueued first (by `runInitSequence`), so they execute before buffered user commands.

---

## Step 3: Enhanced Reconnection Logic

### `scheduleReconnect()`

```js
scheduleReconnect() {
  if (this.reconnectTimer) return;   // already scheduled
  if (!this.ip) return;              // no IP configured

  this._setState(ConnectionState.RECONNECTING);
  this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;

  if (this.reconnectAttempts === 10) {
    console.warn('[HEOS-Client] 10 failed reconnection attempts. Speaker IP may have changed (DHCP). Check IP in Property Inspector.');
  }

  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.connect(this.ip);
  }, this.reconnectDelay);

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
  this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
}
```

On successful connect, reset: `this.reconnectAttempts = 0;`

### `reconnect()` -- for `systemDidWakeUp`

```js
reconnect() {
  // Force-close without triggering normal reconnect
  clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
  this.reconnectDelay = 1000; // Reset backoff
  this.reconnectAttempts = 0;

  if (this.socket) {
    this.socket.removeAllListeners(); // Prevent close handler double-reconnecting
    this.socket.destroy();
    this.socket = null;
  }
  this._setState(ConnectionState.DISCONNECTED); // Use state machine, not booleans
  this.parser.reset();

  // Reject pending command
  if (this.pending) {
    clearTimeout(this.pending.timeoutId);
    this.pending.reject(new Error('Reconnecting'));
    this.pending = null;
  }

  if (this.ip) {
    this.connect(this.ip);
  }
}
```

---

## Step 4: `systemDidWakeUp` Handling (`index.js`)

```js
case 'systemDidWakeUp':
  console.log('[HEOS-Plugin] System woke up, reconnecting...');
  heosClient.reconnect();
  break;
```

---

## Step 5: Button State on Connection Changes (`index.js`)

```js
heosClient.onStateChange((newState, oldState) => {
  if (newState === 'disconnected' || newState === 'reconnecting') {
    // Show alert on all visible buttons
    for (const [ctx, info] of contextMap) {
      vsd.showAlert(ctx);
    }
  }

  if (newState === 'connected' && oldState !== 'connected') {
    // Refresh all button displays
    for (const [ctx, info] of contextMap) {
      const handler = handlers[info.action];
      if (handler && handler.onWillAppear) {
        handler.onWillAppear(
          { context: ctx, action: info.action, payload: { settings: info.settings } },
          { heosClient, vsd }
        );
      }
    }
  }
});
```

---

## Step 6: showOk/showAlert Feedback in Action Handlers

Update each handler:

| Action | showOk | showAlert |
|--------|--------|-----------|
| play-pause | After successful toggle | On error or no player |
| next-prev | After successful skip | On error |
| mute | Via setState (sufficient) | On error |
| volume | No (too noisy) | On connection error only |
| preset | After successful play | On error or not signed in |

### Add guard to ALL handlers

```js
if (!heosClient.isConnected()) {
  vsd.showAlert(message.context);
  return;
}
```

---

## Step 7: Event Debouncing for Burst Events

`players_changed`, `groups_changed`, and `sources_changed` can fire in rapid bursts. Phase 2 already added debounce for `players_changed`. Add similar for others:

```js
case 'event/groups_changed':
  clearTimeout(this._groupsChangedTimer);
  this._groupsChangedTimer = setTimeout(() => {
    // Re-fetch groups if needed (future feature)
  }, 500);
  break;
```

---

## Step 8: Production Icon Assets

Replace placeholder PNGs with proper icons. White on transparent, consistent media control symbols.

| File | Size | Description |
|------|------|-------------|
| `images/plugin-icon.png` | 128x128 | Plugin list icon |
| `images/category-icon.png` | 48x48 | Action category icon |
| `images/actions/play-pause.png` | 40x40 | Action list icon |
| `images/actions/play.png` | 40x40 | State 0: paused (play arrow) |
| `images/actions/pause.png` | 40x40 | State 1: playing (pause bars) |
| `images/actions/volume.png` | 40x40 | Volume knob icon |
| `images/actions/mute.png` | 40x40 | Mute action icon |
| `images/actions/unmuted.png` | 40x40 | State 0: unmuted (speaker waves) |
| `images/actions/muted.png` | 40x40 | State 1: muted (speaker slash) |
| `images/actions/next.png` | 40x40 | Next track (skip forward) |
| `images/actions/prev.png` | 40x40 | Previous track (skip back) |
| `images/actions/preset.png` | 40x40 | Preset/star icon |

---

## Step 9: Remove Debug Configuration

In `manifest.json`, remove the Debug line:

```json
"Nodejs": {
  "Version": "20"
}
```

Consider adding a build step that strips `Debug` from manifest for distribution.

---

## Step 10: Structured Logging

Add consistent log prefixes throughout:

```
[HEOS-Plugin]  -- index.js
[HEOS-Client]  -- heos-client.js
[HEOS-PI]      -- PI-related messages
```

Include enough context for debugging without Chrome inspector:
```js
console.error('[HEOS-Client] Command failed:', command, 'Error:', err.message);
```

---

## Critical Edge Cases

1. **Sleep/wake with stale TCP socket:** Socket may appear connected but be dead. `systemDidWakeUp` reconnects proactively. Heartbeat (30s) catches it as fallback.
2. **Reconnection while queue has commands:** Init sequence enqueued first. Buffered commands follow. If a buffered command references a removed player, it fails with error 2 -- handler shows alert.
3. **Rapid reconnect loop:** Exponential backoff caps at 30s. Speaker permanently offline = one attempt per 30s.
4. **VSD Craft restart:** Fresh plugin process. Global settings persist. Plugin reads them and auto-reconnects.
5. **Socket error vs close ordering:** Node.js `net.Socket` emits `error` then `close`. Error handler logs only. Close handler triggers reconnect. Do not reconnect in both.
6. **Multiple simultaneous reconnect triggers:** `systemDidWakeUp` and socket `close` could both fire. Idempotent guards (check timer/state) prevent double-connecting.
7. **DHCP IP change:** If the HEOS speaker's IP changes (DHCP lease renewal), the plugin retries the old IP indefinitely. After 10 failed reconnection attempts, log a warning suggesting the IP may have changed. Phase 7's SSDP auto-discovery would solve this; for now, document as a known limitation and tell users to update the IP via the Property Inspector.

## Verification

1. **Sleep/wake:** Sleep 60s, wake -- reconnects within 5s
2. **Speaker power cycle:** Unplug 10s, replug -- reconnects within 30s
3. **Network interruption:** WiFi off 10s, on -- recovery
4. **Presses during disconnect:** showAlert, no crash
5. **Long idle (1 hour):** Heartbeat keeps connection, buttons still work
6. **VSD Craft restart:** Auto-reconnects from saved settings
7. **No Debug port** in distribution manifest
8. **Cross-platform:** Test on Windows and macOS
