# HEOS Control for StreamDock

A [VSDinside StreamDock](https://www.vsdinside.com/) plugin that controls Denon HEOS speakers from physical buttons and rotary knobs. Built for the MagTran M3 and compatible StreamDock devices.

## Features

**Playback Controls (buttons)**
- **Play / Pause** — toggle playback with album art and now-playing title on the button (album art is optional per-button)
- **Next / Previous Track** — skip forward or back
- **Mute Toggle** — button state reflects current mute status
- **Play Preset** — one-touch launch of HEOS Favorites (configurable preset number per button)
- **Repeat Mode** — cycle through off, repeat all, repeat one (3-state button)
- **Shuffle** — toggle shuffle on/off (2-state button)
- **Input Source** — switch AVR input (HDMI, optical, AUX, etc.) with configurable source per button
- **Group Preset** — group or ungroup a saved combination of speakers with one press
- **Switch Profile** — switch between saved speaker profiles (IP + player) with one press

**Volume Control (rotary knobs)**
- **Player Volume** — rotate to adjust volume with adaptive speed scaling (slow = fine, fast = coarse), press to toggle mute
- **Group Volume** — same controls for the speaker group, auto-detects or uses a configured group

**Speaker Discovery**
- **SSDP Auto-Discovery** — "Find Speakers" button scans the LAN for HEOS speakers, click a result to auto-fill the IP

**Speaker Profiles**
- Save multiple speaker configurations (IP + player) as named profiles
- Switch between profiles via button press or Property Inspector dropdown

**Settings UI (Property Inspector)**
- Enter speaker IP or auto-discover via SSDP
- Player dropdown shows name, model, and group membership
- Per-button settings for presets, input sources, profiles, groups, and album art toggle
- HEOS account status display

**General**
- Automatic connection and reconnection to HEOS speaker over TCP
- Real-time state sync — changes from the HEOS app or other controllers update the StreamDock immediately
- Heartbeat keep-alive prevents connection timeouts
- Debounced command batching prevents HEOS queue overflow during rapid volume rotation

## Prerequisites

- A [StreamDock device](https://www.vsdinside.com/collections/streamdock) (MagTran M3, N4 Pro, M18, etc.)
- [VSD Craft](https://www.vsdinside.com/pages/download) software installed
- A Denon HEOS-enabled speaker on the same network

## Installation

### Download (easiest)

1. Download `com.vsd.craft.heos.sdPlugin.zip` from the [latest release](https://github.com/Matt-PMCT/HEOS_SteamDock_Plugin/releases/latest)
2. Extract the zip
3. Copy the `com.vsd.craft.heos.sdPlugin` folder to your plugins directory:
   - **Windows:** `%AppData%\HotSpot\StreamDock\plugins\`
   - **macOS:** `~/Library/Application Support/HotSpot/StreamDock/plugins/`
4. Restart VSD Craft

### From source

```bash
git clone https://github.com/Matt-PMCT/HEOS_SteamDock_Plugin.git
cd HEOS_SteamDock_Plugin
npm install
npm run build
```

Then copy the built plugin to the VSD Craft plugins folder:

**Windows:**
```
%AppData%\HotSpot\StreamDock\plugins\com.vsd.craft.heos.sdPlugin
```

**macOS:**
```
~/Library/Application Support/HotSpot/StreamDock/plugins/com.vsd.craft.heos.sdPlugin
```

Copy the entire `com.vsd.craft.heos.sdPlugin` folder into the plugins directory, then restart VSD Craft.

### Setup

1. Open VSD Craft and drag a HEOS action onto a button or knob
2. Open the Property Inspector and enter your HEOS speaker's IP address (or click **Find Speakers** to auto-discover)
3. Click **Connect & Discover** and select your player from the dropdown

To find your speaker's IP manually: open the HEOS app, go to **Settings > My Devices**, select your speaker, then **Advanced** to see the IP address.

## Development

```bash
npm run dev    # Watch mode — rebuilds on file changes
npm run build  # One-time production build
npm run package  # Build + strip Debug from manifest + zip for release
```

The build uses [`@vercel/ncc`](https://github.com/vercel/ncc) to bundle `src/` and the `ws` dependency into a single `com.vsd.craft.heos.sdPlugin/plugin/index.js`.

## Architecture

```
StreamDock Device --> VSD Craft (WebSocket) --> Plugin (Node.js) --> HEOS Speaker (TCP:1255)
   keys/knobs          events/display           commands/events        HEOS CLI protocol
```

- `src/index.js` — WebSocket connection to VSD Craft, event dispatch, global settings, SSDP discovery trigger
- `src/heos-client.js` — TCP connection to HEOS, serialized command queue, response parser, event routing
- `src/image-utils.js` — HTTP image fetch with redirect handling, base64 encoding, SVG album art generation
- `src/ssdp-discovery.js` — UDP multicast SSDP auto-discovery of HEOS speakers on LAN
- `src/actions/` — one module per action (play-pause, next-prev, mute, volume, preset, group-preset, play-mode, group-volume, input-select, profile-switch)

## Roadmap

See [`docs/plans/00-SUMMARY.md`](docs/plans/00-SUMMARY.md) for the full plan.

- [x] Phase 1 — Skeleton & Infrastructure
- [x] Phase 2 — Core Playback Actions
- [x] Phase 3 — Volume Knob
- [x] Phase 4 — Preset Buttons (HEOS Favorites)
- [x] Phase 5 — Property Inspector (settings UI)
- [x] Phase 6 — Resilience & Polish
- [x] Phase 7 — Future Enhancements (album art, SSDP, group volume, input select, repeat/shuffle, profiles, now-playing)

## License

MIT
