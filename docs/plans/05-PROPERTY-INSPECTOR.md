# Phase 5: Property Inspector

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 4](./04-PRESET-BUTTONS.md) | Next: [Phase 6 -- Resilience & Polish](./06-RESILIENCE-AND-POLISH.md)

## Objective

Build the settings UI that allows users to configure the HEOS speaker IP address, discover and select players, set preset numbers, and optionally sign in to a HEOS account -- all from the VSD Craft UI. The PI is an HTML page rendered inside VSD Craft, communicating with the plugin backend via WebSocket using `sendToPlugin`/`sendToPropertyInspector`.

**Done when:** A user can enter an IP, discover speakers, select a player, and configure presets entirely from VSD Craft.

## Dependencies

Phase 1 (WebSocket registration, TCP connection), Phase 2 (player discovery, init), Phase 4 (preset settings).

## Files to Create/Modify

| File | Action |
|------|--------|
| `com.vsd.craft.heos.sdPlugin/property-inspector/index.html` | **New** -- PI HTML |
| `com.vsd.craft.heos.sdPlugin/property-inspector/js/pi.js` | **New** -- PI logic |
| `com.vsd.craft.heos.sdPlugin/property-inspector/css/pi.css` | **New** -- PI styling |
| `src/index.js` | **Modify** -- handle `sendToPlugin` messages |

---

## Step 1: PI WebSocket Registration

The PI runs in a browser context inside VSD Craft. VSD Craft calls a global function with connection parameters. The function name is the legacy `connectElgatoStreamDeckSocket` (VSD Craft calls it automatically).

