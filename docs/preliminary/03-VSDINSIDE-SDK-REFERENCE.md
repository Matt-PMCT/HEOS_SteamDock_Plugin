# VSDinside StreamDock Plugin SDK Reference

A condensed reference for building a Node.js plugin for the VSDinside StreamDock platform (MagTran M3, M18, N4 Pro, etc.). Based on the official SDK documentation at https://sdk.key123.vip/en/

## Plugin Architecture

A StreamDock plugin has two layers, similar to a web app:

- **Backend (Plugin):** Runs as a separate process. For Node.js plugins, this runs in the bundled Node.js 20.8.1 runtime. Communicates with VSD Craft via WebSocket.
- **Frontend (Property Inspector):** An HTML page displayed in VSD Craft when the user selects an action instance. Communicates with the plugin via WebSocket events.

Both layers connect to VSD Craft over WebSocket and exchange JSON messages.

## Plugin Folder Structure

The plugin folder must be named with the pattern `com.yourname.pluginname.sdPlugin` and placed in the VSD Craft plugins directory:

- **Windows:** `C:\Users\<username>\AppData\Roaming\HotSpot\StreamDock\plugins\`
- **macOS:** `~/Library/Application Support/HotSpot/StreamDock/plugins/`

## manifest.json

The manifest defines your plugin's metadata, actions, and runtime requirements. Below is a minimal example showing key structure. See `05-MANIFEST-REFERENCE.md` for the complete, copy-paste-ready manifest with all six actions.

```json
{
  "Name": "HEOS Control",
  "Version": "1.0.0",
  "Author": "Your Name",
  "Description": "Control Denon HEOS speakers from your StreamDock",
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
    { "Platform": "windows", "MinimumVersion": "10" },
    { "Platform": "mac", "MinimumVersion": "11" }
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
      "UUID": "com.vsd.craft.heos.volume",
      "Name": "Volume Control",
      "Icon": "images/actions/volume.png",
      "Tooltip": "Rotate knob to adjust HEOS volume, press to mute",
      "PropertyInspectorPath": "property-inspector/index.html",
      "Controllers": ["Knob"],
      "States": [
        {
          "Image": "images/actions/volume.png",
          "TitleAlignment": "bottom",
          "FontSize": "10",
          "Title": "Vol"
        }
      ]
    }
  ]
}
```

### Key Manifest Fields

| Field | Required | Notes |
|---|---|---|
| `Name` | Yes | Display name in VSD Craft |
| `Version` | Yes | Semantic version string |
| `Author` | Yes | Your name |
| `CodePathWin` | Yes | Path to main plugin script on Windows, relative to .sdPlugin folder |
| `CodePathMac` | Yes (if supporting macOS) | Path to main plugin script on macOS, relative to .sdPlugin folder |
| `SDKVersion` | Yes | Always `1` for current SDK |
| `Nodejs.Version` | Yes (for Node) | Set to `"20"`. Uses the built-in Node.js runtime. |
| `Nodejs.Debug` | Optional | Set to enable Chrome DevTools debugging |
| `Actions` | Yes | Array of action definitions |
| `Actions[].UUID` | Yes | Unique reverse-DNS identifier |
| `Actions[].Controllers` | Optional | `["Keypad"]` for buttons, `["Knob"]` for rotary encoders, `["Information"]` for info displays, `["SecondaryScreen"]` for secondary screens, `["btn"]` for basic buttons, or any combination. Default is `["Keypad"]`. |
| `Actions[].States` | Yes | Array of state objects (image, title defaults) |
| `Actions[].PropertyInspectorPath` | Optional | Path to the HTML settings panel |

## Plugin Registration (Node.js)

When VSD Craft launches your plugin, it passes connection info as command-line arguments:

```
node index.js -port PORT -pluginUUID UUID -registerEvent EVENT -info INFO_JSON
```

Your plugin must:
1. Parse these arguments
2. Open a WebSocket to `ws://127.0.0.1:PORT`
3. Send a registration message

```javascript
// Node.js 20 does NOT have native WebSocket (added in Node 21).
// You must use the 'ws' package and bundle it with @vercel/ncc.
const WebSocket = require('ws');

// VSD Craft passes connection info as CLI args in this order:
//   node index.js -port PORT -pluginUUID UUID -registerEvent EVENT -info INFO_JSON
//
// The V2 SDK template reads fixed indices (process.argv[3], [5], [7], [9]).
// We use key-value parsing instead — same result, more readable, and resilient
// to future argument order changes.
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^-/, '')] = process.argv[i + 1];
}

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

ws.on('open', () => {
  // Register the plugin
  ws.send(JSON.stringify({
    event: args.registerEvent,
    uuid: args.pluginUUID
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);
  // Handle events based on message.event
});
```

