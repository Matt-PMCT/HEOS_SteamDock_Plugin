const REPEAT_CYCLE = ['off', 'on_all', 'on_one'];
const REPEAT_STATE_MAP = { off: 0, on_all: 1, on_one: 2 };

module.exports = {
  actionUUIDs: ['com.vsd.craft.heos.repeat', 'com.vsd.craft.heos.shuffle'],

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    let nextRepeat = heosClient.playerState.repeatMode;
    let nextShuffle = heosClient.playerState.shuffleMode;

    if (message.action === 'com.vsd.craft.heos.repeat') {
      const idx = REPEAT_CYCLE.indexOf(nextRepeat);
      nextRepeat = REPEAT_CYCLE[(idx + 1) % REPEAT_CYCLE.length];
    } else {
      nextShuffle = nextShuffle === 'on' ? 'off' : 'on';
    }

    // Optimistically update local state to prevent race on rapid presses
    heosClient.playerState.repeatMode = nextRepeat;
    heosClient.playerState.shuffleMode = nextShuffle;

    heosClient.enqueue(`heos://player/set_play_mode?pid=${pid}&repeat=${nextRepeat}&shuffle=${nextShuffle}`)
      .then(() => {
        if (message.action === 'com.vsd.craft.heos.repeat') {
          vsd.setState(message.context, REPEAT_STATE_MAP[nextRepeat] ?? 0);
        } else {
          vsd.setState(message.context, nextShuffle === 'on' ? 1 : 0);
        }
      })
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { heosClient, vsd }) {
    if (message.action === 'com.vsd.craft.heos.repeat') {
      vsd.setState(message.context, REPEAT_STATE_MAP[heosClient.playerState.repeatMode] ?? 0);
    } else {
      vsd.setState(message.context, heosClient.playerState.shuffleMode === 'on' ? 1 : 0);
    }
  },

  onHeosEvent(eventName, params, { uuid, contexts, vsd }) {
    if (uuid === 'com.vsd.craft.heos.repeat' && eventName === 'event/repeat_mode_changed') {
      const state = REPEAT_STATE_MAP[params.repeat] ?? 0;
      for (const ctx of contexts) vsd.setState(ctx, state);
    }
    if (uuid === 'com.vsd.craft.heos.shuffle' && eventName === 'event/shuffle_mode_changed') {
      const state = params.shuffle === 'on' ? 1 : 0;
      for (const ctx of contexts) vsd.setState(ctx, state);
    }
  }
};
