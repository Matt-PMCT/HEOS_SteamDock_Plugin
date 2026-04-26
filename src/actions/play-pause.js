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

const DEFAULT_FONT_SIZE = 13;

function clampFontSize(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return DEFAULT_FONT_SIZE;
  if (v < 8) return 8;
  if (v > 20) return 20;
  return v;
}

// Build an SVG that shows the state icon centered, with a black translucent
// band along the bottom and the title text (up to 2 lines) on top of the
// band. Used only for the no-album-art path — album art uses the raw data
// URI to stay under the setImage size ceiling.
function buildStateIconSvg(isPlaying, titleLines, fontSize) {
  const b64 = isPlaying ? _pauseIconB64 : _playIconB64;
  if (!b64) return null;
  const iconHref = `data:image/png;base64,${b64}`;
  const fs = clampFontSize(fontSize);
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="72" height="72">' +
    `<image href="${iconHref}" xlink:href="${iconHref}" width="72" height="72"/>`;

  if (titleLines && titleLines.length > 0) {
    // Band scales with font size. At fontSize=13: single 20px, two-line 34px
    // (matching the prior hard-coded values exactly).
    const lines = titleLines.slice(0, MAX_LINES);
    const bandHeight = lines.length === 1
      ? Math.round(fs * 1.55)
      : Math.round(fs * 2.62);
    const bandY = 72 - bandHeight;
    svg += `<rect y="${bandY}" width="72" height="${bandHeight}" fill="rgba(0,0,0,0.75)"/>`;
    if (lines.length === 1) {
      const ty = bandY + Math.round(bandHeight * 0.7);
      svg += `<text x="36" y="${ty}" font-size="${fs}" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(lines[0])}</text>`;
    } else {
      const ty1 = bandY + Math.round(bandHeight * 0.47);
      const ty2 = bandY + Math.round(bandHeight * 0.88);
      svg += `<text x="36" y="${ty1}" font-size="${fs}" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(lines[0])}</text>` +
        `<text x="36" y="${ty2}" font-size="${fs}" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(lines[1])}</text>`;
    }
  }

  svg += '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Word-wrap titles across ≤2 lines of ~10 chars each.
const MAX_CHARS_PER_LINE = 10;
const MAX_LINES = 2;

function wrapTitle(text) {
  if (!text) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length <= MAX_CHARS_PER_LINE) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        if (lines.length >= MAX_LINES) { current = ''; break; }
      }
      current = word.length > MAX_CHARS_PER_LINE
        ? word.substring(0, MAX_CHARS_PER_LINE - 1) + '…'
        : word;
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current);

  // If we ran out of lines before consuming all text, ellipsize the last line.
  const producedChars = lines.join(' ').length;
  if (lines.length === MAX_LINES && text.length > producedChars) {
    const last = lines[MAX_LINES - 1];
    if (!last.endsWith('…')) {
      lines[MAX_LINES - 1] = last.length >= MAX_CHARS_PER_LINE
        ? last.substring(0, MAX_CHARS_PER_LINE - 1) + '…'
        : last + '…';
    }
  }
  return lines;
}

function clipLine(text) {
  if (!text) return '';
  return text.length > MAX_CHARS_PER_LINE
    ? text.substring(0, MAX_CHARS_PER_LINE - 1) + '…'
    : text;
}

// HEOS reports a generic "URL Stream" for song & artist when playing a
// `play_stream` URL (arbitrary audio). Detect that so the play-url override
// metadata can take over.
function isGenericStreamLabel(text) {
  const t = (text || '').trim();
  if (!t) return true;
  return /^url\s*stream$/i.test(t);
}

// Title shown below/over the artwork. If both song and artist are available
// they go on separate lines (line 1 = song, line 2 = artist, each clipped
// independently). If only one, wrap it across both lines. Falls back to the
// state-action label ("Play" paused / "Pause" playing) when nothing is
// playing so the button never shows stale text.
function formatTitleLines(media, isPlaying, override) {
  const song = (media && media.song || '').trim();
  const artist = (media && media.artist || '').trim();

  // Substitute play-url's override when HEOS is reporting the generic URL
  // Stream placeholder. If the user later plays real content (Spotify, preset,
  // etc.), HEOS reports real song/artist and the override stays dormant.
  if (override && isGenericStreamLabel(song) && isGenericStreamLabel(artist)) {
    const os = (override.song || '').trim();
    const oa = (override.artist || '').trim();
    if (os && oa) return [clipLine(os), clipLine(oa)];
    const candidate = os || oa;
    if (candidate) return wrapTitle(candidate);
  }

  if (media) {
    if (song && artist) return [clipLine(song), clipLine(artist)];
    const candidate = song || artist;
    if (candidate) return wrapTitle(candidate);
  }
  return [isPlaying ? 'Pause' : 'Play'];
}

// Per-context settings cache. play-pause's renderer is invoked in many places
// that don't carry the per-action settings (HEOS events, global-settings
// refresh), so we stash the latest settings here keyed by context.
const _settingsByContext = new Map();

