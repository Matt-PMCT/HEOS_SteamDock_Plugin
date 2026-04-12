# Phase 1: Skeleton, Connection, and Command Infrastructure

> **[Back to Summary](./00-SUMMARY.md)** | Next: [Phase 2 -- Core Playback Actions](./02-CORE-PLAYBACK-ACTIONS.md)

## Objective

Build the foundational infrastructure every subsequent phase depends on: WebSocket connection to VSD Craft, TCP connection to HEOS, command serialization queue, TCP response parser, and event/response routing. Without a reliable command queue and parser, no action handler can function -- HEOS devices crash under concurrent commands and send responses that span multiple TCP data events.

**Done when:** A button press on the M3 sends a heartbeat through the full pipeline and receives a success response in the debug log.

## Dependencies

None. This is the foundation.

## Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Project metadata, `ws` dep, `@vercel/ncc` dev dep, build scripts |
| `src/index.js` | Main entry: CLI arg parsing, WebSocket to VSD Craft, event dispatch |
| `src/heos-client.js` | TCP connection, response parser, command queue, event routing, heartbeat |
| `com.vsd.craft.heos.sdPlugin/manifest.json` | Full plugin manifest (all 6 actions, from [preliminary doc 05](../preliminary/05-MANIFEST-REFERENCE.md)) |
| `com.vsd.craft.heos.sdPlugin/images/` | Placeholder PNG icons |

---

## Step 1: `package.json`

```json
{
  "name": "heos-streamdock-plugin",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "ncc build src/index.js -o com.vsd.craft.heos.sdPlugin/plugin",
    "dev": "ncc build src/index.js -o com.vsd.craft.heos.sdPlugin/plugin --watch"
  },
  "dependencies": {
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@vercel/ncc": "^0.38.0"
  }
}
```

---

## Step 2: `src/index.js` -- WebSocket Registration and Event Dispatch

### Module-Level State

```
pluginUUID     // string -- the plugin's UUID passed by VSD Craft
ws             // WebSocket instance to VSD Craft
heosClient     // HeosClient instance (created in this module)
globalSettings // object -- { heosIp, playerId, playerName } from getGlobalSettings
contextMap     // Map<context, { action, settings }> -- tracks all visible action instances
```

### Function: `parseArgs()`

- Iterate `process.argv` starting at index 2, step by 2
- Strip the leading `-` from each key, store value
- Returns `{ port, pluginUUID, registerEvent, info }`
- `info` is a JSON string -- `JSON.parse` it to get device info

```js
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^-/, '')] = process.argv[i + 1];
  }
  return args;
}
```

### Function: `connectToVsdCraft(args)`

- `const ws = new WebSocket('ws://127.0.0.1:' + args.port)` (using `ws` package)
- On `open`: send registration `JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID })`, then immediately call `getGlobalSettings()` to trigger auto-connect with saved settings
- On `message`: `JSON.parse(data)`, call `dispatchEvent(message)`
- On `close`/`error`: log and `process.exit()` (VSD Craft manages plugin lifecycle; if WebSocket dies, plugin should terminate)
- Store `ws` and `pluginUUID` at module scope

### Function: `dispatchEvent(message)`

Switch on `message.event`:

| Event | Action |
|-------|--------|
| `willAppear` | Store context in `contextMap` with `{ action, settings }`, call handler's `onWillAppear` |
| `willDisappear` | Remove from `contextMap`, call handler's `onWillDisappear` |
| `keyDown` | Look up handler by `message.action` UUID, call `onKeyDown(message)` |
| `keyUp` | Look up handler, call `onKeyUp(message)` |
| `dialRotate` | Call handler's `onDialRotate(message)` |
| `dialDown` | Call handler's `onDialDown(message)` |
| `dialUp` | Call handler's `onDialUp(message)` |
| `didReceiveSettings` | Update `contextMap` entry, call handler's `onDidReceiveSettings(message)` |
| `didReceiveGlobalSettings` | Update `globalSettings`, reconnect HEOS if IP changed |
| `systemDidWakeUp` | Call `heosClient.reconnect()` |
| `sendToPlugin` | Forward to handler's `onSendToPlugin(message)` |
| `propertyInspectorDidAppear` | Track PI state |
| `propertyInspectorDidDisappear` | Track PI state |
| Default | Log unknown event for debugging |

### VSD Craft Helper Functions

Exported for use by action handlers. Each constructs the JSON envelope and calls `ws.send()`:

