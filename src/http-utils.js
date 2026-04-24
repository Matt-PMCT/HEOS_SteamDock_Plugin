const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

function pickClient(parsedUrl) {
  return parsedUrl.protocol === 'https:' ? https : http;
}

function assertSafeScheme(parsedUrl) {
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Unsupported scheme: ' + parsedUrl.protocol);
  }
}

function fetchText(url, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redirectsLeft = opts.redirectsLeft != null ? opts.redirectsLeft : DEFAULT_MAX_REDIRECTS;

  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('Too many redirects')); return; }

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    try { assertSafeScheme(parsedUrl); } catch (e) { reject(e); return; }

    let req;
    try {
      req = pickClient(parsedUrl).get(parsedUrl.href, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, parsedUrl).href; }
          catch (e) { reject(new Error('Invalid redirect target')); return; }
          fetchText(nextUrl, { maxBytes, timeoutMs, redirectsLeft: redirectsLeft - 1 })
            .then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }

        const contentType = res.headers['content-type'] || '';
        const chunks = [];
        let totalBytes = 0;
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ body, contentType, finalUrl: parsedUrl.href });
        });
        res.on('error', reject);
      });
    } catch (e) { reject(e); return; }

    req.on('error', reject);
    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, timeoutMs);
    req.on('close', () => clearTimeout(timeout));
  });
}

function resolveFinalUrl(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const redirectsLeft = opts.redirectsLeft != null ? opts.redirectsLeft : DEFAULT_MAX_REDIRECTS;

  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) { reject(new Error('Too many redirects')); return; }

    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { reject(new Error('Invalid URL')); return; }
    try { assertSafeScheme(parsedUrl); } catch (e) { reject(e); return; }

    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    let req;
    try {
      req = pickClient(parsedUrl).get(parsedUrl.href, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          let nextUrl;
          try { nextUrl = new URL(res.headers.location, parsedUrl).href; }
          catch (e) { settle(reject, new Error('Invalid redirect target')); res.resume(); req.destroy(); return; }
          res.resume();
          req.destroy();
          settled = true; // hand off to the recursive promise
          resolveFinalUrl(nextUrl, { timeoutMs, redirectsLeft: redirectsLeft - 1 })
            .then(resolve, reject);
          return;
        }
        // Any other response: we have the final URL; abort the body.
        res.resume();
        req.destroy();
        if (res.statusCode >= 400) {
          settle(reject, new Error('HTTP ' + res.statusCode));
          return;
        }
        settle(resolve, parsedUrl.href);
      });
    } catch (e) { settle(reject, e); return; }

    req.on('error', (err) => settle(reject, err));
    const timeout = setTimeout(() => { req.destroy(); settle(reject, new Error('Timeout')); }, timeoutMs);
    req.on('close', () => clearTimeout(timeout));
  });
}

module.exports = { fetchText, resolveFinalUrl };
