# Phase 3: Volume Knob

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 2](./02-CORE-PLAYBACK-ACTIONS.md) | Next: [Phase 4 -- Preset Buttons](./04-PRESET-BUTTONS.md)

## Objective

Implement smooth, responsive volume control via the M3's rotary encoders. This is the most technically demanding action: it must debounce rapid `dialRotate` events, manage a local volume shadow state, replace stale volume commands in the queue, and scale step size based on rotation speed. A naive implementation sending one `set_volume` per tick overflows the HEOS command queue and causes disconnections.

**Done when:** Rotating a knob smoothly adjusts volume, pressing it mutes, and the display stays in sync.

## Dependencies

Phase 1 (command queue, TCP connection) and Phase 2 (player state tracking, HEOS events, init sequence).

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/actions/volume.js` | **New** -- volume knob handler |
| `src/heos-client.js` | **Modify** -- add `enqueueVolume()` with queue replacement |
| `src/index.js` | **Modify** -- register volume handler |

---

## Step 1: Debounce Architecture

### Strategy: Accumulate-Then-Flush with Trailing-Edge Debounce

```
dialRotate event arrives
  |
  v
Accumulate ticks into pendingDelta
  |
  v
Compute projected targetVolume for immediate display feedback
  |
  v
Reset/restart debounce timer (50ms)
  |
  v
[Timer fires]
  |
  v
Call heosClient.enqueueVolume(pid, targetVolume)
  |
  v
Reset pendingDelta = 0, optimistically update local volume
```

**Why 50ms debounce:** Fast enough for perceived immediacy (human perception threshold ~100ms), long enough to collapse a burst of rapid ticks. Aligns with HEOS ~50-150ms command round-trip.

---

## Step 2: Adaptive Step Scaling

Applied at flush time based on accumulated ticks in the debounce window. Fast rotation naturally produces more ticks, which scales the volume change:

```js
function getStepSize(accumulatedTicks) {
  const abs = Math.abs(accumulatedTicks);
  if (abs <= 2) return 2;   // fine: 2% per tick
  if (abs <= 5) return 3;   // medium: 3% per tick
  return 5;                  // coarse: 5% per tick
}

// Applied at flush:
// targetVolume = clamp(currentVolume + accumulatedTicks * getStepSize(accumulatedTicks), 0, 100)
```

---

## Step 3: `src/actions/volume.js`

```js
const { parseHeosMessage } = require('../heos-client');
const DEBOUNCE_MS = 50;
const DISPLAY_THROTTLE_MS = 100; // Max 10 display updates/sec

