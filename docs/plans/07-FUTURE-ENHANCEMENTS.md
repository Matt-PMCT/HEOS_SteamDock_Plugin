# Phase 7: Future Enhancements

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 6](./06-RESILIENCE-AND-POLISH.md) | See also: [Cross-Cutting Concerns](./08-CROSS-CUTTING-CONCERNS.md)

## Objective

Catalog of deferred features that add value but are not required for the core plugin. Each enhancement is independent and can be implemented in any order. This serves as a backlog specification.

## Dependencies

All enhancements require Phases 1-6 complete. Each is independent of other enhancements.

---

## Enhancement 1: Album Art on Button Display

**Files:** `src/actions/play-pause.js`, new `src/image-utils.js`

### Implementation

- On `player_now_playing_changed`, check for `image_url` in media payload
- Fetch image via `http.get`/`https.get` (Node.js stdlib -- no new dependency)
- Render as SVG with embedded base64 (no Canvas dependency needed):

```js
function makeAlbumArtSVG(base64ImageData, title) {
  return `data:image/svg+xml;charset=utf8,<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">
    <image href="data:image/jpeg;base64,${base64ImageData}" width="72" height="72"/>
    <rect y="52" width="72" height="20" fill="rgba(0,0,0,0.7)"/>
    <text x="36" y="66" font-size="9" fill="white" text-anchor="middle">${escapeXml(title)}</text>
  </svg>`;
}
```

- `vsd.setImage(context, svgDataUri)` on all play/pause contexts
- Cache last `image_url` to avoid re-fetching
- Handle HTTP redirects (HEOS URLs often redirect) -- Node.js `http.get` doesn't follow redirects by default
- 3-second fetch timeout, fallback to default icon on failure

### Edge Cases

- Some sources have no album art
- Radio streams may have station logos
- Image URLs may be HTTP (not HTTPS)

---

## Enhancement 2: SSDP Auto-Discovery

**Files:** New `src/ssdp-discovery.js`, update PI

### Implementation

- UDP multicast via `dgram` module
- Search target: `urn:schemas-denon-com:device:ACT-Denon:1`
- 5-second scan, collect unique IPs

```js
function discoverHeosSpeakers(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const searchMessage = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: urn:schemas-denon-com:device:ACT-Denon:1\r\n\r\n'
    );

    socket.on('message', (msg, rinfo) => {
      const location = msg.toString().match(/LOCATION:\s*(.+)/i);
      if (location) {
        found.set(rinfo.address, { ip: rinfo.address, location: location[1].trim() });
      }
    });

    socket.bind(() => {
      socket.addMembership('239.255.255.250');
      socket.send(searchMessage, 0, searchMessage.length, 1900, '239.255.255.250');
    });

    setTimeout(() => { socket.close(); resolve(Array.from(found.values())); }, timeoutMs);
  });
}
```

- PI gets a "Discover" button that triggers SSDP via plugin
- Shows clickable list of found speakers with names
- Clicking auto-fills IP field

---

## Enhancement 3: Group Volume Control

**Files:** New `src/actions/group-volume.js`, manifest update

### Implementation

- New action with `Controllers: ["Knob"]`
- Uses `heos://group/get_volume?gid=GID` and `heos://group/set_volume?gid=GID&level=LEVEL`
- Same debounce pattern as player volume (Phase 3)
- Track groups via `get_groups` and `groups_changed` event
- PI needs group selector (groups are dynamic)

---

## Enhancement 4: Input Source Selection

**Files:** New `src/actions/input-select.js`, manifest update

### Implementation

- For AVR models: select HDMI, optical, Bluetooth, etc.
- `heos://browse/get_music_sources` to list sources
- `heos://browse/play_input?pid=PID&input=INPUT_NAME` to switch
- PI dropdown of available inputs
- Button shows current input name

---

## Enhancement 5: Repeat/Shuffle Toggle

**Files:** New `src/actions/play-mode.js`, manifest update

### Implementation

- Two actions: repeat toggle (off -> on_all -> on_one -> off) and shuffle toggle (on/off)
- `heos://player/get_play_mode` and `heos://player/set_play_mode`
- Listen for `repeat_mode_changed` and `shuffle_mode_changed` events
- Multi-state buttons: repeat has 3 states, shuffle has 2

---

## Enhancement 6: Multiple Speaker Profiles

**Files:** Update PI, update global settings schema

### Implementation

- Save multiple IP/player configurations as named profiles
- Store as array in global settings: `profiles: [{ name, ip, pid }, ...]`
- PI: profile selector with add/remove/rename controls
- New action to switch profiles from button press

---

## Enhancement 7: Now-Playing Title on Button

**Files:** Update `src/actions/play-pause.js`

### Implementation

- On `player_now_playing_changed`, set play/pause button title to current track
- Format: `artist - song` or just `song`
- Truncate to ~10 characters with ellipsis for readability

---

## Verification (per enhancement)

1. **Album art:** Play track with art, verify on button
2. **SSDP:** Click Discover, speaker appears without manual IP
3. **Group volume:** Create group, assign knob, verify control
4. **Input select:** On AVR, switch HDMI to Bluetooth via button
5. **Repeat/shuffle:** Cycle modes, verify speaker + button sync
6. **Profiles:** Save two profiles, switch, correct speaker responds
7. **Now-playing:** Different tracks, title updates within 2s