```
setTitle(context, title, target = 0)
setState(context, state)
setImage(context, imageDataUri, target = 0)
showOk(context)
showAlert(context)
setGlobalSettings(payload)
getGlobalSettings()
setSettings(context, payload)
sendToPropertyInspector(action, context, payload)
```

`target`: 0 = both hardware and software, 1 = hardware only, 2 = software only.

### Action Handler Registry

```js
const handlers = {}; // keyed by action UUID string
```

In Phase 1, register a single test handler that sends `heos://system/heart_beat` on `keyDown`. Later phases populate with real handlers.

### Bootstrap Sequence

```js
const args = parseArgs();
const heosClient = new HeosClient(onHeosEvent);
connectToVsdCraft(args);
// After WebSocket open and registration, immediately request saved settings:
// getGlobalSettings() -- this triggers a didReceiveGlobalSettings event
```

**Auto-connect trigger (in `didReceiveGlobalSettings` handler):**

```js
case 'didReceiveGlobalSettings':
  const newSettings = message.payload.settings || {};
  const ipChanged = newSettings.heosIp && newSettings.heosIp !== globalSettings.heosIp;
  const oldSettings = globalSettings;
  globalSettings = newSettings;

  if (ipChanged || (!heosClient.isConnected() && globalSettings.heosIp)) {
    // Connect (or reconnect to new IP) using saved settings
    const playerId = globalSettings.playerId ? parseInt(globalSettings.playerId, 10) : null;
    heosClient.connect(globalSettings.heosIp);
    // Phase 2 adds: heosClient.runInitSequence(playerId) after TCP connect
  }
  break;
```

This is the primary auto-connect path: on VSD Craft restart, saved global settings trigger HEOS connection automatically without requiring the user to open the Property Inspector.

For Phase 1 testing, you can hardcode an IP in the bootstrap instead of waiting for `didReceiveGlobalSettings`.

---

## Step 3: `src/heos-client.js` -- The Core Engine

This is the most complex file. Four tightly coupled subsystems: TCP connection management, response parser, command queue, and event routing.

### Exported Class: `HeosClient`

#### Constructor: `HeosClient(eventCallback)`

`eventCallback` is called with parsed HEOS events (e.g., `player_state_changed`).

```js
this.socket = null;              // net.Socket instance
this.parser = new ResponseParser();
this.queue = [];                 // [{ command, resolve, reject, timeoutId, retries, enqueuedAt }]
this.pending = null;             // Currently in-flight command entry (or null)
this.connected = false;          // NOTE: Phase 6 replaces these booleans with a
this.connecting = false;         // ConnectionState state machine. See Phase 6 Step 1.
this.ip = null;
this.heartbeatTimer = null;
this.reconnectTimer = null;
this.reconnectDelay = 1000;      // exponential backoff starting point
this.eventCallback = eventCallback;
```

### TCP Connection Lifecycle

#### `connect(ip)`

- Validate IP format: basic IPv4 regex `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` with octet range check (0-255). Reject hostnames, IPv6, empty strings. Log error and return if invalid.
- Guard: if already connected to this IP, return. If connecting, return.
- **If connected/connecting to a DIFFERENT IP**, call `this.disconnect()` first before proceeding.
- Set `this.connecting = true`, `this.ip = ip`
- `this.socket = new net.Socket()`
- `this.socket.setTimeout(5000)` -- connection timeout (without this, OS-level TCP timeout can be 30-120s)
- `this.socket.connect(1255, ip)`

**On `connect` event:**
- `this.connected = true`, `this.connecting = false`
- `this.socket.setTimeout(0)` -- clear connection timeout (heartbeat handles idle detection)
- `this.reconnectDelay = 1000` (reset backoff)
- `this.startHeartbeat()`
- Run initialization sequence (Phase 2 adds full sequence; Phase 1 just enables)
- Drain queued commands: `this.sendNext()`

**On `data` event:**
- `const messages = this.parser.put(data.toString())`
- For each message: `this.routeMessage(message)`

**On `error` event:**
- Log the error
- Do NOT reconnect here (the `close` event follows)

**On `close` event:**
- `this.connected = false`, `this.connecting = false`
- `this.stopHeartbeat()`
- Reject pending command: `this.rejectPending('Connection closed')`
- `this.scheduleReconnect()`

**On `timeout` event:**
- `this.socket.destroy()`

#### `disconnect()`

