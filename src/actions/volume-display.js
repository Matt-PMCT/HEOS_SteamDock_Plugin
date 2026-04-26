const { sanitizeColor } = require('../button-render');

const RENDER_THROTTLE_MS = 60;
const DEFAULT_FONT_SIZE = 36;

// The shared sanitizeFontSize in button-render caps at 22 to keep label
// bands sane; this action's number takes the whole tile, so it has its own
// wider cap.
function clampDigitFontSize(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return DEFAULT_FONT_SIZE;
  if (v < 16) return 16;
  if (v > 60) return 60;
  return v;
}

function escapeXml(str) {
  return String(str)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 72×72 readout tile: solid background, big centered volume number, small
// "M" pill bottom-right when muted (number dims to 0.45 opacity).
function buildVolumeSvg(color, volume, muted, fontSize) {
  const bg = sanitizeColor(color);
  const fs = clampDigitFontSize(fontSize);
  const v = Math.max(0, Math.min(100, parseInt(volume, 10) || 0));
  // Optical-center the digits: baseline lands a little below the geometric
  // center because text sits above its baseline.
  const textY = 36 + Math.round(fs * 0.36);
  const opacity = muted ? '0.45' : '1';
  const numText = escapeXml(String(v));
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">' +
    `<rect width="72" height="72" fill="${bg}"/>` +
    `<text x="36" y="${textY}" font-size="${fs}" fill="white" fill-opacity="${opacity}"` +
    ` text-anchor="middle" font-family="sans-serif" font-weight="bold">${numText}</text>`;
  if (muted) {
    svg += '<rect x="48" y="54" width="20" height="14" rx="3" fill="rgba(0,0,0,0.7)"/>' +
      '<text x="58" y="64" font-size="11" font-weight="bold" fill="white"' +
      ' text-anchor="middle" font-family="sans-serif">M</text>';
  }
  svg += '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Per-context state: cached settings + render throttle.
const _byContext = new Map();

function getCtx(context) {
  if (!_byContext.has(context)) {
    _byContext.set(context, { settings: {}, lastRenderAt: 0, timer: null });
  }
  return _byContext.get(context);
}

function renderNow(context, heosClient, vsd) {
  const entry = _byContext.get(context);
  if (!entry) return;
  const { settings } = entry;
  const vol = heosClient.playerState.volume;
  const muted = !!heosClient.playerState.mute;
  vsd.setImage(context, buildVolumeSvg(settings.iconColor, vol, muted, settings.labelFontSize));
  vsd.setTitle(context, '');
  entry.lastRenderAt = Date.now();
}

// Throttle: render immediately if past the cooldown, otherwise schedule a
// single trailing render. Always reads fresh state from heosClient at fire
// time, so coalesced events still surface the latest value.
function scheduleRender(context, heosClient, vsd) {
  const entry = getCtx(context);
  const now = Date.now();
  const elapsed = now - entry.lastRenderAt;
  if (elapsed >= RENDER_THROTTLE_MS) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    renderNow(context, heosClient, vsd);
    return;
  }
  if (entry.timer) return; // a trailing render is already queued
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (_byContext.has(context)) renderNow(context, heosClient, vsd);
  }, RENDER_THROTTLE_MS - elapsed);
}

module.exports = {
  actionUUID: 'com.vsd.craft.heos.volumedisplay',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    // Optimistic flip: the speaker's volume_changed event will land shortly
    // and confirm. Without this the button feels laggy on press.
    heosClient.playerState.mute = !heosClient.playerState.mute;
    renderNow(message.context, heosClient, vsd);

    heosClient.enqueue(`heos://player/toggle_mute?pid=${pid}`)
      .catch(() => {
        // Roll back the optimistic flip on failure
        heosClient.playerState.mute = !heosClient.playerState.mute;
        renderNow(message.context, heosClient, vsd);
        vsd.showAlert(message.context);
      });
  },

  onWillAppear(message, { heosClient, vsd }) {
    const entry = getCtx(message.context);
    entry.settings = message.payload.settings || {};
    renderNow(message.context, heosClient, vsd);
  },

  onWillDisappear(message) {
    const entry = _byContext.get(message.context);
    if (entry && entry.timer) clearTimeout(entry.timer);
    _byContext.delete(message.context);
  },

  onDidReceiveSettings(message, { heosClient, vsd }) {
    const entry = getCtx(message.context);
    entry.settings = message.payload.settings || {};
    renderNow(message.context, heosClient, vsd);
  },

  onHeosEvent(eventName, params, { contexts, heosClient, vsd }) {
    if (eventName !== 'event/player_volume_changed') return;
    for (const ctx of contexts) {
      scheduleRender(ctx, heosClient, vsd);
    }
  },

  onGlobalSettingsChange({ contexts, heosClient, vsd }) {
    // Pick up appearance updates piggy-backed on globalSettings._buttonRefresh
    // (same channel the trigger buttons + play-pause use).
    const gs = vsd.getGlobalSettings && vsd.getGlobalSettings();
    const refresh = gs && gs._buttonRefresh;
    if (refresh && refresh.action === module.exports.actionUUID
        && refresh.context && refresh.settings
        && _byContext.has(refresh.context)) {
      _byContext.get(refresh.context).settings = refresh.settings;
      renderNow(refresh.context, heosClient, vsd);
      return;
    }
    // No targeted refresh — re-render all contexts (e.g. on initial
    // global-settings push or speaker reconnect).
    for (const ctx of contexts) renderNow(ctx, heosClient, vsd);
  }
};
