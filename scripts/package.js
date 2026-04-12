#!/usr/bin/env node
// Packages com.vsd.craft.heos.sdPlugin into a release-ready zip.
// - Strips the "Debug" field from manifest.json (required for distribution)
// - Creates dist/com.vsd.craft.heos.sdPlugin.zip

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..', 'com.vsd.craft.heos.sdPlugin');
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const ZIP_NAME = 'com.vsd.craft.heos.sdPlugin.zip';

// 1. Strip Debug field from manifest (preserving original formatting)
const manifestPath = path.join(PLUGIN_DIR, 'manifest.json');
const original = fs.readFileSync(manifestPath, 'utf8');
const stripped = original.replace(/,\n\s*"Debug":[^\n]*/m, '');

if (stripped !== original) {
  fs.writeFileSync(manifestPath, stripped);
  console.log('[package] Stripped "Debug" field from manifest.json');
}

// 2. Create dist directory
fs.mkdirSync(DIST_DIR, { recursive: true });

// 3. Zip the plugin folder
const zipPath = path.join(DIST_DIR, ZIP_NAME);
try { fs.unlinkSync(zipPath); } catch (e) { /* doesn't exist yet */ }

execSync(
  `cd "${path.dirname(PLUGIN_DIR)}" && zip -r "${zipPath}" "com.vsd.craft.heos.sdPlugin"`,
  { stdio: 'inherit' }
);

console.log(`[package] Created ${path.relative(process.cwd(), zipPath)}`);

// 4. Restore original manifest so dev workflow isn't affected
fs.writeFileSync(manifestPath, original);
console.log('[package] Restored manifest.json');
