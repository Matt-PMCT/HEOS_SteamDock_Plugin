module.exports = {
  actionUUID: 'com.vsd.craft.heos.mute',

  onKeyDown(message, { heosClient, vsd }) {
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

  onHeosEvent(eventName, params, { contexts, vsd }) {
    if (eventName === 'event/player_volume_changed') {
      const muteState = params.mute === 'on' ? 1 : 0;
      for (const ctx of contexts) {
        vsd.setState(ctx, muteState);
      }
    }
  }
};
