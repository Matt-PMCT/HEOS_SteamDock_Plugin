module.exports = {
  actionUUIDs: ['com.vsd.craft.heos.next', 'com.vsd.craft.heos.previous'],

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

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
