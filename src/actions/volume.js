const { parseHeosMessage } = require('../heos-client');

const DEBOUNCE_MS = 50;
const DISPLAY_THROTTLE_MS = 100;
const MAX_CHANGE_PER_FLUSH = 25; // Cap per-flush volume change to prevent extreme jumps

module.exports = {
  actionUUID: 'com.vsd.craft.heos.volume',

  // Per-context state (supports multiple volume knobs)
  _state: new Map(),

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
    if (!heosClient.isConnected()) return; // State listener already shows alert
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const ticks = message.payload.ticks;
    const state = this._getState(message.context);

    // Accumulate ticks
    state.pendingDelta += ticks;

    // Compute projected target for immediate display feedback
    const projected = this._computeTarget(heosClient.playerState.volume, state.pendingDelta);

    // Update display (throttled)
    this._updateDisplay(message.context, projected, heosClient.playerState.mute, vsd, state);

    // Reset debounce timer
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this._flush(message.context, heosClient, vsd);
    }, DEBOUNCE_MS);
  },

  _flush(context, heosClient, vsd) {
    // Guard: context may have disappeared while debounce timer was pending
    if (!this._state.has(context)) return;

    const state = this._state.get(context);
    if (state.pendingDelta === 0) return;

    if (!heosClient.isConnected()) {
      state.pendingDelta = 0;
      vsd.showAlert(context);
      return;
    }
    const pid = heosClient.playerId;
    if (pid == null) {
      state.pendingDelta = 0;
      vsd.showAlert(context);
      return;
    }

    const targetVolume = this._computeTarget(heosClient.playerState.volume, state.pendingDelta);

    // Reset accumulator BEFORE sending (new events accumulate fresh)
    state.pendingDelta = 0;

    // Optimistically update local state
    heosClient.playerState.volume = targetVolume;

    // Send via priority enqueue (replaces pending volume commands in queue)
    heosClient.enqueueVolume(pid, targetVolume)
      .catch((err) => {
        // Replaced by a newer volume command — expected during fast rotation
        if (err.message === 'Replaced by newer volume command') return;
        // Real error: re-poll actual volume to resync local state
        heosClient.enqueue(`heos://player/get_volume?pid=${pid}`)
          .then(resp => {
            const params = parseHeosMessage(resp.heos.message);
            heosClient.playerState.volume = parseInt(params.level, 10);
            this._setDisplay(context, heosClient.playerState.volume, heosClient.playerState.mute, vsd);
          })
          .catch(() => {}); // Next HEOS event will resync
        vsd.showAlert(context);
      });
  },

  onDialDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    heosClient.enqueue(`heos://player/toggle_mute?pid=${pid}`)
      .catch(() => vsd.showAlert(message.context));
  },

  // onDialUp intentionally NOT implemented.
  // StreamDock fires dialUp immediately after dialDown — unreliable for actions.

  onWillAppear(message, { heosClient, vsd }) {
    this._getState(message.context);
    this._setDisplay(message.context, heosClient.playerState.volume, heosClient.playerState.mute, vsd);
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
        // Skip display update if user is actively rotating this knob
        const state = this._state.get(ctx);
        if (state && state.pendingDelta !== 0) continue;
        this._setDisplay(ctx, vol, muted, vsd);
      }
    }
  },

  // --- Helpers ---

  _computeTarget(currentVolume, pendingDelta) {
    const stepSize = this._getStepSize(pendingDelta);
    const rawDelta = pendingDelta * stepSize;
    // Cap per-flush change to prevent extreme jumps on very fast rotation
    const cappedDelta = Math.max(-MAX_CHANGE_PER_FLUSH, Math.min(MAX_CHANGE_PER_FLUSH, rawDelta));
    return Math.round(this._clamp(currentVolume + cappedDelta, 0, 100));
  },

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
  }
};
