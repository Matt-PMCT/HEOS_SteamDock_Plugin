# Cross-Cutting Concerns

> [Back to Summary](./00-SUMMARY.md)

These gotchas, constraints, and patterns apply across all phases. Reference this document when implementing any phase.

---

## VSDinside SDK Gotchas

### Knob vs Encoder Naming

- **Manifest:** `"Controllers": ["Knob"]`
- **Runtime:** `payload.controller === "Encoder"`
- **Never** check for `"Knob"` at runtime -- it will never match. Use `"Knob"` only in manifest definitions, `"Encoder"` in runtime comparisons.

### dialUp Timing Bug

`dialUp` fires **immediately** after `dialDown` on StreamDock without waiting for physical release. This makes short/long press detection unreliable and effectively breaks gesture differentiation on knobs. **Do not use `dialUp` for any logic.** Trigger actions on `dialDown` only.

### No setFeedback/setFeedbackLayout

StreamDock does not implement these Stream Deck+ APIs. Use `setImage()` with SVG or base64 PNG instead. Any code ported from Stream Deck that uses `setFeedback` must be rewritten.

### UUIDs Must Be Lowercase

StreamDock preserves UUID case as-is (unlike Elgato Stream Deck which auto-lowercases). All action UUIDs in `manifest.json` and code must use lowercase characters.

### Node.js 20.8.1 Lacks Native WebSocket

Node.js 20 does not include `WebSocket` (added in Node 21). The `ws` package is required for the plugin backend. The Property Inspector runs in a browser context and uses browser-native WebSocket.

### Single Plugin Process

All keys/actions share one plugin process instance, differentiated by `context` values. The plugin must track which contexts belong to which actions.

### Debug Port Security

`"Debug": "--inspect=127.0.0.1:3210"` must be removed from manifest before distribution to avoid exposing a debug port on end-user machines.

### macOS Minimum Version

Node.js support requires VSD Craft **3.10.191.0421** on macOS (higher than Windows minimum of 3.10.188.226). The manifest `Software.MinimumVersion` doesn't distinguish per-platform.

---

## HEOS Protocol Gotchas

### Command Serialization is Mandatory

HEOS devices cannot handle concurrent commands. Sending multiple commands simultaneously causes buffer overflows, dropped responses, and connection instability. **All commands must go through the serialization queue.** Send one, wait for response, send next.

### Player IDs are Signed Integers

PIDs can be negative. **Always store as Numbers internally** (`parseInt(pid, 10)`). Global settings stores them as Strings (JSON serialization); parse back to Number on receipt. This is critical: HEOS event handlers compare `parseInt(params.pid, 10)` (Number) against `heosClient.playerId` -- if `playerId` is a String, the comparison `Number !== String` always fails and all events are silently ignored.

### Message Field is URL-Encoded

The `heos.message` field contains URL-encoded key-value pairs, NOT JSON. Parse by splitting on `&`, then `=`, then `decodeURIComponent` each value.

### play_preset is a Browse Command

```
heos://browse/play_preset?pid=PID&preset=N
```

Not `player/play_preset`. This is a `browse/` group command.

### Events vs Responses

| | Command Response | Event |
|---|---|---|
| `heos.command` | Echoes command (e.g., `player/set_volume`) | Starts with `event/` |
| `heos.result` | Present: `"success"` or `"fail"` | **Absent** |
| `payload` | Optional | Absent (data in `message`) |

### "Command Under Process"

When a command can't return immediately (e.g., browse hitting a remote service), HEOS returns an interim response with `result: ""` and `message: "command under process"`. **Both conditions must be checked** -- `msg.heos.result === '' && msg.heos.message === 'command under process'`. Checking only the message field could misroute a response. **Do NOT resolve the pending command.** Reset the timeout and wait for the real response.

### URL Encoding in Commands

HEOS uses custom URL-encoding for command attribute values: only `&` -> `%26`, `=` -> `%3D`, `%` -> `%25`. **Do NOT use `encodeURIComponent()`** -- it encodes `@`, spaces, and other characters that HEOS may not understand. Use the `heosEncode()` utility from `heos-client.js`. Encode `%` first to avoid double-encoding.

### CLI Module Spin-Up

The HEOS CLI module starts in dormant mode. First connection takes 1-2 seconds before commands work reliably. Keep a persistent connection alive to prevent the module from going dormant again.

### Heartbeat Required

HEOS closes idle connections. Send `heos://system/heart_beat` every 30 seconds through the command queue.

### DHCP and Speaker IP Changes

If the HEOS speaker's IP changes (DHCP lease renewal), the plugin will retry the old IP indefinitely. Known limitation: after 10 failed reconnects, log a warning. SSDP auto-discovery (Phase 7) would solve this. Users must update the IP via the Property Inspector.

### Error 13 and Error 16

- **Error 13:** "Processing previous command" -- the speaker is still working on something. Retry after 200-500ms, max 3 retries.
- **Error 16:** "Too many commands in queue" -- the speaker's internal queue is full. Same retry strategy.

### Event Bursts

`players_changed`, `sources_changed`, `groups_changed`, and `user_changed` can fire in rapid bursts. Debounce (500ms) before reacting.

### Volume Range

0 to 100, integer only. Step values for `volume_up`/`volume_down` must be 1-10.

### Preset Indices

1-based. Preset 0 is invalid.

### TCP Response Parsing

A single socket `data` event may contain partial JSON, exactly one message, or multiple messages. Buffer data, split on `\r\n`, keep trailing fragment. **Skip** malformed lines -- never flush the entire buffer on a parse error.

---

## Security Considerations

### Plaintext Credentials

HEOS sign-in credentials are sent over plaintext TCP. Credentials stored via `setGlobalSettings` are saved in plaintext in VSD Craft's local config. This matches how other StreamDock plugins handle API keys -- there is no encrypted storage API in the SDK.

**Recommendation:** Store username only in global settings. Do not persist passwords. Require re-sign-in after plugin restart. Document this trade-off.

### Debug Port

Remove `--inspect` from manifest before distribution to prevent opening a debug port on user machines.