- Stop heartbeat, clear reconnect timer
- If socket: **`this.socket.removeAllListeners()` then** `this.socket.destroy()`. Removing listeners first is critical -- `destroy()` emits a `close` event asynchronously. If listeners are still attached, the old socket's `close` handler will clobber shared state (`connected`, `connecting`), reject the new connection's pending command, and schedule an unwanted reconnect. This is a race condition when `disconnect()` is called from `connect()` during an IP change or from `reconnect()`.
- `this.connected = false`
- Reject `initPromise` if still pending (see Init Promise section -- since listeners were removed, the socket `close` handler won't fire to reject it)
- Reject all queued commands

#### `scheduleReconnect()`

```js
scheduleReconnect() {
  if (this.reconnectTimer) return;   // already scheduled
  if (!this.ip) return;              // no IP configured
  this.reconnectTimer = setTimeout(() => {
    this.reconnectTimer = null;
    this.connect(this.ip);
  }, this.reconnectDelay);
  this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000); // max 30s
}
```

**Backoff reset:** `reconnectDelay` must only be reset to 1000 in two places: (1) the socket `connect` handler on successful connection, and (2) the caller in `index.js` when the user explicitly changes the speaker IP. Do **not** reset it inside `connect()` itself -- `scheduleReconnect()` calls `connect()`, so a reset there defeats the exponential backoff entirely (the delay oscillates between 1-2s forever instead of growing to 30s).

#### `reconnect()` (called on `systemDidWakeUp`)

- `this.disconnect()` then `this.connect(this.ip)`

#### `startHeartbeat()`

```js
this.heartbeatTimer = setInterval(() => {
  this.enqueue('heos://system/heart_beat').catch(() => {});
}, 30000);
```

#### `stopHeartbeat()`

```js
clearInterval(this.heartbeatTimer);
this.heartbeatTimer = null;
```

### Response Parser

Inner class (or standalone). This is a **deliberate departure from juliuscc/heos-api** which flushes the entire buffer on any parse error, losing subsequent valid messages.

```js
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
```

### Command Queue with Serialization

See [preliminary doc 02](../preliminary/02-HEOS-PROTOCOL-REFERENCE.md) "Command Serialization" section for the design rationale.

#### `enqueue(command, options = {})`

Returns a Promise.

```js
enqueue(command, options = {}) {
  return new Promise((resolve, reject) => {
    const entry = {
      command,
      resolve,
      reject,
      timeoutId: null,
      retries: 0,
      enqueuedAt: Date.now()
    };
    this.queue.push(entry);
    if (this.pending === null && this.connected) {
      this.sendNext();
    }
  });
}
```

#### `sendNext()`

```js
sendNext() {
  if (this.queue.length === 0) return;
  if (this.pending !== null) return;   // still waiting for response
  if (!this.connected) return;         // commands buffer until reconnect

  this.pending = this.queue.shift();

  // Extract match key: "heos://player/set_volume?pid=123&level=50" -> "player/set_volume"
  this.pending.matchKey = this.pending.command
    .replace('heos://', '')
    .split('?')[0];

  // Write to socket
  this.socket.write(this.pending.command + '\r\n');

  // Start per-command timeout (5 seconds)
  this.pending.timeoutId = setTimeout(() => {
    const p = this.pending;
    this.pending = null;
    p.reject(new Error('Command timeout: ' + p.command));
    this.sendNext();
  }, 5000);
}
```

#### `resolveQueuedCommand(msg)`

```js
resolveQueuedCommand(msg) {
  if (!this.pending) {
    console.warn('[HEOS] Orphaned response (no pending command):', msg.heos.command);
    return;
  }
  if (msg.heos.command !== this.pending.matchKey) {
    console.warn('[HEOS] Response mismatch:', msg.heos.command, '!=', this.pending.matchKey);
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
      // Track the in-limbo entry and timer so disconnect() can clean up.
      // During the retry delay, the entry is not in `pending` or `queue` --
      // it only exists in this closure. If disconnect() fires during the
      // delay and only clears pending + queue, this entry's Promise leaks
      // permanently (never resolved or rejected). disconnect() must clear
      // the timer and reject the entry.
      this._retryEntry = entry;
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._retryEntry = null;
        if (!this.connected) {
          entry.reject(new Error('Disconnected during retry'));
          return;
        }
        entry.enqueuedAt = Date.now();
        this.queue.unshift(entry);
        this.sendNext();
      }, 200 + Math.random() * 300); // 200-500ms jitter
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
```

### Event vs. Response Routing

See [preliminary doc 02](../preliminary/02-HEOS-PROTOCOL-REFERENCE.md) "Event vs. Response Routing" section.

```js
routeMessage(msg) {
  if (!msg || !msg.heos || !msg.heos.command) {
    console.error('[HEOS] Malformed message:', msg);
    return;
  }

  const command = msg.heos.command;

  // 1. Is it an event?
  if (command.startsWith('event/')) {
    this.eventCallback(msg);  // Phase 2 changes this to handleHeosEvent()
    return;
  }

  // 2. Is it a "command under process" interim response?
  //    Both conditions must match: empty result string AND the specific message text.
  //    Checking only message could misroute a normal response containing similar text.
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
```

### HEOS Command Value Encoder

HEOS uses a custom encoding for command attribute values: only `&`, `=`, and `%` need encoding (to `%26`, `%3D`, `%25`). Standard `encodeURIComponent()` encodes far more characters (`@`, spaces, etc.) which HEOS may reject. Order matters: `%` must be encoded first.

```js
function heosEncode(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/=/g, '%3D');
}
```

### HEOS Message Field Parser

The `message` field in HEOS responses is URL-encoded key-value pairs, NOT JSON. Exported for use by action handlers.

```js
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
```

### Public API Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(ip)` | void | Open TCP to speaker |
| `disconnect()` | void | Close TCP, reject all pending |
| `reconnect()` | void | Disconnect then reconnect |
| `enqueue(command)` | `Promise<msg>` | Send command through queue |
| `isConnected()` | boolean | Check connection state |
| `updateConnection(globalSettings)` | void | If IP changed, reconnect |

### Init Promise

External callers (e.g., PI connect handler in Phase 5) need to know when the init sequence completes. The `connect()` method creates a fresh `initPromise` **synchronously** before calling `socket.connect()`, so callers can safely chain on it immediately after `connect()` returns.

```js
// In connect():
this.initPromise = new Promise((resolve, reject) => {
  this._initResolve = resolve;
  this._initReject = reject;
});
// ... then socket.connect(1255, ip)

// In the socket 'connect' handler:
this.runInitSequence(playerId)
  .then(() => this._initResolve())
  .catch(err => this._initReject(err));

// In the socket 'close'/'error' handler:
if (this._initReject) this._initReject(new Error('Connection closed'));

// In disconnect() -- required because removeAllListeners() prevents
// the close handler from firing:
if (this._initReject) this._initReject(new Error('Disconnected'));
this._initResolve = null;
this._initReject = null;
```

This replaces the need for an EventEmitter `.once('initialized')` pattern. Callers chain on `heosClient.initPromise.then(...)`. Each `connect()` call creates a fresh promise, so rapid IP changes always give the caller the correct promise for their connection attempt.

**Important:** `disconnect()` removes socket listeners before destroying the socket (see above), so the `close` handler will not fire. `disconnect()` must therefore reject `_initReject` itself, or the promise will leak permanently -- any code awaiting `initPromise` will hang forever.

### Module Exports

```js
module.exports = { HeosClient, parseHeosMessage, heosEncode };
```

---

## Step 4: `manifest.json`

Copy the full manifest from [preliminary doc 05](../preliminary/05-MANIFEST-REFERENCE.md) with all 6 actions. Create it now with all actions to avoid manifest changes in every phase.

---

## Step 5: Placeholder Images

Create minimal solid-color PNGs at required sizes:
- `images/plugin-icon.png` -- 128x128
- `images/category-icon.png` -- 48x48
- `images/actions/play-pause.png`, `play.png`, `pause.png`, `volume.png`, `mute.png`, `unmuted.png`, `muted.png`, `next.png`, `prev.png`, `preset.png` -- all 40x40

Can be generated programmatically with a simple script. Replaced with production icons in Phase 6.

---

## Critical Edge Cases

1. **Partial TCP data** -- parser buffers and waits for next `data` event
2. **Multiple JSON objects in one TCP chunk** -- parser splits on `\r\n` and returns all
3. **"command under process"** must NOT resolve the pending command -- the real response comes later
4. **Error 13 retry cap** (max 3) prevents infinite loops
5. **Socket close during pending command** -- must reject the promise so caller doesn't hang
6. **VSD Craft `info` arg** is a JSON string -- must `JSON.parse` it
7. **Player IDs** are signed integers, can be negative
8. **Malformed HEOS lines** -- skip only the bad line, never flush buffer

## Verification

1. `npm install && npm run build` -- confirm `com.vsd.craft.heos.sdPlugin/plugin/index.js` generated
2. Install `.sdPlugin` folder into VSD Craft plugins directory (symlink or copy)
3. Restart VSD Craft -- plugin appears in action list
4. Drag test action onto button, press it
5. Debug log shows heartbeat response: `{ "heos": { "command": "system/heart_beat", "result": "success" } }`
6. Test with speaker off -- graceful error, reconnection scheduled
7. Rapid button presses -- commands serialize (one in-flight at a time)