**Note on the V2 SDK template approach:** The official template's `utils/plugin.js` reads args by fixed index (`process.argv[3]` for port, `[5]` for uuid, etc.) rather than parsing key-value pairs. Both approaches work. We use key-value parsing because it's self-documenting and doesn't break if VSD Craft ever reorders arguments.

## Events Received by Plugin

These are the WebSocket messages your plugin receives from VSD Craft:

### Button Events

**keyDown** - User pressed a button:
```json
{
  "action": "com.vsd.craft.heos.playpause",
  "event": "keyDown",
  "context": "unique-instance-id",
  "device": "device-id",
  "payload": {
    "settings": {},
    "coordinates": { "column": 0, "row": 0 },
    "state": 0,
    "isInMultiAction": false
  }
}
```

**keyUp** - User released a button. Same structure, `event` is `"keyUp"`.

### Knob/Dial Events

**dialRotate** - User rotated a knob:
```json
{
  "action": "com.vsd.craft.heos.volume",
  "event": "dialRotate",
  "context": "unique-instance-id",
  "device": "device-id",
  "payload": {
    "controller": "Encoder",
    "settings": {},
    "coordinates": { "column": 0, "row": 0 },
    "ticks": 3,
    "pressed": false
  }
}
```

- `controller`: Always `"Encoder"` at runtime, even though the manifest `Controllers` field uses `"Knob"`. **Do not check `payload.controller === "Knob"` — it will never match.** Use `"Encoder"` in runtime comparisons, `"Knob"` only in manifest definitions.
- `ticks`: Positive = clockwise, negative = counter-clockwise, magnitude = speed
- `pressed`: Whether the knob was held down during rotation

**dialDown** / **dialUp** - User pressed/released the knob.

### Lifecycle Events

- **willAppear** - Action instance becomes visible on the device
- **willDisappear** - Action instance is no longer visible
- **didReceiveSettings** - Settings changed for an action instance
- **didReceiveGlobalSettings** - Global settings changed
- **systemDidWakeUp** - Computer woke from sleep (reconnect HEOS here)
- **titleParametersDidChange** - User modified title display parameters
- **deviceDidConnect** / **deviceDidDisconnect** - StreamDock device connected/disconnected
- **propertyInspectorDidAppear** / **propertyInspectorDidDisappear** - Property Inspector (PI) opened/closed
- **applicationDidLaunch** / **applicationDidTerminate** - Monitored app started/stopped (requires `ApplicationsToMonitor` in manifest)
- **sendToPlugin** - Property Inspector sent data to the plugin

## Events Sent by Plugin

These are messages your plugin sends TO VSD Craft:

### Update Button Display

**setTitle** - Change the text on a button:
```json
{
  "event": "setTitle",
  "context": "unique-instance-id",
  "payload": {
    "title": "Vol: 45",
    "target": 0,
    "state": 0
  }
}
```
`target`: 0 = both hardware and software, 1 = hardware only, 2 = software only

**setImage** - Change the icon on a button:
```json
{
  "event": "setImage",
  "context": "unique-instance-id",
  "payload": {
    "image": "data:image/png;base64,iVBORw0KGgo...",
    "target": 0,
    "state": 0
  }
}
```
Also accepts SVG:
```json
{
  "image": "data:image/svg+xml;charset=utf8,<svg>...</svg>"
}
```

**setState** - Toggle between action states (e.g., play icon vs pause icon):
```json
{
  "event": "setState",
  "context": "unique-instance-id",
  "payload": { "state": 1 }
}
```

### Feedback

- **showOk** - Flash a checkmark on the button
- **showAlert** - Flash a warning icon on the button

### Utility

- **openUrl** - Open a URL in the default browser
- **logMessage** - Write a debug message to the VSD Craft log

### Settings

**setGlobalSettings** - Save data shared across all action instances:
```json
{
  "event": "setGlobalSettings",
  "context": "plugin-uuid",
  "payload": {
    "heosIp": "192.168.1.100",
    "playerId": "123456789",
    "playerName": "Living Room"
  }
}
```

