# Phase 9: Full-Screen Album Art Background

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 8](./08-CROSS-CUTTING-CONCERNS.md)

## Status

**Deferred.** Research complete; implementation not started. This doc preserves the findings so the work can be picked up later without re-deriving the protocol details.

## Objective

Render album art as a **device-wide background** on MagTran M3 (and any other VSD Craft device with a single continuous display), so the artwork appears across the whole key field — including the gaps between physical keys — with per-key icons (play/pause state, volume, etc.) overlaid on top.

This is a visual upgrade over the current behavior, where album art is a small image bound to a single key's rendering area.

## Why it works on M3

MagTran M3 has a single continuous LCD under transparent magnetic keys. The display extends into the chassis gaps between keys, not just under each key. VSD Craft's own "Interactive Backgrounds" feature (user-configured animated backgrounds and idle screensavers) lights the full surface, confirming the hardware supports it. Older per-key-LCD Stream Dock models (M18, N3) would ignore this event or only paint the union of key rectangles — behavior is model-dependent.

## Protocol

The VSDinside SDK exposes two WebSocket events that are not documented in the Node SDK V2 but ARE present in the Vue SDK. Since all SDKs talk the same JSON-over-WS protocol, Node plugins can send these events raw.

**Set background:**
```json
{
  "event": "setBackground",
  "device": "<deviceId>",
  "payload": {
    "image": "<data-URI or URL>",
    "clearIcon": false
  }
}
```

- `device`: the device ID string. Comes in the `willAppear` event's `device` field (per Stream Deck convention). We don't capture it today — see "Changes required" below.
- `image`: same format as `setImage` — base64 data URI (JPEG/PNG) or SVG data URI.
- `clearIcon`:
  - `true`: per-key icons are wiped while the background is shown (pure wallpaper mode).
  - `false`: per-key icons remain visible, overlaid on top of the background. **This is what we want for album art** — the play/pause icon should still be readable.

**Clear background:**
```json
{
  "event": "stopBackground",
  "device": "<deviceId>",
  "payload": { "clearIcon": true }
}
```

- `clearIcon: true` here means "restore icons after clearing the bg" (confusingly-named parameter). Always pass `true` so keys return to normal.

Sources:
- `VSDVueSDK/vue/src/hooks/plugin.ts` in https://github.com/VSDinside/VSDinside-Plugin-SDK exposes `setBackground(img, device, clearIcon)` and `stopBackground(device)` — the canonical payload shapes above are copied from there.
- M3 "Interactive Backgrounds" announcement: https://www.vsdinside.com/blogs/blog/magtran-m3-redefining-transparent-interaction-for-the-next-generation-desktop-control-center

## User-facing design

**New PI checkbox** in the Play/Pause settings:

> [ ] Show album art as full-screen background

Default off, so existing users keep current per-key album art behavior. When toggled on:

- Album art renders on the whole device via `setBackground` with `clearIcon: false`.
- The per-key play/pause icon (from manifest state) stays visible, overlaid.
- Other plugins' keys (non-HEOS actions) also become overlaid on the art — unavoidable consequence of a device-scoped background. Worth noting in the PI hint text.

**Stop-conditions** that should trigger `stopBackground`:
- Playback stops (`event/player_state_changed` → `stop`).
- Track has no `image_url` (rare; some sources).
- The only play/pause key with this setting disappears (`willDisappear`).
- Plugin disconnects from VSD Craft.
- User toggles the checkbox off.

## Changes required

### 1. Capture `device` from willAppear

`src/index.js` currently tracks `{ action, settings }` per context in `contextMap`. Extend to `{ action, device, settings }`:

```js
case 'willAppear':
  contextMap.set(context, {
    action,
    device: message.device,
    settings: (message.payload && message.payload.settings) || {}
  });
```

Add a helper `getUniqueDevices()` that returns the set of device IDs currently in use (some users run multiple StreamDock devices from one VSD Craft instance).

### 2. Expand the `vsd` helper in `index.js`

```js
function setBackground(device, image, clearIcon = false) {
  send({ event: 'setBackground', device, payload: { image, clearIcon } });
}

function stopBackground(device) {
  send({ event: 'stopBackground', device, payload: { clearIcon: true } });
}
```

