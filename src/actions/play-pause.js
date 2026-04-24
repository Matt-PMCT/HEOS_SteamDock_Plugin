const { fetchAlbumArt } = require('../image-utils');

// Track which contexts have album art enabled (per-action setting)
const _albumArtEnabled = new Map(); // context -> boolean

function formatNowPlaying(media) {
  if (!media) return '';
  const artist = media.artist || '';
  const song = media.song || '';
  let title = artist && song ? `${artist} - ${song}` : (song || artist || '');
  if (title.length > 10) title = title.substring(0, 9) + '\u2026';
  return title;
}

function updateMediaDisplay(contexts, heosClient, vsd) {
  const media = heosClient.playerState.media;
  const title = formatNowPlaying(media);

  for (const ctx of contexts) {
    const showArt = _albumArtEnabled.get(ctx) !== false; // default true

    if (showArt && media && media.image_url) {
      fetchAlbumArt(media.image_url, title).then(svgUri => {
        if (svgUri) {
          vsd.setImage(ctx, svgUri);
          vsd.setTitle(ctx, '');
        } else {
          vsd.setImage(ctx, null);
          vsd.setTitle(ctx, title);
        }
      }).catch(() => {
        vsd.setImage(ctx, null);
        vsd.setTitle(ctx, title);
      });
    } else {
      vsd.setImage(ctx, null);
      vsd.setTitle(ctx, title);
    }
  }
}

module.exports = {
  actionUUID: 'com.vsd.craft.heos.playpause',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
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
    const settings = message.payload.settings || {};
    _albumArtEnabled.set(message.context, settings.showAlbumArt !== false);

    const state = heosClient.playerState.playState === 'play' ? 1 : 0;
    vsd.setState(message.context, state);
    updateMediaDisplay([message.context], heosClient, vsd);
  },

  onWillDisappear(message) {
    _albumArtEnabled.delete(message.context);
  },

  onDidReceiveSettings(message, { heosClient, vsd }) {
    const settings = message.payload.settings || {};
    _albumArtEnabled.set(message.context, settings.showAlbumArt !== false);
    // Re-render with new setting
    updateMediaDisplay([message.context], heosClient, vsd);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
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
    if (eventName === 'event/_media_updated') {
      updateMediaDisplay(contexts, heosClient, vsd);
    }
  }
};