**getGlobalSettings** - Request the saved global settings. Response arrives as a `didReceiveGlobalSettings` event.

**setSettings** / **getSettings** - Same pattern but scoped to a single action instance. When an action defines a `Settings` object in the manifest (e.g., `"Settings": {"presetNumber": 1}`), those values serve as defaults. At runtime, read them from the `payload.settings` field in `willAppear` and `didReceiveSettings` events. Update them via `setSettings` from the plugin or Property Inspector.

### Communication with Property Inspector

**sendToPropertyInspector** - Push data to the settings panel:
```json
{
  "action": "com.vsd.craft.heos.playpause",
  "event": "sendToPropertyInspector",
  "context": "unique-instance-id",
  "payload": { "players": [...] }
}
```

## Property Inspector

The Property Inspector is an HTML page that VSD Craft renders when the user selects an action instance. It connects to VSD Craft via a separate WebSocket.

Unlike the plugin (which receives CLI arguments), the Property Inspector (PI) runs in a browser context inside VSD Craft. VSD Craft calls a global JavaScript function with 5 parameters (port, UUID, register event, info, and actionInfo). Registration uses `inPropertyInspectorUUID` instead of `inPluginUUID`:

```javascript
// PI registration (runs in the browser context inside VSD Craft)
function connectElgatoStreamDeckSocket(inPort, inPropertyInspectorUUID, inRegisterEvent, inInfo, inActionInfo) {
  const ws = new WebSocket(`ws://127.0.0.1:${inPort}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      event: inRegisterEvent,
      uuid: inPropertyInspectorUUID
    }));
  };
}
```

Note: The function name `connectElgatoStreamDeckSocket` is a legacy convention from Stream Deck SDK compatibility — VSD Craft calls this function automatically when loading the PI HTML page.

Communication between PI and plugin:
- PI sends `sendToPlugin` to push data to the backend
- Plugin sends `sendToPropertyInspector` to push data to the PI

For our HEOS plugin, the PI will provide:
- A text field for entering the HEOS speaker IP address
- A "Discover" button that triggers player discovery
- A dropdown to select which player to control
- For preset actions, a number field to specify which preset to play

## Debugging

1. Set `"Debug": "--inspect=127.0.0.1:3210"` in manifest.json under `Nodejs`
2. Open `chrome://inspect` in Chrome or Edge
3. Click "Configure" and add `127.0.0.1:3210`
4. Your plugin should appear under "Remote Target"
5. VSD Craft also has a built-in debug console, accessible by double-clicking the software version number in settings

## Build Process

Node.js 20.8.1 does not include a native WebSocket implementation, so plugins that use the `ws` package (or any npm dependency) must bundle their code before deployment. The official SDK V2 template uses `@vercel/ncc` for this.

### package.json

```json
{
  "name": "heos-streamdock-plugin",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "ncc build src/index.js -o com.vsd.craft.heos.sdPlugin/plugin",
    "dev": "ncc build src/index.js -o com.vsd.craft.heos.sdPlugin/plugin --watch"
  },
  "dependencies": {
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@vercel/ncc": "^0.38.0"
  }
}
```

### Build workflow

1. `npm install` — install `ws` and `@vercel/ncc`
2. `npm run build` — compiles `src/index.js` and all dependencies into a single `com.vsd.craft.heos.sdPlugin/plugin/index.js`
3. Copy/symlink the `.sdPlugin` folder to the plugins directory
4. Restart VSD Craft

The `ncc` bundler inlines `require('ws')` and any other dependencies into one file, eliminating the need to ship `node_modules/` inside the plugin.

### CodePath

When the `Nodejs` section is present in `manifest.json`, VSD Craft launches the file specified in `CodePathWin` / `CodePathMac` using its built-in Node.js 20.8.1 runtime. The V2 SDK template uses per-platform fields (`CodePathWin`, `CodePathMac`) rather than a single `CodePath`. Set both to `plugin/index.js` — this points to the bundled output, not the source file.

**Note:** The official SDK V1 templates compile to `plugin/app.exe` using `@vercel/ncc` with a different build target. With the V2 SDK and the `Nodejs` manifest block, VSD Craft handles Node.js execution directly, so a plain `.js` entry point works. If you encounter launch issues, check the VSD Craft debug log (double-click version number in settings) and verify the `Nodejs.Version` field is set to `"20"`.