module.exports = {
  actionUUID: 'com.vsd.craft.heos.volume',

  // Per-context state (supports multiple volume knobs)
  _state: new Map(), // Map<context, { pendingDelta, debounceTimer, lastDisplayUpdate }>

  _getState(context) {
    if (!this._state.has(context)) {
      this._state.set(context, {
        pendingDelta: 0,
        debounceTimer: null,
        lastDisplayUpdate: 0
      });
    }
    return this._state.get(context);
  },

  onDialRotate(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    const ticks = message.payload.ticks; // positive = CW, negative = CCW
    const state = this._getState(message.context);

    // Accumulate ticks
    state.pendingDelta += ticks;

    // Compute projected target for immediate display feedback
    const stepSize = this._getStepSize(state.pendingDelta);
    const projected = this._clamp(
      heosClient.playerState.volume + state.pendingDelta * stepSize, 0, 100
    );

    // Update display (throttled)
    this._updateDisplay(message.context, projected, heosClient.playerState.mute, vsd, state);

    // Reset debounce timer
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this._flush(message.context, heosClient, vsd);
    }, DEBOUNCE_MS);
  },

  _flush(context, heosClient, vsd) {
    const state = this._getState(context);
    if (state.pendingDelta === 0) return;

    const pid = heosClient.playerId;
    const stepSize = this._getStepSize(state.pendingDelta);
    const targetVolume = this._clamp(
      heosClient.playerState.volume + state.pendingDelta * stepSize, 0, 100
    );

    // Reset accumulator BEFORE sending (new events accumulate fresh)
    state.pendingDelta = 0;

    // Optimistically update local state
    heosClient.playerState.volume = targetVolume;

    // Send via priority enqueue (replaces pending volume commands in queue)
    heosClient.enqueueVolume(pid, targetVolume)
      .catch(() => {
        // Volume command failed (connection error or HEOS rejection).
        // Re-poll actual volume to resync local state and prevent permanent divergence.
        heosClient.enqueue(`heos://player/get_volume?pid=${pid}`)
          .then(resp => {
            const params = parseHeosMessage(resp.heos.message);
            heosClient.playerState.volume = parseInt(params.level, 10);
            this._setDisplay(context, heosClient.playerState.volume, heosClient.playerState.mute, vsd);
          })
          .catch(() => {}); // If re-poll also fails, next HEOS event will resync
        vsd.showAlert(context);
      });
  },

  onDialDown(message, { heosClient, vsd }) {
    // Knob press = mute toggle
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    heosClient.enqueue(`heos://player/toggle_mute?pid=${pid}`)
      .catch(() => vsd.showAlert(message.context));
  },

  // NOTE: onDialUp intentionally NOT implemented.
  // StreamDock fires dialUp immediately after dialDown, making long-press unreliable.
  // See cross-cutting concerns in 08-CROSS-CUTTING-CONCERNS.md

  onWillAppear(message, { heosClient, vsd }) {
    this._getState(message.context);
    const vol = heosClient.playerState.volume;
    const muted = heosClient.playerState.mute;
    this._setDisplay(message.context, vol, muted, vsd);
  },

  onWillDisappear(message) {
    const state = this._state.get(message.context);
    if (state) {
      clearTimeout(state.debounceTimer);
    }
    this._state.delete(message.context);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName === 'event/player_volume_changed') {
      const vol = parseInt(params.level, 10);
      const muted = params.mute === 'on';
      for (const ctx of contexts) {
        this._setDisplay(ctx, vol, muted, vsd);
      }
    }
  },

  // --- Helpers ---

  _getStepSize(accumulatedTicks) {
    const abs = Math.abs(accumulatedTicks);
    if (abs <= 2) return 2;
    if (abs <= 5) return 3;
    return 5;
  },

  _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  },

  _updateDisplay(context, volume, muted, vsd, state) {
    const now = Date.now();
    if (now - state.lastDisplayUpdate < DISPLAY_THROTTLE_MS) return;
    state.lastDisplayUpdate = now;
    this._setDisplay(context, volume, muted, vsd);
  },

  _setDisplay(context, volume, muted, vsd) {
    const title = muted ? 'MUTE' : `Vol: ${volume}`;
    vsd.setTitle(context, title);
    // Optional Phase 7: render SVG volume arc via setImage
  }
};
```

---

## Step 4: `enqueueVolume()` in `heos-client.js`

Queue replacement logic: removes any existing `set_volume` commands from the queue (not the in-flight one) and enqueues the new one with the latest target.

```js
enqueueVolume(pid, level) {
  const command = `heos://player/set_volume?pid=${pid}&level=${level}`;

  // Remove stale volume commands from queue (not the pending one)
  this.queue = this.queue.filter(entry => {
    if (entry.command.includes('player/set_volume')) {
      // Resolve with marker so callers don't hang
      entry.resolve({ replaced: true });
      clearTimeout(entry.timeoutId);
      return false;
    }
    return true;
  });

  return this.enqueue(command);
}
```

If a volume command is already in-flight (`this.pending`), it completes naturally. The next `set_volume` with the updated target follows immediately.

---

## Step 5: Display Update Strategy

Two paths:

1. **During active rotation (user-driven):** Update title immediately with projected target. Throttled to 100ms intervals to avoid flooding VSD Craft with `setTitle` calls.
2. **From HEOS events (external changes):** Update when `player_volume_changed` arrives. Already naturally debounced.

The knob uses `setTitle` only (no multi-state toggle). Optional SVG volume arc via `setImage` is deferred to Phase 7.

---

## Critical Edge Cases

1. **Volume command in flight + new rotation:** Accumulator uses `heosClient.playerState.volume` which was optimistically updated to last sent value. New ticks add on top of the sent value, not the old value. Correct.
2. **External volume change during rotation:** If HEOS event arrives while `pendingDelta !== 0`, the event updates `playerState.volume`. Next flush computes from the externally-changed value plus delta. Could cause a jump. Mitigation: when a HEOS volume event arrives during active rotation, let the user's rotation take priority and don't update the display.
3. **Volume at boundary (0 or 100):** `_clamp` prevents overshoot. HEOS also clamps, but sending exactly 0 or 100 avoids error 9 (parameter out of range).
4. **dialDown fires dialUp immediately:** Do NOT use `dialUp` for anything. Mute toggle on `dialDown` only.
5. **Mute during volume rotation:** Mute command goes through regular queue. Volume debounce fires too. HEOS handles volume changes while muted silently (take effect on unmute).
6. **Multiple knob instances:** Each context gets independent debounce state via `_state` Map. All control the same player but track their own pending deltas.

## Verification

1. Assign volume action to M3 knob
2. Slow rotation (1 tick at a time) -- volume changes ~2% per tick
3. Fast rotation -- volume changes more aggressively per burst
4. Display shows "Vol: XX" updating smoothly
5. Press knob -- mutes, shows "MUTE". Press again -- unmutes
6. Change volume from HEOS app -- M3 display updates
7. Rapid 5+ second rotation -- no disconnection or errors
8. Rotate to 0 -- stops at 0. Rotate to 100 -- stops at 100
9. Monitor TCP: only 1-3 `set_volume` commands during rapid burst (not 15+)