Wire into the `vsd` object passed to action handlers.

### 3. Add the PI checkbox

Add to `property-inspector/index.html` in the Play/Pause section:

```html
<div class="sdpi-checkbox-item">
  <input type="checkbox" id="fullscreen-art" />
  <label for="fullscreen-art">Show album art as full-screen background</label>
</div>
<div class="sdpi-item-hint">
  Paints album art across the entire device (MagTran M3 and similar).
  Keys from this and other plugins will appear overlaid on the artwork.
</div>
```

Bind it the same way `showAlbumArt` is bound (saveSettings on change, populate on receive).

### 4. Update `play-pause.js`

Track a per-action `_fullscreenEnabled` map mirroring `_albumArtEnabled`. In `updateMediaDisplay`:

- If `fullscreenEnabled` and we have an image_url: fetch, then `setBackground(device, uri, false)` for each unique device containing this action.
- If we already had a background applied and state transitioned to `stop` or `media` has no URL: call `stopBackground(device)`.
- Keep per-key `setImage(ctx, uri)` running in parallel so the small button still shows art (or skip it when fullscreen is on — design choice).

### 5. Teardown on plugin shutdown / reconnection

Add a teardown path that calls `stopBackground` for every known device before the plugin exits (ws close) and when `heosClient` goes to DISCONNECTED. Otherwise a stuck album art background can survive plugin crashes until the user manually clears it in VSD Craft.

## Open questions (research when implementing)

1. **Device pixel resolution.** The M3's full-screen resolution isn't in the public docs. Need to either:
   - Measure empirically (send images at several sizes, see which renders crisply).
   - Check the SDK's info payload at register time — some Stream Deck devices report a full device pixel geometry in the info object.
   - Contact VSDinside support.
   - Without this, we'd send the fetched image at its native size and let the device downscale — which works but is wasteful for large source images.
2. **Image downscaling.** Still needed. Target resolution is "whatever the M3 wants." `sharp` (native) or `jimp` (pure JS) — `sharp` preferred for speed, `jimp` for zero native deps. Add only when we have a target resolution to aim at.
3. **Race with Interactive Backgrounds.** If the user has configured an Interactive Background in VSD Craft's own settings, does our `setBackground` override it, coexist with it, or get rejected? Needs testing.
4. **Multiple actions, one device.** If two Play/Pause keys on the same device both have fullscreen enabled, our `setBackground` calls will race. Simplest resolution: last-writer-wins (both will emit on every track change, which is fine — same image, same device).
5. **Interaction with `setImage` on other keys.** Does calling `setBackground(clearIcon: false)` affect subsequent `setImage` calls for individual keys? Specifically: does the background get re-composited when a key updates, or is there visible flicker?
6. **`stopBackground` clearIcon semantics.** The comment in the Vue SDK says "如果设置背景的时候设置了清除图标true就需要带上这个参数并设置为true(告诉软件需要恢复图标)" — "if you used clearIcon:true when setting, pass true here to restore icons." We use `clearIcon: false` on set, so on stop we may want `clearIcon: false` too. Needs testing.

## Verification plan

1. Enable fullscreen checkbox in PI.
2. Play a track on a HEOS speaker with album art.
3. Confirm the art fills the M3's entire surface including the chassis between keys.
4. Confirm play/pause icon (state image) remains visible on its key.
5. Confirm other non-HEOS keys on the same device still render (with art as backdrop).
6. Pause playback → `stopBackground` fires → device returns to its usual background (black / whatever user has set in VSD Craft).
7. Skip tracks rapidly → no image ghosting or stuck backgrounds.
8. Kill the plugin process mid-playback → background eventually clears (test the teardown path).
9. Repeat on a per-key-LCD Stream Dock (M18/N3) if available — confirm gracefully degrades (either ignored or only lights up the key areas; neither should crash).

## Non-goals

- Animated album art (looping GIF/MP4 as background). Possible via `setBackground` with a GIF data URI but out of scope for this phase.
- Idle/screensaver customization (VSD Craft's own feature already covers that).
- Per-device independent backgrounds when the user has multiple devices. The current plan uses the same album art on every device running a fullscreen-enabled Play/Pause action. Per-device personalization can come later.
