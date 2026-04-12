# Phase 2: Core Playback Actions

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 1](./01-SKELETON-AND-INFRASTRUCTURE.md) | Next: [Phase 3 -- Volume Knob](./03-VOLUME-KNOB.md)

## Objective

Wire up play/pause toggle, next/previous track, and mute toggle. Also implements the HEOS initialization sequence (event registration, player discovery, state polling) that provides the runtime state all actions need. After this phase, a user can control basic playback from their M3.

**Done when:** Play/pause, next, previous, and mute all work from the M3, and HEOS events update button states in real time.

## Dependencies

Phase 1 must be complete: WebSocket registration, TCP connection, command queue, response parser, event routing.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/heos-client.js` | **Modify** -- add init sequence, player state tracking, HEOS event handling |
| `src/actions/play-pause.js` | **New** |
| `src/actions/next-prev.js` | **New** |
| `src/actions/mute.js` | **New** |
| `src/index.js` | **Modify** -- register handlers, wire HEOS event callbacks |

---

## Step 1: HEOS Initialization Sequence (`heos-client.js`)

### `runInitSequence(playerId)` -- called after TCP connect

Runs the documented initialization commands in order through the queue (see [preliminary doc 02](../preliminary/02-HEOS-PROTOCOL-REFERENCE.md) "Initialization Sequence"):

```js
async runInitSequence(playerId) {
  try {
    // 1. Unregister for events (defensive reset)
    await this.enqueue('heos://system/register_for_change_events?enable=off');

    // 2. Check account status
    const accountResp = await this.enqueue('heos://system/check_account');
    const accountMsg = parseHeosMessage(accountResp.heos.message);
    this.signedIn = accountMsg.signed_in === 'true' || !!accountMsg.un;

    // 2b. Auto-re-sign-in if username stored but not signed in.
    // NOTE: Password is NOT stored (security). This means auto-re-sign-in is
    // impossible without user interaction. If not signed in, streaming presets
    // will fail until the user manually signs in via the Property Inspector.
    // HEOS sessions may persist across TCP connections on the same speaker,
    // but this is not guaranteed. Document this trade-off in user-facing help.
    if (!this.signedIn && this.savedUsername) {
      console.warn('[HEOS] Not signed in. Streaming presets require sign-in via Property Inspector.');
    }

    // 3. Get all players
    const playersResp = await this.enqueue('heos://player/get_players');
    this.players = playersResp.payload || [];

    // 3b. Handle empty player list (CLI module may still be spinning up)
    if (this.players.length === 0) {
      console.warn('[HEOS] No players found. Retrying after 2s delay...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryResp = await this.enqueue('heos://player/get_players');
      this.players = retryResp.payload || [];
      if (this.players.length === 0) {
        console.warn('[HEOS] Still no players found. User may need to check network.');
      }
    }

    // 4. If target player, poll its state; else auto-select first
    // NOTE: playerId must always be stored as a Number (parseInt).
    // globalSettings stores it as String; parse on receipt.
    if (playerId) {
      this.playerId = typeof playerId === 'string' ? parseInt(playerId, 10) : playerId;
      await this.pollPlayerState(this.playerId);
    } else if (this.players.length > 0) {
      this.playerId = this.players[0].pid; // pid from HEOS is already a Number
      await this.pollPlayerState(this.playerId);
    }

    // 5. Register for change events
    await this.enqueue('heos://system/register_for_change_events?enable=on');
  } catch (err) {
    console.error('[HEOS] Init sequence failed:', err.message);
    // Non-fatal: plugin can retry or user can re-trigger via PI
  }
}
```

### `pollPlayerState(pid)`

Enqueues 4 commands sequentially. Using sequential `await` instead of `Promise.all` for clarity -- the queue serializes them anyway, and sequential makes the resolution order explicit and safe.

```js
async pollPlayerState(pid) {
  // Sequential awaits: commands serialize through the queue regardless,
  // and this avoids any risk of response matching ambiguity.
  const stateResp = await this.enqueue(`heos://player/get_play_state?pid=${pid}`);
  const volResp = await this.enqueue(`heos://player/get_volume?pid=${pid}`);
  const muteResp = await this.enqueue(`heos://player/get_mute?pid=${pid}`);
  const mediaResp = await this.enqueue(`heos://player/get_now_playing_media?pid=${pid}`);

  const stateMsg = parseHeosMessage(stateResp.heos.message);
  const volMsg = parseHeosMessage(volResp.heos.message);
  const muteMsg = parseHeosMessage(muteResp.heos.message);

  this.playerState = {
    playState: stateMsg.state,           // 'play', 'pause', 'stop'
    volume: parseInt(volMsg.level, 10),  // 0-100
    mute: muteMsg.state === 'on',        // boolean
    media: mediaResp.payload || null     // { song, artist, album, image_url, ... }
  };
}
```

### State Added to Constructor

```js
this.players = [];           // Array from get_players response
this.playerId = null;        // Currently selected player's pid
this.signedIn = false;       // HEOS account signed in?
this.playerState = {
  playState: 'stop',         // 'play', 'pause', 'stop'
  volume: 0,                 // 0-100
  mute: false,               // boolean
  media: null                // now-playing payload or null
};
```

---

## Step 2: HEOS Event Handling (`heos-client.js`)

Update `routeMessage` to call `this.handleHeosEvent(msg)` instead of `this.eventCallback(msg)` directly.

```js
handleHeosEvent(msg) {
  const eventName = msg.heos.command;
  const params = parseHeosMessage(msg.heos.message);
  const pid = params.pid ? parseInt(params.pid, 10) : null;

  // Only process events for our target player
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
      // Re-fetch media info (event only says "changed", no payload)
      this.enqueue(`heos://player/get_now_playing_media?pid=${this.playerId}`)
        .then(resp => { this.playerState.media = resp.payload || null; })
        .catch(() => {});
      break;

    case 'event/players_changed':
      // Debounce: wait 500ms then re-fetch
      clearTimeout(this._playersChangedTimer);
      this._playersChangedTimer = setTimeout(() => {
        this.enqueue('heos://player/get_players')
          .then(resp => { this.players = resp.payload || []; })
          .catch(() => {});
      }, 500);
      break;

    case 'event/player_playback_error':
      // Playback failed (e.g., network stream dropped, format unsupported)
      console.error('[HEOS] Playback error for player:', pid);
      this.playerState.playState = 'stop';
      break;

    case 'event/user_changed':
      // HEOS account sign-in state changed (e.g., signed out from another app)
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
```

---

## Step 3: `src/actions/play-pause.js`

### Button State Mapping

- **State 0:** play icon, title "Play" -- player is stopped/paused, press will play
- **State 1:** pause icon, title "Pause" -- player is playing, press will pause

### Handler

```js
module.exports = {
  actionUUID: 'com.vsd.craft.heos.playpause',

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    const currentState = heosClient.playerState.playState;
    const newState = (currentState === 'play') ? 'pause' : 'play';

    heosClient.enqueue(`heos://player/set_play_state?pid=${pid}&state=${newState}`)
      .then(() => {
        // Optimistic update
        vsd.setState(message.context, newState === 'play' ? 1 : 0);
      })
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { heosClient, vsd }) {
    const state = heosClient.playerState.playState === 'play' ? 1 : 0;
    vsd.setState(message.context, state);
  },

  onHeosEvent(eventName, params, { contexts, vsd }) {
    if (eventName === 'event/player_state_changed') {
      const state = params.state === 'play' ? 1 : 0;
      for (const ctx of contexts) {
        vsd.setState(ctx, state);
      }
    }
    if (eventName === 'event/player_playback_error') {
      // Playback error: show alert on all play/pause buttons
      for (const ctx of contexts) {
        vsd.showAlert(ctx);
        vsd.setState(ctx, 0); // Reset to play icon (stopped state)
      }
    }
  }
};
```

---

## Step 4: `src/actions/next-prev.js`

Handles two UUIDs with one handler. Checks `message.action` to determine which UUID triggered.

```js
module.exports = {
  actionUUIDs: ['com.vsd.craft.heos.next', 'com.vsd.craft.heos.previous'],

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    const command = message.action === 'com.vsd.craft.heos.next'
      ? `heos://player/play_next?pid=${pid}`
      : `heos://player/play_previous?pid=${pid}`;

    heosClient.enqueue(command)
      .then(() => vsd.showOk(message.context))
      .catch(() => vsd.showAlert(message.context));
  },

  onHeosEvent(eventName, params, { contexts, vsd }) {
    if (eventName === 'event/player_playback_error') {
      for (const ctx of contexts) {
        vsd.showAlert(ctx);
      }
    }
  }
};
```

---

## Step 5: `src/actions/mute.js`

### Button State Mapping

- **State 0:** unmuted icon -- speaker is unmuted
- **State 1:** muted icon -- speaker is muted

```js
module.exports = {
  actionUUID: 'com.vsd.craft.heos.mute',

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    heosClient.enqueue(`heos://player/toggle_mute?pid=${pid}`)
      .then(() => {
        const wasMuted = heosClient.playerState.mute;
        vsd.setState(message.context, wasMuted ? 0 : 1);
      })
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { heosClient, vsd }) {
    const state = heosClient.playerState.mute ? 1 : 0;
    vsd.setState(message.context, state);
  },

  onHeosEvent(eventName, params, { contexts, vsd }) {
    if (eventName === 'event/player_volume_changed') {
      const muteState = params.mute === 'on' ? 1 : 0;
      for (const ctx of contexts) {
        vsd.setState(ctx, muteState);
      }
    }
  }
};
```

---

## Step 6: Update `src/index.js`

### Action Registration

```js
const playPause = require('./actions/play-pause');
const nextPrev = require('./actions/next-prev');
const mute = require('./actions/mute');

