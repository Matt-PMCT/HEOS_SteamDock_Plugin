# HEOS Control for StreamDock

A [VSDinside StreamDock](https://www.vsdinside.com/) plugin that controls Denon HEOS speakers from physical buttons and rotary knobs. Built for the MagTran M3 and compatible StreamDock devices.

## Features

**Playback Controls (buttons)**
- **Play / Pause** — toggle playback, button state syncs with speaker
- **Next / Previous Track** — skip forward or back
- **Mute Toggle** — button state reflects current mute status

**Volume Control (rotary knob)**
- Rotate to adjust volume with adaptive speed scaling (slow = fine, fast = coarse)
- Press knob to toggle mute
- Debounced command batching prevents HEOS queue overflow during rapid rotation
- Display shows current volume level ("Vol: 42") or "MUTE"

**General**
- Automatic connection and reconnection to HEOS speaker over TCP
- Real-time state sync — changes from the HEOS app or other controllers update the StreamDock immediately
- Heartbeat keep-alive prevents connection timeouts
- Configurable speaker IP and player ID via global settings

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
2. Open the Property Inspector and enter your HEOS speaker's IP address
3. Select your player from the dropdown (or enter the player ID manually)

To find your speaker's IP: open the HEOS app, go to **Settings > My Devices**, select your speaker, then **Advanced** to see the IP address.

## Development

```bash
npm run dev    # Watch mode — rebuilds on file changes
npm run build  # One-time production build
```

The build uses [`@vercel/ncc`](https://github.com/vercel/ncc) to bundle `src/` and the `ws` dependency into a single `com.vsd.craft.heos.sdPlugin/plugin/index.js`.

## Architecture

```
StreamDock Device --> VSD Craft (WebSocket) --> Plugin (Node.js) --> HEOS Speaker (TCP:1255)
   keys/knobs          events/display           commands/events        HEOS CLI protocol
```

- `src/index.js` — WebSocket connection to VSD Craft, event dispatch, global settings
- `src/heos-client.js` — TCP connection to HEOS, serialized command queue, response parser, event routing
- `src/actions/` — one module per action (play-pause, next-prev, mute, volume)

## Roadmap

See [`docs/plans/00-SUMMARY.md`](docs/plans/00-SUMMARY.md) for the full plan.

- [x] Phase 1 — Skeleton & Infrastructure
- [x] Phase 2 — Core Playback Actions
- [x] Phase 3 — Volume Knob
- [ ] Phase 4 — Preset Buttons (HEOS Favorites)
- [ ] Phase 5 — Property Inspector (settings UI)
- [ ] Phase 6 — Resilience & Polish

## License

MIT
