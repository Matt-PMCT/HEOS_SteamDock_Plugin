const http = require('http');
const https = require('https');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap — album art coming from the internet
const REQUEST_TIMEOUT_MS = 3000;

let _cachedUrl = null;
let _cachedTitle = null;
let _cachedSvg = null;

function escapeXml(str) {
  return str
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control chars that break SVG renderers
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

function buildAlbumArtSvg(base64Data, contentType, title) {
  const mimeType = contentType.split(';')[0].trim();
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">' +
    `<image href="data:${mimeType};base64,${base64Data}" width="72" height="72"/>`;

  if (title) {
    svg += '<rect y="54" width="72" height="18" fill="rgba(0,0,0,0.7)"/>' +
      `<text x="36" y="66" font-size="8" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(title)}</text>`;
  }

  svg += '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/**
 * Fetch album art and return an SVG data URI with the image embedded as base64.
 * Returns null on any error. Caches the last successful result by URL.
 */
function fetchAlbumArt(imageUrl, title) {
  if (!imageUrl) return Promise.resolve(null);

  if (imageUrl === _cachedUrl && title === _cachedTitle && _cachedSvg) {
    return Promise.resolve(_cachedSvg);
  }

  return fetchImage(imageUrl)
    .then(({ buffer, contentType }) => {
      const base64Data = buffer.toString('base64');
      const svg = buildAlbumArtSvg(base64Data, contentType, title);
      _cachedUrl = imageUrl;
      _cachedTitle = title;
      _cachedSvg = svg;
      return svg;
    })
    .catch((err) => {
      console.error('[image-utils] Failed to fetch album art:', err.message);
      return null;
    });
}

module.exports = { fetchAlbumArt };
