const fs = require('fs');

// Debug logger. Off by default; user toggles `debugLogging` in the PI to turn on.
// When enabled, `log` / `error` append to a text file at the configured path in
// addition to printing to stdout/stderr (which are only visible when attached to
// the Node inspector). When disabled, behavior is identical to plain console.*.
//
// File is truncated once it exceeds 1 MB (rotated to <path>.old) so users don't
// accumulate an unbounded log.

let enabled = false;
let logPath = null;

const MAX_LOG_BYTES = 1024 * 1024;

function setEnabled(isEnabled, path) {
  const wasEnabled = enabled;
  enabled = !!isEnabled;
  logPath = path || null;

  if (enabled && logPath) {
    // Rotate if the existing file is already huge so we start a fresh session.
    try {
      const stats = fs.statSync(logPath);
      if (stats.size > MAX_LOG_BYTES) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch (e) {
      // File doesn't exist yet — fine.
    }
    if (!wasEnabled) {
      try {
        fs.appendFileSync(logPath,
          `\n=== Debug logging enabled at ${new Date().toISOString()} ===\n`);
      } catch (e) { /* swallow — never recursively error */ }
    }
  }
}

function isEnabled() {
  return enabled;
}

function log(...args) {
  console.log(...args);
  write('LOG', args);
}

function error(...args) {
  console.error(...args);
  write('ERROR', args);
}

function write(level, args) {
  if (!enabled || !logPath) return;
  try {
    const ts = new Date().toISOString();
    const msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
    fs.appendFileSync(logPath, `${ts} ${level} ${msg}\n`);
  } catch (e) {
    // Don't recurse: if disk is full / permission denied, just skip.
  }
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch (e) { return String(obj); }
}

module.exports = { setEnabled, isEnabled, log, error };
