const http = require('http');
const https = require('https');
const logger = require('./logger');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap — album art coming from the internet
const REQUEST_TIMEOUT_MS = 3000;

let _cachedUrl = null;
let _cachedUri = null;

function fetchImage(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('Too many redirects')); return; }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      reject(new Error('Invalid URL'));
      return;
    }

    // Scheme whitelist — album-art URLs come from the speaker's now-playing payload,
    // which ultimately originates from arbitrary streaming services. Refuse anything
    // that isn't plain HTTP(S) to avoid file://, data://, SSRF via exotic protocols, etc.
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject(new Error('Unsupported scheme: ' + parsedUrl.protocol));
      return;
    }

    const mod = parsedUrl.protocol === 'https:' ? https : http;

    let req;
    try {
      req = mod.get(parsedUrl.href, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let nextUrl;
          try {
            // Resolve relative Location headers against the current URL (RFC 7231).
            nextUrl = new URL(res.headers.location, parsedUrl).href;
          } catch (e) {
            reject(new Error('Invalid redirect target'));
            return;
          }
          fetchImage(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }

        const contentType = res.headers['content-type'] || 'image/jpeg';
        const chunks = [];
        let totalBytes = 0;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_IMAGE_BYTES) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
        res.on('error', reject);
      });
    } catch (e) {
      reject(e);
      return;
    }

    req.on('error', reject);

    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timeout));
  });
}

/**
 * Fetch album art and return a raw base64 data URI suitable for setImage().
 * The previous implementation wrapped the image in SVG to overlay a title,
 * which ballooned the payload (URL-encoded SVG around base64 PNG ≈ 3× the raw
 * size) and VSD Craft's setImage renderer silently discarded the oversized
 * frames. Title overlay is handled separately via vsd.setTitle — the manifest
 * declares TitleAlignment per state so VSD Craft overlays the text natively.
 * Returns null on any error. Caches the last successful URI by URL.
 */
function fetchAlbumArt(imageUrl) {
  if (!imageUrl) return Promise.resolve(null);

  if (imageUrl === _cachedUrl && _cachedUri) {
    return Promise.resolve(_cachedUri);
  }

  return fetchImage(imageUrl)
    .then(({ buffer, contentType }) => {
      const base64Data = buffer.toString('base64');
      const mimeType = (contentType || 'image/jpeg').split(';')[0].trim();
      const result = `data:${mimeType};base64,${base64Data}`;
      _cachedUrl = imageUrl;
      _cachedUri = result;
      logger.log('[image-utils] Album art loaded:', imageUrl.substring(0, 80),
        'bytes=' + buffer.length, 'uri_len=' + result.length, 'mime=' + mimeType);
      return result;
    })
    .catch((err) => {
      logger.error('[image-utils] Failed to fetch album art:', err.message, 'url=' + imageUrl.substring(0, 80));
      return null;
    });
}

module.exports = { fetchAlbumArt };
