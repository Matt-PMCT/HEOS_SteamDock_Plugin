const { parseHeosMessage } = require('../heos-client');

const DEBOUNCE_MS = 50;
const DISPLAY_THROTTLE_MS = 100;
const MAX_CHANGE_PER_FLUSH = 25;

module.exports = {
  actionUUID: 'com.vsd.craft.heos.groupvolume',

  _state: new Map(),

  _getState(context) {
    if (!this._state.has(context)) {
      this._state.set(context, {
        pendingDelta: 0,
        debounceTimer: null,
        lastDisplayUpdate: 0,
        resolvedGid: null
      });
    }
    return this._state.get(context);
  },

  _findGroupForPlayer(heosClient) {
    const pid = heosClient.playerId;
    for (const group of heosClient.groups) {
      const pids = (group.players || []).map(p => parseInt(p.pid, 10));
      if (pids.includes(pid)) return parseInt(group.gid, 10);
    }
    return null;
  },

  _resolveAndStoreGid(context, message, heosClient) {
    const settings = (message && message.payload && message.payload.settings) || {};
    const gid = settings.groupGid ? parseInt(settings.groupGid, 10) : this._findGroupForPlayer(heosClient);
    const state = this._getState(context);
    state.resolvedGid = gid;
    return gid;
  },

  _getGroupVolume(gid, heosClient) {
    const gs = heosClient.groupState[gid];
    return gs ? gs.volume : 0;
  },

  _getGroupMute(gid, heosClient) {
    const gs = heosClient.groupState[gid];
    return gs ? gs.mute : false;
  },

  onDialRotate(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) return;
    const gid = this._resolveAndStoreGid(message.context, message, heosClient);
    if (gid == null) { vsd.showAlert(message.context); return; }

    const ticks = message.payload.ticks;
    const state = this._getState(message.context);

    state.pendingDelta += ticks;

    const currentVol = this._getGroupVolume(gid, heosClient);
    const projected = this._computeTarget(currentVol, state.pendingDelta);

    this._updateDisplay(message.context, projected, this._getGroupMute(gid, heosClient), vsd, state);

    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this._flush(message.context, heosClient, vsd);
    }, DEBOUNCE_MS);
  },

  _flush(context, heosClient, vsd) {
    if (!this._state.has(context)) return;

    const state = this._state.get(context);
    if (state.pendingDelta === 0) return;

    if (!heosClient.isConnected()) {
      state.pendingDelta = 0;
      vsd.showAlert(context);
      return;
    }
    const gid = state.resolvedGid;
    if (gid == null) {
      state.pendingDelta = 0;
      vsd.showAlert(context);
      return;
    }

    const currentVol = this._getGroupVolume(gid, heosClient);
    const targetVolume = this._computeTarget(currentVol, state.pendingDelta);

    state.pendingDelta = 0;

    // Optimistically update local state
    if (!heosClient.groupState[gid]) heosClient.groupState[gid] = { volume: 0, mute: false };
    heosClient.groupState[gid].volume = targetVolume;

    heosClient.enqueueGroupVolume(gid, targetVolume)
      .catch((err) => {
        if (err.message === 'Replaced by newer group volume command') return;
        heosClient.enqueue(`heos://group/get_volume?gid=${gid}`)
          .then(resp => {
            const params = parseHeosMessage(resp.heos.message);
            if (!heosClient.groupState[gid]) heosClient.groupState[gid] = { volume: 0, mute: false };
            heosClient.groupState[gid].volume = parseInt(params.level, 10);
            this._setDisplay(context, heosClient.groupState[gid].volume, heosClient.groupState[gid].mute, vsd);
          })
          .catch(() => {});
        vsd.showAlert(context);
      });
  },

  onDialDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const gid = this._resolveAndStoreGid(message.context, message, heosClient);
    if (gid == null) { vsd.showAlert(message.context); return; }

    heosClient.enqueue(`heos://group/toggle_mute?gid=${gid}`)
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { heosClient, vsd }) {
    const gid = this._resolveAndStoreGid(message.context, message, heosClient);
    if (gid != null) {
      this._setDisplay(message.context, this._getGroupVolume(gid, heosClient), this._getGroupMute(gid, heosClient), vsd);
    } else {
      vsd.setTitle(message.context, 'Grp Vol');
    }
  },

  onWillDisappear(message, { heosClient, vsd }) {
    const state = this._state.get(message.context);
    if (state) {
      clearTimeout(state.debounceTimer);
      if (state.pendingDelta !== 0 && heosClient && heosClient.isConnected()) {
        this._flush(message.context, heosClient, vsd);
      }
    }
    this._state.delete(message.context);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName === 'event/group_volume_changed') {
      const eventGid = params.gid ? parseInt(params.gid, 10) : null;
      for (const ctx of contexts) {
        const state = this._state.get(ctx);
        if (state && state.pendingDelta !== 0) continue;
        const ctxGid = state ? state.resolvedGid : this._findGroupForPlayer(heosClient);
        if (eventGid === ctxGid || eventGid === null) {
          // Read from the authoritative cached state — heos-client.js validates
          // the event fields and only writes to groupState when level/mute are
          // actually present, so partial events (common during group transitions)
          // can't blank the display to NaN/0.
          const gs = heosClient.groupState[eventGid] || {};
          const vol = gs.volume;
          const muted = !!gs.mute;
          if (vol === undefined || vol === null) continue;
          this._setDisplay(ctx, vol, muted, vsd);
        }
      }
    } else if (eventName === 'event/groups_changed') {
      // Group composition changed — any pending delta targets a gid that may no
      // longer exist or may no longer contain our player. Drop it and force the
      // next rotate to re-resolve.
      for (const ctx of contexts) {
        const state = this._state.get(ctx);
        if (state) {
          state.pendingDelta = 0;
          state.resolvedGid = null;
        }
      }
    }
  },

  // --- Helpers ---

  _computeTarget(currentVolume, pendingDelta) {
    const stepSize = this._getStepSize(pendingDelta);
    const rawDelta = pendingDelta * stepSize;
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
    const title = muted ? 'GRP MUTE' : `Grp: ${volume}`;
    vsd.setTitle(context, title);
  }
};
