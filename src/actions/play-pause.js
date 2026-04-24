const fs = require('fs');
const path = require('path');
const { fetchAlbumArt } = require('../image-utils');
const logger = require('../logger');

// showAlbumArt is a global setting (VSD Craft doesn't echo per-action
// didReceiveSettings to the plugin, which broke live toggling).
function isAlbumArtEnabled(vsd) {
  const gs = vsd.getGlobalSettings();
  return gs.showAlbumArt !== false; // default true
}

// Load state icons from disk at startup and cache as base64. Used when we
// build the SVG that shows icon + black-box title band.
// Bundled plugin lives at <plugin_dir>/plugin/index.js; icons are at
// <plugin_dir>/images/actions/. `__dirname` points at the plugin/ subdir.
let _playIconB64 = null;
let _pauseIconB64 = null;
function loadStateIcons() {
  const base = path.join(__dirname, '..', 'images', 'actions');
  try {
    _playIconB64 = fs.readFileSync(path.join(base, 'play.png')).toString('base64');
    _pauseIconB64 = fs.readFileSync(path.join(base, 'pause.png')).toString('base64');
    logger.log('[play-pause] State icons loaded:',
      'play=' + _playIconB64.length + 'b64 pause=' + _pauseIconB64.length + 'b64');
  } catch (e) {
    logger.error('[play-pause] Failed to load state icons:', e.message);
  }
}
loadStateIcons();

function escapeXml(str) {
  return String(str)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build an SVG that shows the state icon centered, with a black translucent
// band along the bottom and the title text on top of the band. Used only for
// the no-album-art path — album art uses the raw data URI to stay under the
// setImage size ceiling.
function buildStateIconSvg(isPlaying, title) {
  const b64 = isPlaying ? _pauseIconB64 : _playIconB64;
  if (!b64) return null;
  const iconHref = `data:image/png;base64,${b64}`;
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="72" height="72">' +
    `<image href="${iconHref}" xlink:href="${iconHref}" width="72" height="72"/>`;
  if (title) {
    svg += '<rect y="54" width="72" height="18" fill="rgba(0,0,0,0.75)"/>' +
      `<text x="36" y="66" font-size="9" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(title)}</text>`;
  }
  svg += '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Title shown below/over the artwork. Prefers the song name; falls back to
// the state-action label ("Play" when paused, "Pause" when playing) so the
// button never shows stale text.
function formatTitle(media, isPlaying) {
  if (media) {
    const artist = media.artist || '';
    const song = media.song || '';
    let title = artist && song ? `${artist} - ${song}` : (song || artist || '');
    if (title.length > 10) title = title.substring(0, 9) + '…';
    if (title) return title;
  }
  return isPlaying ? 'Pause' : 'Play';
}

function updateMediaDisplay(contexts, heosClient, vsd) {
  const media = heosClient.playerState.media;
  const isPlaying = heosClient.playerState.playState === 'play';
  const title = formatTitle(media, isPlaying);
  const showArt = isAlbumArtEnabled(vsd);

  logger.log('[play-pause] media:', media
    ? {
        has_url: !!media.image_url,
        url_len: (media.image_url || '').length,
        url: media.image_url || '',
        song: media.song,
        source: media.station,
        showArt,
        isPlaying
      }
    : { media: null, showArt, isPlaying, title });

  for (const ctx of contexts) {
    if (showArt && media && media.image_url) {
      // Album art path: raw data URI (title overlaid natively by VSD Craft).
      // SVG-wrapping the 100+ KB image would exceed the setImage payload
      // ceiling — see docs/plans/09 and commit history for why.
      fetchAlbumArt(media.image_url).then(uri => {
        if (uri) {
          vsd.setImage(ctx, uri);
          vsd.setTitle(ctx, title);
        } else {
          vsd.setImage(ctx, buildStateIconSvg(isPlaying, title));
          vsd.setTitle(ctx, '');
        }
      }).catch(() => {
        vsd.setImage(ctx, buildStateIconSvg(isPlaying, title));
        vsd.setTitle(ctx, '');
      });
    } else {
      // State-icon path: SVG with icon + black title band so the text is
      // always legible even against a transparent/bright background.
      const svg = buildStateIconSvg(isPlaying, title);
      if (svg) {
        vsd.setImage(ctx, svg);
        vsd.setTitle(ctx, '');
      } else {
        // Fallback: couldn't load icons from disk — let manifest defaults show.
        vsd.setImage(ctx, null);
        vsd.setTitle(ctx, title);
      }
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
    const state = heosClient.playerState.playState === 'play' ? 1 : 0;
    vsd.setState(message.context, state);
    updateMediaDisplay([message.context], heosClient, vsd);
  },

  onGlobalSettingsChange({ contexts, heosClient, vsd }) {
    updateMediaDisplay(contexts, heosClient, vsd);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName === 'event/player_state_changed') {
      const state = params.state === 'play' ? 1 : 0;
      for (const ctx of contexts) {
        vsd.setState(ctx, state);
      }
      // State change flips the icon + action label — re-render every key.
      updateMediaDisplay(contexts, heosClient, vsd);
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
