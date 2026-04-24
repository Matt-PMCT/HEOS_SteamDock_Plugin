#!/usr/bin/env node
// Packages com.vsd.craft.heos.sdPlugin into a release-ready zip.
// - Strips the "Debug" field from manifest.json (required for distribution)
// - Creates dist/com.vsd.craft.heos.sdPlugin.zip

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..', 'com.vsd.craft.heos.sdPlugin');
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const ZIP_NAME = 'com.vsd.craft.heos.sdPlugin.zip';

// 1. Strip Debug field from manifest
const manifestPath = path.join(PLUGIN_DIR, 'manifest.json');
const original = fs.readFileSync(manifestPath, 'utf8');
const parsed = JSON.parse(original);
const hadDebug = parsed.Nodejs && Object.prototype.hasOwnProperty.call(parsed.Nodejs, 'Debug');
if (hadDebug) delete parsed.Nodejs.Debug;
const stripped = JSON.stringify(parsed, null, 2) + '\n';

if (stripped !== original) {
  fs.writeFileSync(manifestPath, stripped);
  // Verify it still parses before zipping — shipping a broken manifest is invisible in VSD Craft.
  JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (hadDebug) console.log('[package] Stripped "Debug" field from manifest.json');
}

// 2. Create dist directory
fs.mkdirSync(DIST_DIR, { recursive: true });

// 3. Zip the plugin folder
const zipPath = path.join(DIST_DIR, ZIP_NAME);
try { fs.unlinkSync(zipPath); } catch (e) { /* doesn't exist yet */ }

execFileSync('zip', ['-r', zipPath, 'com.vsd.craft.heos.sdPlugin'], {
  cwd: path.dirname(PLUGIN_DIR),
  stdio: 'inherit'
});

console.log(`[package] Created ${path.relative(process.cwd(), zipPath)}`);

// 4. Restore original manifest so dev workflow isn't affected
fs.writeFileSync(manifestPath, original);
console.log('[package] Restored manifest.json');
