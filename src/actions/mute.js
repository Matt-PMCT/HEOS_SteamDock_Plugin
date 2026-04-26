module.exports = {
  actionUUID: 'com.vsd.craft.heos.mute',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const newMuteState = !heosClient.playerState.mute;
    heosClient.enqueue(`heos://player/toggle_mute?pid=${pid}`)
      .then(() => {
        vsd.setState(message.context, newMuteState ? 1 : 0);
      })
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { heosClient, vsd }) {
    const state = heosClient.playerState.mute ? 1 : 0;
    vsd.setState(message.context, state);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName !== 'event/player_volume_changed') return;
    // Skip if the event didn't actually carry a mute field — HEOS sends
    // partial volume_changed events during group transitions, and treating
    // a missing field as "unmuted" silently flips the icon. Use the
    // authoritative cached state instead, which heos-client.js only updates
    // when the field is actually present.
    if (params.mute === undefined) return;
    const muteState = heosClient.playerState.mute ? 1 : 0;
    for (const ctx of contexts) {
      vsd.setState(ctx, muteState);
    }
  }
};