**Important:** The PI uses browser-native WebSocket, NOT the `ws` package (that's for the Node.js plugin only).

### `pi.js` Top-Level Structure

```js
// Globals populated by connectElgatoStreamDeckSocket
let websocket = null;
let piUUID = null;
let currentAction = null;
let currentContext = null;
let currentSettings = {};
let globalSettings = {};

// VSD Craft calls this automatically when PI HTML loads
function connectElgatoStreamDeckSocket(inPort, inPropertyInspectorUUID, inRegisterEvent, inInfo, inActionInfo) {
  piUUID = inPropertyInspectorUUID;

  // Parse inActionInfo (JSON string) -> action, context, settings
  const actionInfo = JSON.parse(inActionInfo);
  currentAction = actionInfo.action;
  currentContext = actionInfo.context;
  currentSettings = actionInfo.payload.settings || {};

  websocket = new WebSocket('ws://127.0.0.1:' + inPort);

  websocket.onopen = function() {
    // 1. Register PI with VSD Craft
    websocket.send(JSON.stringify({
      event: inRegisterEvent,
      uuid: piUUID
    }));

    // 2. Request global settings (triggers didReceiveGlobalSettings)
    websocket.send(JSON.stringify({
      event: 'getGlobalSettings',
      context: piUUID
    }));

    // 3. Ask plugin for current data
    sendToPlugin({ command: 'getStatus' });
  };

  websocket.onmessage = function(evt) {
    handleMessage(JSON.parse(evt.data));
  };

  populateActionUI();
}

function handleMessage(message) {
  switch (message.event) {
    case 'didReceiveGlobalSettings':
      globalSettings = message.payload.settings || {};
      populateGlobalUI();
      break;
    case 'didReceiveSettings':
      currentSettings = message.payload.settings || {};
      populateActionUI();
      break;
    case 'sendToPropertyInspector':
      handlePluginData(message.payload);
      break;
  }
}
```

---

## Step 2: PI HTML Structure (`index.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>HEOS Control Settings</title>
  <link rel="stylesheet" href="css/pi.css">
</head>
<body>
  <!-- Section 1: Connection (shown for ALL actions) -->
  <div class="sdpi-wrapper" id="connection-section">
    <div class="sdpi-heading">HEOS Connection</div>

    <div class="sdpi-item">
      <div class="sdpi-item-label">Speaker IP</div>
      <input class="sdpi-item-value" type="text" id="heos-ip"
             placeholder="192.168.1.100">
    </div>

    <div class="sdpi-item">
      <button class="sdpi-item-value" id="btn-connect">
        Connect & Discover
      </button>
    </div>

    <div class="sdpi-item" id="status-row">
      <div class="sdpi-item-label">Status</div>
      <span class="sdpi-item-value" id="connection-status">Not connected</span>
    </div>

    <div class="sdpi-item" id="player-row" style="display:none;">
      <div class="sdpi-item-label">Player</div>
      <select class="sdpi-item-value" id="player-select">
        <option value="">Select a player...</option>
      </select>
    </div>
  </div>

  <!-- Section 2: Preset config (ONLY for preset action) -->
  <div class="sdpi-wrapper" id="preset-section" style="display:none;">
    <div class="sdpi-heading">Preset Settings</div>

    <div class="sdpi-item">
      <div class="sdpi-item-label">Preset #</div>
      <input class="sdpi-item-value" type="number" id="preset-number"
             min="1" max="99" value="1">
    </div>
  </div>

  <!-- Section 3: Account (all actions, collapsed by default) -->
  <div class="sdpi-wrapper" id="account-section">
    <div class="sdpi-heading">HEOS Account (optional)</div>
    <details>
      <summary>Sign in for streaming service presets</summary>
      <div class="sdpi-item">
        <div class="sdpi-item-label">Username</div>
        <input class="sdpi-item-value" type="text" id="heos-username"
               placeholder="email@example.com">
      </div>
      <div class="sdpi-item">
        <div class="sdpi-item-label">Password</div>
        <input class="sdpi-item-value" type="password" id="heos-password">
      </div>
      <div class="sdpi-item">
        <button class="sdpi-item-value" id="btn-signin">Sign In</button>
      </div>
      <div class="sdpi-item">
        <span class="sdpi-item-value" id="account-status"></span>
      </div>
    </details>
  </div>

  <script src="js/pi.js"></script>
</body>
</html>
```

---

## Step 3: PI <-> Plugin Communication Protocol

### PI -> Plugin (`sendToPlugin`)

| `payload.command` | Description |
|---|---|
| `getStatus` | Request current connection status, player list, selected player |
| `connect` | Connect to IP: `{ command: 'connect', ip: '192.168.1.100' }` |
| `selectPlayer` | Select a player: `{ command: 'selectPlayer', pid: 123456 }` |
| `signIn` | HEOS sign-in: `{ command: 'signIn', username: '...', password: '...' }` |

### Plugin -> PI (`sendToPropertyInspector`)

| `payload.type` | Description |
|---|---|
| `status` | `{ type: 'status', connected, players, selectedPid, signedIn }` |
| `connectResult` | `{ type: 'connectResult', success, players }` |
| `error` | `{ type: 'error', message: '...' }` |
| `signInResult` | `{ type: 'signInResult', success, username }` |

---

## Step 4: Plugin-Side PI Handling (`index.js`)

Add to the `sendToPlugin` case in `dispatchEvent`:

```js
function handlePIMessage(message) {
  const payload = message.payload;
  const action = message.action;
  const context = message.context;

  switch (payload.command) {
    case 'getStatus':
      sendToPropertyInspector(action, context, {
        type: 'status',
        connected: heosClient.isConnected(),
        players: heosClient.players,
        selectedPid: heosClient.playerId,
        signedIn: heosClient.signedIn
      });
      break;

    case 'connect':
      setGlobalSettings({ ...globalSettings, heosIp: payload.ip });
      heosClient.connect(payload.ip);
      // After init completes, send result to PI.
      // runInitSequence() returns a Promise (it's async), so we chain on it.
      // The connect handler in heos-client.js stores the init promise as
      // this.initPromise for callers to await.
      heosClient.initPromise
        .then(() => {
          sendToPropertyInspector(action, context, {
            type: 'connectResult',
            success: true,
            players: heosClient.players
          });
        })
        .catch((err) => {
          sendToPropertyInspector(action, context, {
            type: 'error',
            message: 'Connection failed: ' + err.message
          });
        });
      break;

    case 'selectPlayer':
      // Always store playerId as Number internally, String in globalSettings
      const pid = parseInt(payload.pid, 10);
      heosClient.playerId = pid; // Number -- matches parseInt in event handler comparisons
      const player = heosClient.players.find(p => p.pid === pid);
      // Plugin is the sole authority for saving global settings on player selection.
      // The PI should NOT also call saveGlobalSettings (avoids duplicate/racing writes).
      setGlobalSettings({
        ...globalSettings,
        playerId: String(pid), // String for storage, parsed back to Number on startup
        playerName: player ? player.name : 'Unknown'
      });
      heosClient.pollPlayerState(pid).catch(() => {});
      break;

    case 'signIn':
      // HEOS uses a custom URL-encoding: only &, =, % need encoding.
      // Standard encodeURIComponent would encode @, spaces, etc. which HEOS may reject.
      // heosEncode() is exported from heos-client.js (see Phase 1).
      heosClient.enqueue(
        `heos://system/sign_in?un=${heosEncode(payload.username)}&pw=${heosEncode(payload.password)}`
      ).then((resp) => {
        const success = resp.heos.result === 'success';
        heosClient.signedIn = success;
        if (success) {
          // Store username only. Do NOT store password (security).
          setGlobalSettings({ ...globalSettings, heosUsername: payload.username });
        }
        sendToPropertyInspector(action, context, {
          type: 'signInResult',
          success,
          username: success ? payload.username : null
        });
      }).catch((err) => {
        sendToPropertyInspector(action, context, {
          type: 'error',
          message: 'Sign-in failed: ' + err.message
        });
      });
      break;
  }
}
```

---

## Step 5: PI JavaScript Logic (`pi.js` continued)

### `populateGlobalUI()`

- Fill IP field from `globalSettings.heosIp`
- Show connection status

### `populateActionUI()`

- If `currentAction === 'com.vsd.craft.heos.preset'`: show preset section, fill from `currentSettings.presetNumber`
- Otherwise: hide preset section

### `handlePluginData(payload)`

```js
function handlePluginData(payload) {
  switch (payload.type) {
    case 'status':
      document.getElementById('connection-status').textContent =
        payload.connected ? 'Connected' : 'Disconnected';
      if (payload.players && payload.players.length > 0) {
        populatePlayerDropdown(payload.players, payload.selectedPid);
      }
      if (payload.signedIn) {
        document.getElementById('account-status').textContent = 'Signed in';
      }
      break;
    case 'connectResult':
      if (payload.success) {
        document.getElementById('connection-status').textContent = 'Connected';
        populatePlayerDropdown(payload.players, null);
      }
      break;
    case 'error':
      document.getElementById('connection-status').textContent =
        'Error: ' + payload.message;
      break;
    case 'signInResult':
      document.getElementById('account-status').textContent =
        payload.success ? 'Signed in as ' + payload.username : 'Sign-in failed';
      break;
  }
}
```

### `populatePlayerDropdown(players, selectedPid)`

```js
function populatePlayerDropdown(players, selectedPid) {
  const select = document.getElementById('player-select');
  document.getElementById('player-row').style.display = '';
  select.innerHTML = '<option value="">Select a player...</option>';
  for (const player of players) {
    const opt = document.createElement('option');
    opt.value = player.pid;
    opt.textContent = player.name + ' (' + player.model + ')';
    if (player.pid === selectedPid) opt.selected = true;
    select.appendChild(opt);
  }
}
```

### Event Listeners

```js
document.getElementById('btn-connect').addEventListener('click', function() {
  const ip = document.getElementById('heos-ip').value.trim();
  if (!ip) return;
  document.getElementById('connection-status').textContent = 'Connecting...';
  sendToPlugin({ command: 'connect', ip: ip });
});

document.getElementById('player-select').addEventListener('change', function() {
  const pid = this.value;
  if (!pid) return;
  // Only send to plugin -- the plugin-side handler is the sole authority
  // for saving global settings on player selection (avoids duplicate writes).
  sendToPlugin({ command: 'selectPlayer', pid: pid });
});

document.getElementById('preset-number').addEventListener('change', function() {
  const num = parseInt(this.value, 10) || 1;
  saveSettings({ presetNumber: num });
});

document.getElementById('btn-signin').addEventListener('click', function() {
  const un = document.getElementById('heos-username').value.trim();
  const pw = document.getElementById('heos-password').value;
  if (!un || !pw) return;
  sendToPlugin({ command: 'signIn', username: un, password: pw });
});
```

### Helper Functions

```js
function sendToPlugin(payload) {
  websocket.send(JSON.stringify({
    action: currentAction,
    event: 'sendToPlugin',
    context: currentContext,
    payload: payload
  }));
}

function saveSettings(settings) {
  currentSettings = { ...currentSettings, ...settings };
  websocket.send(JSON.stringify({
    event: 'setSettings',
    context: currentContext,
    payload: currentSettings
  }));
}

function saveGlobalSettings(settings) {
  globalSettings = { ...globalSettings, ...settings };
  websocket.send(JSON.stringify({
    event: 'setGlobalSettings',
    context: piUUID,
    payload: globalSettings
  }));
}
```

---

## Step 6: Player Discovery UX Flow (End-to-End)

1. User drags action onto M3 in VSD Craft
2. User clicks action to open Property Inspector
3. VSD Craft calls `connectElgatoStreamDeckSocket` with connection params
4. PI connects WebSocket, registers, requests global settings
5. PI receives `didReceiveGlobalSettings` -- if IP stored, populate field
6. PI sends `getStatus` to plugin
7. Plugin responds with connection state, players, selected player
8. **If not connected:** user types IP, clicks "Connect & Discover"
9. PI sends `{ command: 'connect', ip: '...' }` to plugin
10. Plugin calls `heosClient.connect(ip)`, runs init, discovers players
11. Plugin sends `{ type: 'connectResult', success: true, players: [...] }` to PI
12. PI populates player dropdown
13. User selects player from dropdown
14. PI sends `{ command: 'selectPlayer', pid: ... }` to plugin
15. Plugin saves to global settings, polls player state
16. **All actions now have a valid `playerId` and function correctly**

---

## Step 7: CSS Styling (`pi.css`)

Dark theme matching VSD Craft. Uses `.sdpi-*` class naming conventions. See the full CSS in the plan agent output -- key properties: `#2d2d2d` background, `#ccc` text, `#4a90d9` accent buttons, flex label-value layout for narrow panel.

---

## Critical Edge Cases

1. **PI opens before plugin connected:** `getStatus` returns `connected: false`, empty players. User must enter IP.
2. **PI opens while connected:** `getStatus` provides full state, pre-populate everything.
3. **Global vs per-action settings:** IP and player ID = global (`setGlobalSettings`). Preset number = per-action (`setSettings`).
4. **Player IDs can be negative:** Dropdown `value` as string, `parseInt` handles negatives.
5. **PI uses browser-native WebSocket:** NOT the `ws` package.
6. **Password handling:** Do NOT store password in global settings. Sign-in is session-based. Store username only for display.
7. **IP validation:** Basic format check before sending. Don't validate reachability from PI (browser sandbox).

## Verification

1. Open PI -- connection fields visible, "Not connected"
2. Enter IP, click "Connect & Discover" -- players appear, status "Connected"
3. Select player -- all M3 buttons now work
4. Restart VSD Craft -- settings persist, auto-reconnects
5. Open preset action PI -- preset number field visible
6. Change preset number -- reflected on button
7. Open non-preset action PI -- preset section hidden
8. Test sign-in flow with HEOS credentials
