# HEOS Control Plugin for VSDinside StreamDock

## Project Overview

A VSDinside StreamDock plugin that enables physical button and knob control of Denon HEOS speakers from a MagTran M3 (or any StreamDock device). Press a key to play/pause, twist a knob to change volume, tap a button to switch presets.

## Target Hardware

- **Control Device:** VSDinside MagTran M3 (also compatible with all VSD Craft-supported StreamDock devices including M18, N3, N4, N4 Pro, N1, 293V3, 293SV3, H1, K1 Pro, XL)
- **Audio Target:** Any Denon HEOS-compatible speaker, soundbar, or AV receiver on the local network

## What This Plugin Does

| M3 Input | HEOS Action |
|---|---|
| Key press | Play, Pause, Stop, Next, Previous, Mute toggle |
| Knob rotation | Volume up/down (smooth, per-tick adjustment) |
| Knob press | Mute toggle |
| Key press (preset keys) | Play HEOS Favorite preset 1 through 6 |
| Key display | Show now-playing info, volume level, play state |

## Technical Stack

- **Language:** Node.js (JavaScript), using the built-in Node.js 20.8.1 runtime bundled with VSD Craft software (version 3.10.188.226+)
- **StreamDock SDK:** VSDinside Plugin SDK (WebSocket-based, JSON manifest)
- **HEOS Protocol:** Denon HEOS CLI over TCP socket on port 1255 (telnet-style, commands as ASCII strings, responses as JSON)
- **Build tool:** `@vercel/ncc` to bundle Node.js source + `ws` dependency into a single file for distribution
- **Runtime dependency:** `ws` (WebSocket client) — Node.js 20.8.1 does not include native WebSocket (added in Node 21). The `net` module handles all HEOS TCP communication with no additional dependencies.

## Architecture Summary

```
MagTran M3                 VSD Craft Software              Plugin (Node.js)              HEOS Speaker
+-----------+              +------------------+            +------------------+           +------------+
| Keys      | --USB------> | WebSocket events | ---------> | Receives keyDown | --TCP---> | Port 1255  |
| Knobs     |              | to plugin        |            | dialRotate, etc  |           | CLI cmds   |
| Display   | <--USB------ | setTitle/setImage| <--------- | Updates display  | <--TCP--- | JSON resp  |
+-----------+              +------------------+            +------------------+           +------------+
```

## Key Design Decisions

1. **Node.js over JavaScript/HTML backend.** The M3's VSD Craft software bundles Node.js 20, which gives us access to the `net` module for raw TCP sockets. A browser-based JS plugin cannot open TCP connections directly, so the Node.js path is mandatory for HEOS communication.

2. **Persistent TCP connection.** HEOS speakers run their CLI module in a dormant mode and need a few seconds to spin up on first connection. We maintain a single persistent TCP connection to avoid repeated startup delays.

3. **Global settings for connection config.** The HEOS speaker IP address and selected player ID are stored using `setGlobalSettings`, so all action instances share the same connection without requiring per-button configuration.

4. **Separate actions for each function.** Each button function (play/pause, volume, preset, etc.) is a distinct action in the manifest. This lets users drag exactly the controls they want onto their M3 layout.

## Project File Structure

```
heos-plugin/                           # Development root (NOT deployed)
  package.json                         # Declares ws dependency + ncc build script
  src/
    index.js                           # Main plugin entry point (Node.js)
    heos-client.js                     # HEOS TCP connection and command wrapper
    actions/
      play-pause.js                    # Play/Pause toggle action handler
      volume.js                        # Volume knob action handler  
      mute.js                          # Mute toggle action handler
      next-prev.js                     # Next/Previous track (handles both UUIDs)
      preset.js                        # Play HEOS favorite preset action handler

com.vsd.craft.heos.sdPlugin/          # Deployed plugin folder
  manifest.json                        # Plugin metadata, actions, Node.js config
  plugin/
    index.js                           # Bundled output from @vercel/ncc (single file)
  property-inspector/
    index.html                         # Settings UI (speaker IP, player selection)
    js/
      pi.js                            # Property Inspector logic
    css/
      pi.css                           # Property Inspector styling
  images/
    plugin-icon.png                    # 128x128 plugin icon
    category-icon.png                  # 48x48 category icon
    actions/
      play-pause.png                   # Action-level icon (40x40, shown in action list)
      play.png                         # State icon: playing state
      pause.png                        # State icon: paused state
      volume.png                       # Volume knob icon
      mute.png                         # Mute action-level icon
      unmuted.png                      # State icon: unmuted
      muted.png                        # State icon: muted
      next.png                         # Next track icon
      prev.png                         # Previous track icon
      preset.png                       # Preset action icon
```

The `src/` directory is compiled into a single `plugin/index.js` using `@vercel/ncc`. This bundles the `ws` dependency so no `node_modules` folder is needed in the deployed plugin. The official SDK V2 template uses this same pattern.

## Prerequisites

- VSD Craft software version 3.10.188.226 or higher on Windows, **3.10.191.0421** or higher on macOS (for built-in Node.js 20)
- A Denon HEOS speaker, soundbar, or AVR on the same local network as your computer
- The HEOS device's IP address (find it in the HEOS app under Settings > My Devices > [your device] > Advanced)

## Design Note: V2 SDK Template Utilities

The official V2 SDK template (`VSDinside-Plugin-SDK`) ships with utility classes (`Plugins`, `Actions`, `EventEmitter` in `utils/plugin.js`) and extra dependencies (`fs-extra`, `log4js`). This plugin **does not use** those utilities. We write the WebSocket registration, event dispatch, and action handling from scratch because:

1. The template utilities add abstraction over a simple WebSocket protocol — the overhead isn't justified for six actions.
2. Rolling our own keeps the dependency footprint minimal (`ws` only) and makes the code easier to follow as a reference project.
3. The template's `autofile.js` deployment script is Windows-specific and would need rewriting for cross-platform support.

If you're porting this to a larger plugin, the template utilities are worth evaluating.

## Reference Links

- VSDinside Plugin SDK: https://github.com/VSDinside/VSDinside-Plugin-SDK
- SDK Documentation: https://sdk.key123.vip/en/
- HEOS CLI Protocol Spec (PDF, v1.17 — latest publicly available): https://rn.dmglobal.com/usmodel/HEOS_CLI_ProtocolSpecification-Version-1.17.pdf
- Node.js heos-api library (reference, minimal): https://github.com/juliuscc/heos-api — useful for TCP buffering patterns, but lacks command serialization, reconnection, and "command under process" handling
- Denon AVR StreamDeck plugin (architectural reference): https://github.com/mthiel/stream-deck-denon-receiver — **Note:** this plugin controls Denon AVRs via the telnet protocol on port 23, not the HEOS CLI on port 1255. Its code structure, action patterns, and reconnection logic are useful references, but its volume/dial handling does not transfer directly because the AVR telnet protocol is far more tolerant of rapid concurrent commands than the HEOS CLI.
- VSDinside Discord (developer support): https://discord.vsdinside.com/
