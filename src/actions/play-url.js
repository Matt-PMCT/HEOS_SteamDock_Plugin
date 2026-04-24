const logger = require('../logger');
const { heosEncode } = require('../heos-client');
const { fetchText, resolveFinalUrl } = require('../http-utils');
const { buildButtonSvg } = require('../button-render');
const { consumeButtonRefresh } = require('../button-refresh');

const CACHE_TTL_MS = 60 * 1000;
let _cache = null; // { sourceUrl, audioUrl, channelTitle, itemTitle, at }

function looksLikeXml(contentType, body) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('xml') || ct.includes('rss')) return true;
  const head = body.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed');
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i.exec(s);
  return m ? m[1] : s;
}

function extractTitle(block) {
  const m = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeXmlEntities(stripCdata(m[1])).trim();
}

function parseFeed(xml) {
  const item = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/i);
  if (!item) return null;
  const enc = item[0].match(/<enclosure[^>]*\burl\s*=\s*["']([^"']+)["']/i);
  if (!enc) return null;
  const preItem = xml.slice(0, xml.indexOf(item[0]));
  return {
    audioUrl: enc[1],
    itemTitle: extractTitle(item[0]),
    channelTitle: extractTitle(preItem)
  };
}

async function resolveFromSource(sourceUrl) {
  if (_cache && _cache.sourceUrl === sourceUrl && (Date.now() - _cache.at) < CACHE_TTL_MS) {
    logger.log('[play-url] cache hit', 'url=' + sourceUrl);
    return _cache;
  }

  const { body, contentType, finalUrl } = await fetchText(sourceUrl);

  let result;
  if (looksLikeXml(contentType, body)) {
    const parsed = parseFeed(body);
    if (!parsed) throw new Error('No <enclosure> found in feed');
    result = {
      audioUrl: await resolveFinalUrl(parsed.audioUrl),
      itemTitle: parsed.itemTitle,
      channelTitle: parsed.channelTitle
    };
  } else {
    result = { audioUrl: finalUrl, itemTitle: '', channelTitle: '' };
  }

  _cache = { sourceUrl, ...result, at: Date.now() };
  return _cache;
}

function renderButton(context, settings, vsd) {
  // Empty buttonTitle is a deliberate "no label" choice — don't substitute a
  // default. Unset (undefined) falls back to 'On Demand' for first-drop.
  const label = (settings.buttonTitle != null ? String(settings.buttonTitle) : 'On Demand');
  vsd.setImage(context, buildButtonSvg(settings.iconColor, label, settings.iconGlyph));
  vsd.setTitle(context, '');
}

module.exports = {
  actionUUID: 'com.vsd.craft.heos.playurl',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const settings = message.payload.settings || {};
    const sourceUrl = (settings.sourceUrl || '').trim();
    if (!sourceUrl) { vsd.showAlert(message.context); return; }

    resolveFromSource(sourceUrl)
      .then((resolved) => {
        const cmd = `heos://browse/play_stream?pid=${pid}&url=${heosEncode(resolved.audioUrl)}`;
        logger.log('[play-url] play_stream', 'pid=' + pid, 'audio_len=' + resolved.audioUrl.length,
          'channel=' + (resolved.channelTitle || '(none)'),
          'item=' + (resolved.itemTitle || '(none)'));
        const display = (settings.buttonTitle || '').trim()
          || resolved.channelTitle
          || resolved.itemTitle
          || 'On Demand';
        heosClient.streamMetadataOverride = { song: display, artist: '', setAt: Date.now() };
        return heosClient.enqueue(cmd);
      })
      .then(() => vsd.showOk(message.context))
      .catch((err) => {
        logger.error('[play-url] failed:', err.message, 'source=' + sourceUrl);
        vsd.showAlert(message.context);
      });
  },

  onWillAppear(message, { vsd }) {
    renderButton(message.context, message.payload.settings || {}, vsd);
  },

  onDidReceiveSettings(message, { vsd }) {
    renderButton(message.context, message.payload.settings || {}, vsd);
  },

  onGlobalSettingsChange({ contexts, vsd }) {
    consumeButtonRefresh(module.exports.actionUUID, contexts, vsd, renderButton);
  }
};
