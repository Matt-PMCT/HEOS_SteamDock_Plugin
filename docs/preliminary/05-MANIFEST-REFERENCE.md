# manifest.json (Ready to Use)

Copy the JSON below into `com.vsd.craft.heos.sdPlugin/manifest.json`. This defines all six actions for the plugin.

```json
{
  "Name": "HEOS Control",
  "Version": "1.0.0",
  "Author": "Your Name",
  "Description": "Control Denon HEOS speakers from your StreamDock. Play, pause, skip tracks, adjust volume with knobs, mute, and launch favorite presets.",
  "Icon": "images/plugin-icon.png",
  "CategoryIcon": "images/category-icon.png",
  "Category": "Audio",
  "URL": "",
  "CodePathWin": "plugin/index.js",
  "CodePathMac": "plugin/index.js",
  "SDKVersion": 1,
  "Software": {
    "MinimumVersion": "3.10.188.226"
  },
  "OS": [
    {
      "Platform": "windows",
      "MinimumVersion": "10"
    },
    {
      "Platform": "mac",
      "MinimumVersion": "11"
    }
  ],
  "Nodejs": {
    "Version": "20",
    "Debug": "--inspect=127.0.0.1:3210"
  },
  "Actions": [
    {
      "UUID": "com.vsd.craft.heos.playpause",
      "Name": "Play / Pause",
      "Icon": "images/actions/play-pause.png",
      "Tooltip": "Toggle playback on your HEOS speaker",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": true,
      "Controllers": ["Keypad"],
      "States": [
        {
          "Image": "images/actions/play.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Play"
        },
        {
          "Image": "images/actions/pause.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Pause"
        }
      ]
    },
    {
      "UUID": "com.vsd.craft.heos.next",
      "Name": "Next Track",
      "Icon": "images/actions/next.png",
      "Tooltip": "Skip to next track",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": true,
      "Controllers": ["Keypad"],
      "States": [
        {
          "Image": "images/actions/next.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Next"
        }
      ]
    },
    {
      "UUID": "com.vsd.craft.heos.previous",
      "Name": "Previous Track",
      "Icon": "images/actions/prev.png",
      "Tooltip": "Go to previous track",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": true,
      "Controllers": ["Keypad"],
      "States": [
        {
          "Image": "images/actions/prev.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Prev"
        }
      ]
    },
    {
      "UUID": "com.vsd.craft.heos.mute",
      "Name": "Mute Toggle",
      "Icon": "images/actions/mute.png",
      "Tooltip": "Toggle mute on your HEOS speaker",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": true,
      "Controllers": ["Keypad"],
      "States": [
        {
          "Image": "images/actions/unmuted.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Mute"
        },
        {
          "Image": "images/actions/muted.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Muted"
        }
      ]
    },
    {
      "UUID": "com.vsd.craft.heos.volume",
      "Name": "Volume Control",
      "Icon": "images/actions/volume.png",
      "Tooltip": "Rotate knob to adjust HEOS volume, press to mute",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": false,
      "Controllers": ["Knob"],
      "States": [
        {
          "Image": "images/actions/volume.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Vol"
        }
      ]
    },
    {
      "UUID": "com.vsd.craft.heos.preset",
      "Name": "Play Preset",
      "Icon": "images/actions/preset.png",
      "Tooltip": "Play a HEOS favorite preset",
      "PropertyInspectorPath": "property-inspector/index.html",
      "SupportedInMultiActions": true,
      "Controllers": ["Keypad"],
      "Settings": {
        "presetNumber": 1
      },
      "States": [
        {
          "Image": "images/actions/preset.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Preset"
        }
      ]
    }
  ]
}
```

## Notes on This Manifest

**Action UUIDs** follow the pattern `com.vsd.craft.heos.<action>`. These must be globally unique and all lowercase (StreamDock preserves case as-is, unlike Elgato Stream Deck). If you change the vendor prefix, update all references in your plugin code too.

**Next and Previous are separate actions** with distinct UUIDs (`com.vsd.craft.heos.next` and `com.vsd.craft.heos.previous`) so users can place them independently. Both are handled by a single `next-prev.js` file that checks `message.action` to determine which UUID was triggered.

**Controllers** field determines where an action can be placed:
- `"Keypad"` for regular LCD buttons (default if omitted)
- `"Knob"` for rotary encoders (M3 has 3 knobs on the right side)
- `"Information"` for info displays, `"SecondaryScreen"` for secondary screens, `"btn"` for basic buttons
- You can list multiple if an action should work on different input types

**OS MinimumVersion** is set to `"10"` for Windows (Windows 10+) and `"11"` for macOS (macOS 11 Big Sur+). These are intentionally higher than the SDK defaults (`"7"` and `"10.11"`) because VSD Craft itself requires Windows 10+ and macOS 11.0+.

**States** define the visual appearance for multi-state actions. Play/Pause has two states (index 0 = play icon, index 1 = pause icon). The plugin toggles between them using the `setState` event.

**Settings** on the Preset action provides a default value of `1` for the preset number. At runtime, these defaults appear in the `payload.settings` object of `willAppear` and `didReceiveSettings` events. Users override them per button instance via the Property Inspector, which calls `setSettings` to persist changes.

**Nodejs.Debug** is set for development. **You must remove the `"Debug"` line before distributing the plugin** to avoid exposing a debug port on end-user machines. Consider adding a `manifest.release.json` or a build step that strips this field.

**macOS note:** The macOS minimum VSD Craft version for Node.js support is **3.10.191.0421** (higher than the Windows minimum of 3.10.188.226). The manifest `Software.MinimumVersion` field doesn't distinguish per-platform, so be aware that macOS users need the newer version.

**Localization:** The V2 SDK template supports multi-language via JSON files in the `.sdPlugin` root (e.g., `en.json`, `de.json`). This is out of scope for the initial release. If added later, action names and tooltips can be localized by placing translation files alongside the manifest.

**CodePathWin / CodePathMac** both point to `plugin/index.js`, which is the bundled output from `@vercel/ncc` (not the source file). The V2 SDK template uses separate per-platform fields rather than a single `CodePath`. When the `Nodejs` section is present in the manifest, VSD Craft launches this file using its built-in Node.js 20.8.1 runtime. See the SDK Reference doc for the full build process.

**Image paths** are relative to the `.sdPlugin` folder root. You will need to create placeholder images before the plugin will load correctly. Simple colored squares work for initial testing.
