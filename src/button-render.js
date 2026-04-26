// Shared renderer for trigger-style buttons (play-url, preset, group-preset,
// input-select, profile-switch). Produces a solid-color SVG tile with an
// optional glyph and an optional bottom title band. Callers pass the user's
// per-action iconColor / iconGlyph / label; we sanitize and compose.

const DEFAULT_COLOR = '#4a90e2';

// Inline SVG glyphs rendered white-on-color in the top ~72×54 of the tile
// (the bottom 18px is reserved for the label band when present). Coordinates
// stay within y=16..52 to avoid colliding with the band.
const GLYPHS = {
  none: '',
  play:
    '<polygon points="28,20 28,52 54,36" fill="white" opacity="0.92"/>',
  pause:
    '<rect x="24" y="20" width="8" height="32" fill="white" opacity="0.92"/>' +
    '<rect x="40" y="20" width="8" height="32" fill="white" opacity="0.92"/>',
  next:
    '<polygon points="22,20 22,52 44,36" fill="white" opacity="0.92"/>' +
    '<rect x="46" y="20" width="6" height="32" fill="white" opacity="0.92"/>',
  prev:
    '<rect x="20" y="20" width="6" height="32" fill="white" opacity="0.92"/>' +
    '<polygon points="50,20 50,52 28,36" fill="white" opacity="0.92"/>',
  star:
    '<polygon points="36,18 40.2,28.1 51.2,29.3 43,36.7 45.2,47.5 36,41.8 26.8,47.5 29,36.7 20.8,29.3 31.8,28.1"' +
    ' fill="white" opacity="0.92"/>',
  heart:
    '<path d="M36 48 C36 48 20 38 20 28 C20 22 25 18 30 18 C33 18 36 21 36 24' +
    ' C36 21 39 18 42 18 C47 18 52 22 52 28 C52 38 36 48 36 48 Z"' +
    ' fill="white" opacity="0.92"/>',
  music:
    '<ellipse cx="28" cy="46" rx="7" ry="5" fill="white" opacity="0.92"/>' +
    '<rect x="34" y="20" width="3" height="28" fill="white" opacity="0.92"/>' +
    '<path d="M37 20 Q47 24 45 36" fill="none" stroke="white" stroke-width="3" opacity="0.92"/>',
  mic:
    '<rect x="30" y="16" width="12" height="22" rx="6" fill="white" opacity="0.92"/>' +
    '<path d="M24 32 v4 a12 12 0 0 0 24 0 v-4" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>' +
    '<line x1="36" y1="48" x2="36" y2="52" stroke="white" stroke-width="2.5" opacity="0.92"/>',
  radio:
    '<rect x="34" y="28" width="4" height="22" fill="white" opacity="0.92"/>' +
    '<polygon points="36,22 40,28 32,28" fill="white" opacity="0.92"/>' +
    '<path d="M26 24 A14 14 0 0 1 46 24" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>' +
    '<path d="M22 18 A20 20 0 0 1 50 18" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>',
  news:
    '<rect x="16" y="18" width="36" height="34" rx="2" fill="white" opacity="0.92"/>' +
    '<rect x="20" y="22" width="28" height="5" fill="#222"/>' +
    '<rect x="20" y="30" width="18" height="2.5" fill="#222"/>' +
    '<rect x="20" y="35" width="18" height="2.5" fill="#222"/>' +
    '<rect x="20" y="40" width="18" height="2.5" fill="#222"/>' +
    '<rect x="40" y="30" width="8" height="12" fill="#222"/>',
  speaker:
    '<path d="M22 28 h8 l10 -8 v32 l-10 -8 h-8 z" fill="white" opacity="0.92"/>' +
    '<path d="M46 26 a12 12 0 0 1 0 20" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>' +
    '<path d="M50 20 a18 18 0 0 1 0 32" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>',
  group:
    '<circle cx="24" cy="28" r="7" fill="white" opacity="0.92"/>' +
    '<circle cx="48" cy="28" r="7" fill="white" opacity="0.92"/>' +
    '<path d="M14 48 a10 10 0 0 1 20 0" fill="white" opacity="0.92"/>' +
    '<path d="M38 48 a10 10 0 0 1 20 0" fill="white" opacity="0.92"/>',
  input:
    '<rect x="16" y="22" width="40" height="24" rx="3" fill="none" stroke="white" stroke-width="2.5" opacity="0.92"/>' +
    '<polygon points="24,30 24,38 32,34" fill="white" opacity="0.92"/>' +
    '<line x1="36" y1="34" x2="48" y2="34" stroke="white" stroke-width="2.5" opacity="0.92"/>',
  home:
    '<path d="M20 36 L36 22 L52 36 V52 H42 V42 H30 V52 H20 Z" fill="white" opacity="0.92"/>'
};

function sanitizeColor(c) {
  const s = String(c || '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : DEFAULT_COLOR;
}

function sanitizeGlyph(key) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, key) ? key : 'play';
}

function escapeXml(s) {
  return String(s)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const DEFAULT_FONT_SIZE = 12;

function sanitizeFontSize(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return DEFAULT_FONT_SIZE;
  if (v < 8) return 8;
  if (v > 22) return 22;
  return v;
}

// Build a 72×72 SVG tile data URI suitable for vsd.setImage().
// - color: "#RRGGBB" or "#RGB"; falls back to default on anything else.
// - label: shown in a bottom black band; pass '' to drop the band entirely.
// - glyphKey: one of GLYPHS; falls back to 'play'.
// - fontSize: label font size in px; band height scales 1.5× to keep the
//   text vertically centered in the bar.
function buildButtonSvg(color, label, glyphKey, fontSize) {
  const bg = sanitizeColor(color);
  const title = escapeXml((label == null ? '' : String(label)).trim());
  const glyph = GLYPHS[sanitizeGlyph(glyphKey)];
  const fs = sanitizeFontSize(fontSize);
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">' +
    `<rect width="72" height="72" fill="${bg}"/>` +
    glyph;
  if (title) {
    const bandH = Math.round(fs * 1.5);
    const bandY = 72 - bandH;
    const textY = bandY + Math.round(bandH * 0.72);
    svg += `<rect y="${bandY}" width="72" height="${bandH}" fill="rgba(0,0,0,0.55)"/>` +
      `<text x="36" y="${textY}" font-size="${fs}" fill="white" text-anchor="middle" font-family="sans-serif">${title}</text>`;
  }
  svg += '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

module.exports = {
  DEFAULT_COLOR,
  DEFAULT_FONT_SIZE,
  GLYPHS,
  sanitizeColor,
  sanitizeGlyph,
  sanitizeFontSize,
  buildButtonSvg
};