const handlers = {};
handlers[playPause.actionUUID] = playPause;
for (const uuid of nextPrev.actionUUIDs) {
  handlers[uuid] = nextPrev;
}
handlers[mute.actionUUID] = mute;
```

### Context Tracking

```js
function getContextsForAction(actionUUID) {
  const contexts = [];
  for (const [ctx, info] of contextMap) {
    if (info.action === actionUUID) contexts.push(ctx);
  }
  return contexts;
}
```

### HEOS Event Callback

Passed to `HeosClient` constructor. Routes events to all registered handlers:

```js
function onHeosEvent(msg) {
  const eventName = msg.heos.command;
  const params = parseHeosMessage(msg.heos.message);

  for (const [uuid, handler] of Object.entries(handlers)) {
    if (handler.onHeosEvent) {
      const contexts = getContextsForAction(uuid);
      if (contexts.length > 0) {
        // Pass heosClient alongside vsd so handlers can access player state
        handler.onHeosEvent(eventName, params, { contexts, heosClient, vsd });
      }
    }
  }
}
```

`vsd` is an object containing all helper functions (`setTitle`, `setState`, etc.). `heosClient` is passed so handlers like volume can access `playerState`.

---

## Critical Edge Cases

1. **No player selected:** all handlers check `heosClient.playerId`, show alert if null
2. **Play on stopped player with empty queue:** `set_play_state?state=play` resumes last queue; if none exists, fails. Show alert.
3. **Multiple instances of same action:** `onHeosEvent` iterates all contexts for that UUID
4. **Race between optimistic update and HEOS event:** harmless (same value), `setState` is idempotent
5. **Next/previous on non-queue sources:** HEOS returns error, show alert
6. **`player_now_playing_changed` requires follow-up command** -- the event only says "changed", plugin must fetch new media info

## Verification

1. Press play/pause -- playback toggles, button icon switches
2. Press next -- track advances
3. Press previous -- track goes back
4. Press mute -- speaker mutes, icon updates; again -- unmutes
5. Change volume from HEOS app -- mute button updates if mute state changes
6. Play/pause from HEOS app -- M3 button state updates
7. Test with no player configured -- shows alert