// Per-context render throttle. updateMediaDisplay can dispatch setImage with
// a large album-art payload (≥100 KB base64). During event bursts (e.g. a
// group composition change firing many state/now-playing events), unthrottled
// renders flood the WebSocket queue and stall VSD Craft. 200ms trailing per
// context keeps the WS quiet without hurting perceived responsiveness.
const RENDER_THROTTLE_MS = 200;
const _renderState = new Map(); // ctx -> { lastAt, timer }

function scheduleMediaDisplay(contexts, heosClient, vsd) {
  const now = Date.now();
  for (const ctx of contexts) {
    let entry = _renderState.get(ctx);
    if (!entry) {
      entry = { lastAt: 0, timer: null };
      _renderState.set(ctx, entry);
    }
    const elapsed = now - entry.lastAt;
    if (elapsed >= RENDER_THROTTLE_MS) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      entry.lastAt = now;
      updateMediaDisplay([ctx], heosClient, vsd);
    } else if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.lastAt = Date.now();
        updateMediaDisplay([ctx], heosClient, vsd);
      }, RENDER_THROTTLE_MS - elapsed);
    }
    // else: a trailing render is already queued — it will pick up the latest
    // playerState at fire time, so no extra work needed.
  }
}

function updateMediaDisplay(contexts, heosClient, vsd) {
  const media = heosClient.playerState.media;
  const isPlaying = heosClient.playerState.playState === 'play';
  const titleLines = formatTitleLines(media, isPlaying, heosClient.streamMetadataOverride);
  const titleJoined = titleLines.join('\n'); // for native setTitle
  const showArt = isAlbumArtEnabled(vsd);

  logger.log('[play-pause] media:', media
    ? {
        has_url: !!media.image_url,
        url_len: (media.image_url || '').length,
        url: media.image_url || '',
        song: media.song,
        artist: media.artist,
        album: media.album,
        source: media.station,
        showArt,
        isPlaying,
        rendered_lines: titleLines
      }
    : { media: null, showArt, isPlaying, rendered_lines: titleLines });

  for (const ctx of contexts) {
    const fontSize = (_settingsByContext.get(ctx) || {}).labelFontSize;
    if (showArt && media && media.image_url) {
      // Album art path: raw data URI (title overlaid natively by VSD Craft
      // — it accepts \n for multi-line). SVG-wrapping the 100+ KB image
      // would exceed the setImage payload ceiling.
      fetchAlbumArt(media.image_url).then(uri => {
        if (uri) {
          vsd.setImage(ctx, uri);
          vsd.setTitle(ctx, titleJoined);
        } else {
          vsd.setImage(ctx, buildStateIconSvg(isPlaying, titleLines, fontSize));
          vsd.setTitle(ctx, '');
        }
      }).catch(() => {
        vsd.setImage(ctx, buildStateIconSvg(isPlaying, titleLines, fontSize));
        vsd.setTitle(ctx, '');
      });
    } else {
      const svg = buildStateIconSvg(isPlaying, titleLines, fontSize);
      if (svg) {
        vsd.setImage(ctx, svg);
        vsd.setTitle(ctx, '');
      } else {
        vsd.setImage(ctx, null);
        vsd.setTitle(ctx, titleJoined);
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
    _settingsByContext.set(message.context, message.payload.settings || {});
    updateMediaDisplay([message.context], heosClient, vsd);
  },

  onWillDisappear(message) {
    _settingsByContext.delete(message.context);
    const r = _renderState.get(message.context);
    if (r && r.timer) clearTimeout(r.timer);
    _renderState.delete(message.context);
  },

  onDidReceiveSettings(message, { heosClient, vsd }) {
    _settingsByContext.set(message.context, message.payload.settings || {});
    updateMediaDisplay([message.context], heosClient, vsd);
  },

  onGlobalSettingsChange({ contexts, heosClient, vsd }) {
    // The PI piggybacks per-action setting updates on globalSettings via the
    // shared `_buttonRefresh` channel (see button-refresh.js). Pick up our
    // own action's payload and refresh the cached settings before re-rendering.
    const refresh = vsd.getGlobalSettings && vsd.getGlobalSettings()._buttonRefresh;
    if (refresh && refresh.action === module.exports.actionUUID && refresh.context && refresh.settings) {
      _settingsByContext.set(refresh.context, refresh.settings);
    }
    scheduleMediaDisplay(contexts, heosClient, vsd);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName === 'event/player_state_changed') {
      const state = params.state === 'play' ? 1 : 0;
      for (const ctx of contexts) {
        vsd.setState(ctx, state);
      }
      // State change flips the icon + action label — re-render through the
      // per-context throttle to absorb event bursts.
      scheduleMediaDisplay(contexts, heosClient, vsd);
    }
    if (eventName === 'event/player_playback_error') {
      for (const ctx of contexts) {
        vsd.showAlert(ctx);
        vsd.setState(ctx, 0);
      }
    }
    if (eventName === 'event/_media_updated') {
      scheduleMediaDisplay(contexts, heosClient, vsd);
    }
  }
};
