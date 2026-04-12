# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VSDinside StreamDock plugin that controls Denon HEOS speakers from physical buttons and rotary knobs (MagTran M3 and other StreamDock devices). Node.js 20.8.1 backend communicating with HEOS speakers over TCP port 1255.

**Status:** Phases 1-3 complete. Infrastructure (WebSocket, TCP, command queue), core playback actions (play/pause, next/prev, mute), and volume knob control are implemented. Next: Phase 4 (preset buttons). See `docs/plans/00-SUMMARY.md` for the full roadmap.

## Build Commands

```bash
npm install                # Install ws and @vercel/ncc
npm run build              # Bundle src/index.js -> com.vsd.craft.heos.sdPlugin/plugin/index.js
npm run dev                # Watch mode (rebuilds on file changes)
```

Build uses `@vercel/ncc` to bundle all source + the `ws` dependency into a single `plugin/index.js`. The only runtime dependency is `ws` (Node 20.8.1 lacks native WebSocket).

```bash
npm run package            # Build + strip Debug from manifest + zip for release
```

Release workflow: push a `v*` tag to create a GitHub Release with the packaged zip automatically.

## Architecture

```
MagTran M3 --> VSD Craft (WebSocket) --> Plugin (Node.js) --> HEOS Speaker (TCP:1255)
  keys/knobs      events/display         commands/events       CLI protocol
```

- **`src/index.js`** -- WebSocket registration with VSD Craft, event dispatch to action handlers, global settings management
- **`src/heos-client.js`** -- TCP connection to HEOS, command serialization queue, response parser, event routing, heartbeat, reconnection
- **`src/actions/`** -- One module per action (play-pause, next-prev, mute, volume, preset). Each exports handler functions (`onWillAppear`, `onKeyDown`, `onDialRotate`, etc.)
- **`com.vsd.craft.heos.sdPlugin/`** -- Deployed plugin folder containing `manifest.json`, bundled `plugin/index.js`, property inspector UI, and images
- **`property-inspector/`** -- HTML/JS/CSS settings UI running in browser context (uses browser-native WebSocket, not `ws`)

## Critical Protocol Gotchas

These are non-obvious constraints that cause hard-to-debug failures:

**HEOS (TCP):**
- Commands MUST be serialized one at a time through a queue. Concurrent commands cause buffer overflow and dropped responses.
- Player IDs are signed integers (can be negative). Always store as Numbers, not Strings -- `parseInt(pid, 10)`. String/Number comparison silently fails and ignores all events.
- `heos.message` field is URL-encoded key-value pairs, NOT JSON. Parse with split on `&`/`=` then `decodeURIComponent`.
- `play_preset` is `heos://browse/play_preset`, not `player/play_preset`.
- "Command under process" interim responses: check BOTH `result === ''` AND `message === 'command under process'`. Do NOT resolve the pending command -- wait for the real response.
- URL encoding in commands: only encode `%` -> `%25`, `&` -> `%26`, `=` -> `%3D`. Do NOT use `encodeURIComponent()`.
- Response parser must skip bad lines individually -- never flush the entire buffer on a parse error.
- Heartbeat (`heos://system/heart_beat`) every 30s to prevent connection timeout.
- Error 13/16: retry up to 3 times with 200-500ms backoff.

**VSDinside SDK (WebSocket):**
- Manifest uses `"Controllers": ["Knob"]` but runtime sends `payload.controller === "Encoder"`. Never check for "Knob" at runtime.
- `dialUp` fires immediately after `dialDown` (no real release detection). Trigger actions on `dialDown` only.
- No `setFeedback`/`setFeedbackLayout` -- use `setImage()` with SVG or base64 PNG.
- All action UUIDs must be lowercase.
- Remove `"Debug"` field from manifest before distribution. `scripts/package.js` handles this automatically.
- VSD Craft silently ignores plugins with invalid `manifest.json` (no error in logs). Always verify packaged JSON is valid.
- `"Category"` field in manifest controls the action list heading in VSD Craft. Use the plugin name, not a generic category.
- Grouped speakers share playback -- controlling a group leader affects all members. Player selection UI must show group membership.

## Design Decisions

- **No SDK template utilities.** We write WebSocket registration, event dispatch, and action handling from scratch rather than using the V2 SDK template's `Plugins`/`Actions`/`EventEmitter` classes. This keeps the dependency footprint minimal and the code straightforward.
- **Single dependency (`ws`).** No `fs-extra`, `log4js`, or template bloat.
- **Global settings** for speaker IP and player ID (shared across all action instances). Per-action settings only for action-specific config (e.g., preset number).
- **All 6 actions defined in manifest from Phase 1** to avoid manifest churn across phases.
- **Volume debounce pattern:** Rapid `dialRotate` ticks are accumulated and flushed via a 50ms trailing-edge debounce timer, not sent individually. `enqueueVolume()` replaces stale `set_volume` commands in the queue so only the latest target is sent. Replaced commands are rejected (not resolved) so callers can distinguish them from real errors.
