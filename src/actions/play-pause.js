module.exports = {
  actionUUID: 'com.vsd.craft.heos.playpause',

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const currentState = heosClient.playerState.playState;
    const newState = (currentState === 'play') ? 'pause' : 'play';

    heosClient.enqueue(`heos://player/set_play_state?pid=${pid}&state=${newState}`)
      .then(() => {
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
      for (const ctx of contexts) {
        vsd.showAlert(ctx);
        vsd.setState(ctx, 0);
      }
    }
  }
};