**Note:** The V2 SDK template also includes an `autofile.js` script that automates copying the built plugin into the VSD Craft plugins directory. Our setup uses manual copy/symlink instead, but you can reference the template's `autofile.js` if you prefer automated deployment.

## Plugin Installation for Development

During development, place your `.sdPlugin` folder directly in the plugins directory:

- **Windows:** `C:\Users\<username>\AppData\Roaming\HotSpot\StreamDock\plugins\com.vsd.craft.heos.sdPlugin\`
- **macOS:** `~/Library/Application Support/HotSpot/StreamDock/plugins/com.vsd.craft.heos.sdPlugin/`

Restart VSD Craft after adding or modifying the plugin. During active development, use `npm run dev` to auto-rebuild on source changes — you still need to restart VSD Craft to reload the plugin.

## Important SDK Notes

- **UUIDs must be all lowercase.** StreamDock preserves UUID case as-is (unlike Elgato Stream Deck which auto-lowercases). Ensure all action UUIDs use lowercase characters.
- **`setFeedback` and `setFeedbackLayout` are NOT supported** on StreamDock — use `setImage` instead.
- **Local debug interface:** `http://localhost:23519/` provides a browser-based debugging UI for plugins and property inspectors during development.
- **Single instance:** All keys/actions share one plugin process instance, differentiated by `context` values.
- **macOS minimum version:** Node.js support requires VSD Craft **3.10.191.0421** on macOS (the Windows minimum is 3.10.188.226).
- **Existing reference:** The `mthiel/stream-deck-denon-receiver` Elgato Stream Deck plugin (JavaScript, Node.js 20) controls Denon receivers with dial support and is a useful architectural reference. VSDinside publishes [porting guides](https://www.vsdinside.com/blogs/blog/porting-stream-deck-plugins-to-stream-dock-m18-a-practical-guide) for adapting Stream Deck plugins.

## V2 SDK Template Extras (Not Used)

The official V2 SDK Node.js template includes several components we intentionally skip:

- **`utils/plugin.js`** — `Plugins` (singleton), `Actions`, and `EventEmitter` classes that abstract WebSocket registration and event dispatch. Our plugin is small enough that direct WebSocket handling is cleaner.
- **`fs-extra`** and **`log4js`** dependencies — the template includes these for file operations and structured logging. We use only `ws` to minimize bundle size. For debugging, `console.log` output appears in the VSD Craft debug log (double-click version number in settings).
- **`autofile.js`** — a post-build script that copies the bundled plugin into the VSD Craft plugins directory. It uses Windows-specific paths (`process.env.APPDATA`, backslash separators). We use manual copy/symlink instead (see Development Deployment below).
- **Localization JSON files** — the template ships `en.json`, `de.json`, `fr.json`, `ja.json`, `ko.json`, `zh_CN.json` for multi-language support. Localization is out of scope for the initial release but can be added later by placing localization files in the `.sdPlugin` root.

## Development Deployment

### One-time setup (symlink method — recommended)

Symlinking the `.sdPlugin` folder lets you rebuild without re-copying:

**Windows (run as Administrator):**
```cmd
mklink /D "%APPDATA%\HotSpot\StreamDock\plugins\com.vsd.craft.heos.sdPlugin" "C:\path\to\heos-plugin\com.vsd.craft.heos.sdPlugin"
```

**macOS:**
```bash
ln -s /path/to/heos-plugin/com.vsd.craft.heos.sdPlugin ~/Library/Application\ Support/HotSpot/StreamDock/plugins/com.vsd.craft.heos.sdPlugin
```

### Iteration workflow

1. Edit source files in `src/`
2. Run `npm run build` (or `npm run dev` for watch mode)
3. Restart VSD Craft to reload the plugin (required — there is no hot-reload)
4. Check the debug log if the plugin fails to load (double-click the version number in VSD Craft settings)

### Copy method (alternative)

If symlinks aren't an option, copy the entire `.sdPlugin` folder after each build:

**Windows:**
```cmd
xcopy /E /Y "com.vsd.craft.heos.sdPlugin" "%APPDATA%\HotSpot\StreamDock\plugins\com.vsd.craft.heos.sdPlugin\"
```

**macOS:**
```bash
cp -R com.vsd.craft.heos.sdPlugin ~/Library/Application\ Support/HotSpot/StreamDock/plugins/
```

## Publishing

Completed plugins can be published to the VSDinside Space platform at https://space.key123.vip for other users to download.
