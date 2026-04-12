# Development Plan

## Phase 1: Skeleton, Connection, and Command Infrastructure (Day 1)

Get a bare-minimum plugin that registers with VSD Craft, connects to a HEOS speaker, sends commands through a serialized queue, and responds to a single button press. The command queue and TCP parser are built here — not later — because every subsequent phase depends on reliable command-response round-trips, and HEOS devices fail unpredictably under concurrent commands.

### Tasks

- [ ] Create `package.json` with `ws` dependency and `@vercel/ncc` dev dependency (see SDK Reference doc for template)
- [ ] Run `npm install` to set up the build toolchain
- [ ] Create the `.sdPlugin` folder structure and `manifest.json` with a single test action
- [ ] Write `src/index.js` with WebSocket registration boilerplate (parse CLI args, connect to VSD Craft, register)
- [ ] Write `src/heos-client.js` with:
  - TCP socket connection to a HEOS speaker IP on port 1255
  - **TCP response parser** — buffer incoming data, split on `\r\n`, keep incomplete fragments, JSON-parse complete lines, skip (don't flush) on parse errors (see Protocol Reference "TCP Response Parser" section)
  - **Event vs. response routing** — check if `heos.command` starts with `event/` to distinguish unsolicited events from command responses; handle `"command under process"` interim responses by waiting for the real response (see Protocol Reference "Event vs. Response Routing" section)
  - **Command serialization queue** — FIFO queue that sends one command at a time, waits for its response, then sends the next. Match responses to pending commands by comparing `heos.command` against the sent command's group/name. Handle error 13 (processing previous command) and error 16 (too many commands) with retry after 200-500ms. Set a 5-second per-command timeout. (see Protocol Reference "Command Serialization" section)
- [ ] Run `npm run build` to bundle source into `com.vsd.craft.heos.sdPlugin/plugin/index.js` via `@vercel/ncc`
- [ ] Verify the bundled plugin launches correctly in VSD Craft (check debug log if it fails — double-click version number in VSD Craft settings)
- [ ] On `keyDown` event, send `heos://system/heart_beat` **through the command queue** and log the JSON response to verify round-trip communication
- [ ] Handle connection errors gracefully (speaker offline, wrong IP, timeout)
- [ ] Test by installing the plugin folder into the VSD Craft plugins directory and pressing a button

### Done when
A button press on the M3 sends a heartbeat through the command queue to the HEOS speaker and you see a success response logged. The command queue, TCP parser, and event/response router are functional and tested with at least heartbeat commands.

---

## Phase 2: Core Playback Actions (Day 1-2)

Wire up play/pause, next, previous, and mute.

### Tasks

- [ ] Implement the initialization sequence in `heos-client.js`: unregister events, check_account, get_players, register events
- [ ] Add player discovery: parse the `get_players` response and store available players
- [ ] Handle HEOS account sign-in: use `check_account` to detect sign-in state; if not signed in, store credentials via the Property Inspector (needed for streaming-service-based presets/favorites)
- [ ] Create `actions/play-pause.js`: on `keyDown`, check current state and toggle between play/pause
- [ ] Create `actions/next-prev.js`: handle both `com.vsd.craft.heos.next` and `com.vsd.craft.heos.previous` UUIDs — on `keyDown`, check `message.action` to determine which UUID triggered the event and send `play_next` or `play_previous` accordingly
- [ ] Create `actions/mute.js`: on `keyDown`, send `toggle_mute`
- [ ] Update button states using `setState` (e.g., show play icon when paused, pause icon when playing)
- [ ] Listen for HEOS change events (`player_state_changed`, `player_volume_changed`) and update button states accordingly
- [ ] Add all actions to `manifest.json` with appropriate UUIDs, icons, and states

### Done when
You can play/pause, skip tracks, and mute/unmute your HEOS speaker from the M3.

---

## Phase 3: Volume Knob (Day 2)

Map the M3's rotary encoders to HEOS volume control.

### Tasks

- [ ] Create `actions/volume.js`: on `dialRotate`, read `ticks` value and compute target volume locally: `newVolume = clamp(currentVolume + (ticks * stepSize), 0, 100)`
- [ ] Use debounced `set_volume` (absolute) instead of per-tick `volume_up`/`volume_down` — rapid knob rotation generates many events; collapse them into a single `set_volume` with the final target level (see Protocol Reference "Command Serialization" section for design)
- [ ] Decide on step scaling: small ticks = step 2, fast rotation = step 5-10
- [ ] On `dialDown` (knob press), toggle mute
- [ ] Update the knob's display title with current volume level (e.g., "Vol: 45")
- [ ] Listen for `player_volume_changed` events to keep the displayed volume and local tracking in sync with external changes (e.g., someone changes volume from the HEOS app)

### Done when
Rotating a knob smoothly adjusts HEOS volume, pressing the knob mutes/unmutes, and the display reflects the current level.

---

## Phase 4: Preset Buttons (Day 2-3)

Add one-touch buttons for HEOS Favorites.

### Tasks

- [ ] Create `actions/preset.js`: on `keyDown`, send `heos://browse/play_preset?pid=PID&preset=N` (note: this is a `browse/` command, not `player/`)
- [ ] Allow the preset number to be configured per button via action-level settings (`setSettings`/`getSettings`)
- [ ] In the Property Inspector, add a numeric input for the preset number
- [ ] Optionally display the preset name on the button title

### Done when
You can assign different M3 keys to different HEOS presets and trigger them with one press.

---

## Phase 5: Property Inspector (Day 3)

Build the settings UI so users can configure the plugin without editing config files.

### Tasks

- [ ] Create `property-inspector/index.html` with fields for: HEOS speaker IP address, a "Connect & Discover" button, a dropdown listing discovered players
- [ ] Write `property-inspector/js/pi.js` to handle WebSocket communication with the plugin
- [ ] On "Connect & Discover" click, send the IP to the plugin via `sendToPlugin`, plugin connects and runs `get_players`, then sends the player list back via `sendToPropertyInspector`
- [ ] On player selection, save the chosen player's PID using `setGlobalSettings`
- [ ] Style the PI using the StreamDock style guide CSS variables for a native look

### Done when
A user can enter an IP, discover speakers, and select a player entirely from the VSD Craft UI.

---

## Phase 6: Resilience and Polish (Day 3-4)

Handle real-world edge cases and make the plugin production-ready. Note: the command serialization queue, TCP response parser, and error retry logic were built in Phase 1 — this phase adds the connection lifecycle and UX polish on top.

### Tasks

- [ ] Implement automatic reconnection if the TCP socket drops (with exponential backoff: 1s, 2s, 4s, 8s, max 30s)
- [ ] Handle `systemDidWakeUp` event by reconnecting to the HEOS speaker
- [ ] Add heartbeat timer (send `heart_beat` every 30 seconds to keep the connection alive)
- [ ] Buffer and queue commands if the socket is temporarily disconnected (hold in queue, drain when reconnected)
- [ ] Show `showAlert` on buttons when the speaker is unreachable
- [ ] Show `showOk` on buttons after successful command execution
- [ ] Create proper icon assets (128x128 plugin icon, 48x48 category icon, 40x40 action icons)
- [ ] Test with the MagTran M3 specifically: verify all keys and all three knobs work correctly
- [ ] Test on both Windows and macOS

### Done when
The plugin survives sleep/wake cycles, network hiccups, and speaker restarts without manual intervention.

---

## Phase 7: Optional Enhancements (Future)

Nice-to-have features for later iterations.

- [ ] Display album art on button icons (fetch image from `image_url` in now-playing data, resize to button size, set as base64 image)
- [ ] Group control actions (volume/mute for speaker groups)
- [ ] Input source selection (switch between HDMI, optical, Bluetooth, etc. on AVR models)
- [ ] SSDP auto-discovery (instead of manual IP entry, using search target `urn:schemas-denon-com:device:ACT-Denon:1`)
- [ ] Repeat/shuffle mode toggle buttons (using `get_play_mode`/`set_play_mode`)
- [ ] Multiple speaker profiles (save configs for different rooms)
- [ ] Publish to the VSDinside Space platform

## Reference

- The `mthiel/stream-deck-denon-receiver` Elgato Stream Deck plugin (JavaScript, Node.js 20) is a useful reference for code structure, action patterns, and reconnection logic. **However**, it controls Denon AVRs via the telnet protocol on port 23, not the HEOS CLI on port 1255. Its dial/volume handling sends commands with no debouncing or serialization, which works because the AVR telnet protocol is tolerant of rapid commands — the HEOS CLI is not. Do not copy its volume patterns directly.
- VSDinside publishes [porting guides](https://www.vsdinside.com/blogs/blog/porting-stream-deck-plugins-to-stream-dock-m18-a-practical-guide) for adapting Stream Deck plugins to StreamDock.

---

## Estimated Timeline

| Phase | Effort | Cumulative |
|---|---|---|
| Phase 1: Skeleton + Command Infrastructure | 3-4 hours | 4 hours |
| Phase 2: Playback | 3-4 hours | 8 hours |
| Phase 3: Volume | 2-3 hours | 11 hours |
| Phase 4: Presets | 1-2 hours | 13 hours |
| Phase 5: Property Inspector | 2-3 hours | 16 hours |
| Phase 6: Polish | 2-3 hours | 19 hours |

A comfortable weekend project. Phase 7 is ongoing and can be added incrementally.
