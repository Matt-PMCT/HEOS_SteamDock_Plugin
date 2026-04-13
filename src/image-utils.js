const http = require('http');
const https = require('https');

let _cachedUrl = null;
let _cachedTitle = null;
let _cachedSvg = null;

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fetchImage(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('Too many redirects')); return; }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        fetchImage(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on('error', reject);
    });

    req.on('error', reject);

    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 3000);
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
