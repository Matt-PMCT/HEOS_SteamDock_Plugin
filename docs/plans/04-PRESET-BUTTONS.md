# Phase 4: Preset Buttons

> [Back to Summary](./00-SUMMARY.md) | Prev: [Phase 3](./03-VOLUME-KNOB.md) | Next: [Phase 5 -- Property Inspector](./05-PROPERTY-INSPECTOR.md)

## Objective

Add one-touch buttons for HEOS Favorites (presets). Each button instance is configured with a preset number (1-based) via per-action settings. This phase exercises the per-action settings system (`setSettings`/`getSettings`) and the `browse/play_preset` command. Requires HEOS account sign-in for streaming service favorites.

**Done when:** Pressing a preset button plays the configured HEOS Favorite on the speaker.

## Dependencies

Phase 1 (command queue) and Phase 2 (player ID, init sequence). Phase 3 (volume) is independent.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/actions/preset.js` | **New** |
| `src/index.js` | **Modify** -- register handler |

---

## Step 1: `src/actions/preset.js`

```js
const { parseHeosMessage } = require('../heos-client');

module.exports = {
  actionUUID: 'com.vsd.craft.heos.preset',

  onKeyDown(message, { heosClient, vsd }) {
    const pid = heosClient.playerId;
    if (!pid) { vsd.showAlert(message.context); return; }

    // Read preset number from per-action settings
    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;

    if (presetNumber < 1) {
      vsd.showAlert(message.context);
      return;
    }

    // NOTE: browse/ command, not player/
    heosClient.enqueue(`heos://browse/play_preset?pid=${pid}&preset=${presetNumber}`)
      .then(() => {
        // Queue resolves only on success (rejects on HEOS errors)
        vsd.showOk(message.context);
      })
      .catch((err) => {
        // Check for sign-in error (error 8 = user not logged in)
        if (err.message && err.message.includes('HEOS error 8')) {
          console.warn('[HEOS] Preset requires HEOS account sign-in');
        }
        vsd.showAlert(message.context);
      });
  },

  onWillAppear(message, { vsd }) {
    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;
    vsd.setTitle(message.context, `P${presetNumber}`);
  },

  onDidReceiveSettings(message, { vsd }) {
    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;
    vsd.setTitle(message.context, `P${presetNumber}`);
  },

  onSendToPlugin(message, { heosClient, vsd }) {
    // Handle PI requests (covered more thoroughly in Phase 5)
  }
};
```

---

## Step 2: Settings Flow

The preset number uses the per-action settings system (distinct from global settings):

1. **Manifest default:** `"Settings": { "presetNumber": 1 }` in the preset action definition
2. **On `willAppear`:** `message.payload.settings.presetNumber` is `1` (or whatever user previously set)
3. **PI changes:** Property Inspector (Phase 5) provides a number input calling `setSettings`
4. **Plugin receives `didReceiveSettings`:** updates button title
5. **On `keyDown`:** handler reads `message.payload.settings.presetNumber`

---

## Step 3: Register in `index.js`

```js
const preset = require('./actions/preset');
handlers[preset.actionUUID] = preset;
```

---

## Critical Edge Cases

1. **HEOS account not signed in:** `play_preset` returns error 8 for streaming-service presets (Spotify, TuneIn). Local presets (USB, NAS) may work without sign-in. Show alert, log message.
2. **Preset out of range:** User configures preset 10 but only has 5 favorites -- HEOS returns error 4 or 9. Show alert.
3. **Preset number 0 or negative:** Validate and reject before sending.
4. **No settings yet:** Default to preset 1 if `settings.presetNumber` is undefined or NaN.
5. **Rapid presses:** Serialized via queue, each completes. Pressing twice quickly = play, then play again (harmless).

## Verification

1. Drag preset action onto M3 button -- displays "P1"
2. Press button -- preset 1 starts playing on HEOS speaker
3. (After Phase 5) Change preset number to 3 via PI -- button shows "P3", press plays preset 3
4. Test with HEOS account signed out -- alert on streaming presets
5. Test invalid preset number (higher than available) -- alert
