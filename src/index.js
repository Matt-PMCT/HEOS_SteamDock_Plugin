const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const logger = require('./logger');
const { HeosClient, ConnectionState, parseHeosMessage } = require('./heos-client');

// Debug log file — users toggle `debugLogging` in the PI to enable writes here.
const LOG_PATH = path.join(os.homedir(), 'heos-plugin.log');
const playPause = require('./actions/play-pause');
const nextPrev = require('./actions/next-prev');
const mute = require('./actions/mute');
const volume = require('./actions/volume');
const preset = require('./actions/preset');
const groupPreset = require('./actions/group-preset');
const playMode = require('./actions/play-mode');
const groupVolume = require('./actions/group-volume');
const inputSelect = require('./actions/input-select');
const profileSwitch = require('./actions/profile-switch');
const playUrl = require('./actions/play-url');
const volumeDisplay = require('./actions/volume-display');
const { discoverHeosSpeakers } = require('./ssdp-discovery');

// --- Process-Level Safety Net ---
// Without these, a single sync throw or rejected promise anywhere in the
// plugin (action handler, HEOS parser, reconnect logic) terminates the Node
// process. VSD Craft then sees the plugin die at startup if the configured
// IP is unreachable, leaving the user unable to reach the PI to fix it.
// Log-and-keep-running is the right default at the system boundary.
process.on('uncaughtException', (err) => {
  try {
    logger.error('[HEOS-Plugin] uncaughtException:', err && err.stack || err);
  } catch (_) { /* logger itself failed — nothing safe to do */ }
});
process.on('unhandledRejection', (reason) => {
  try {
    logger.error('[HEOS-Plugin] unhandledRejection:', reason && reason.stack || reason);
  } catch (_) { /* same */ }
});

// --- Module-Level State ---

let pluginUUID = null;
let ws = null;
let heosClient = null;
let globalSettings = {};
const contextMap = new Map(); // Map<context, { action, settings }>

// Fields the plugin owns and publishes to the PI. If the PI ever echoes back
// stale null/undefined values for any of these, we preserve our current value
// rather than letting the PI clobber us.
const PLUGIN_OWNED_KEYS = [
  '_piPlayers', '_piGroups', '_piSources', '_piSignedIn',
  '_piError', '_piDiscoveryResults', '_piDiscoveryRequestId',
  '_piLogPath'
];

// VSD Craft lifecycle events we receive but don't act on — log them once in
// debug builds if ever needed, but don't spam the default log.
const SILENT_EVENTS = new Set([
  'titleParametersDidChange',
  'deviceDidConnect',
  'deviceDidDisconnect',
  'applicationDidLaunch',
  'applicationDidTerminate'
]);

// --- Action Handler Registry ---

const handlers = {};
handlers[playPause.actionUUID] = playPause;
for (const uuid of nextPrev.actionUUIDs) {
  handlers[uuid] = nextPrev;
}
handlers[mute.actionUUID] = mute;
handlers[volume.actionUUID] = volume;
handlers[preset.actionUUID] = preset;
handlers[groupPreset.actionUUID] = groupPreset;
for (const uuid of playMode.actionUUIDs) {
  handlers[uuid] = playMode;
}
handlers[groupVolume.actionUUID] = groupVolume;
handlers[inputSelect.actionUUID] = inputSelect;
handlers[profileSwitch.actionUUID] = profileSwitch;
handlers[playUrl.actionUUID] = playUrl;
handlers[volumeDisplay.actionUUID] = volumeDisplay;

// --- CLI Argument Parsing ---

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i].replace(/^-/, '')] = process.argv[i + 1];
  }
  // info is a JSON string containing device info
  if (args.info) {
    try { args.info = JSON.parse(args.info); } catch (e) { args.info = {}; }
  }
  return args;
}

// --- VSD Craft Helper Functions ---

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function setTitle(context, title, target = 0) {
  send({ event: 'setTitle', context, payload: { title, target } });
}

function setState(context, state) {
  send({ event: 'setState', context, payload: { state } });
}

function setImage(context, image, target = 0) {
  // Per Stream Deck / VSD Craft protocol: OMITTING the image field resets the
  // key to its manifest-declared state image. Passing image:null does NOT
  // reset — it leaves the previous image in place. Callers who want to clear
  // a previously-set image (e.g. album art being turned off) pass null here.
  const payload = { target };
  if (image != null) payload.image = image;
  send({ event: 'setImage', context, payload });
}

function showOk(context) {
  send({ event: 'showOk', context });
}

function showAlert(context) {
  send({ event: 'showAlert', context });
}

function setGlobalSettings(payload) {
  send({ event: 'setGlobalSettings', context: pluginUUID, payload });
}

function getGlobalSettings() {
  send({ event: 'getGlobalSettings', context: pluginUUID });
}

function setSettings(context, payload) {
  send({ event: 'setSettings', context, payload });
}

function sendToPropertyInspector(action, context, payload) {
  send({ event: 'sendToPropertyInspector', action, context, payload });
}

// --- VSD Helper Object (passed to action handlers) ---

const vsd = {
  setTitle,
  setState,
  setImage,
  showOk,
  showAlert,
  setGlobalSettings,
  requestGlobalSettings: getGlobalSettings,
  getGlobalSettings: () => ({ ...globalSettings }),
  setSettings,
  sendToPropertyInspector
};

// --- Context Helpers ---

function getContextsForAction(actionUUID) {
  const contexts = [];
  for (const [ctx, info] of contextMap) {
    if (info.action === actionUUID) contexts.push(ctx);
  }
  return contexts;
}

// Invoke a handler method safely. A buggy or uninitialized action must not
// be allowed to take down the plugin process — log and continue.
function safeCall(handler, method, ...args) {
  if (!handler || typeof handler[method] !== 'function') return;
  try {
    handler[method](...args);
  } catch (e) {
    const uuid = handler.actionUUID || (handler.actionUUIDs && handler.actionUUIDs[0]) || '<unknown>';
    logger.error(`[HEOS-Plugin] handler ${uuid}.${method} threw:`, e && e.stack || e);
  }
}

// --- HEOS Event Callback ---

function onHeosEvent(msg) {
  const eventName = msg.heos.command;
  const params = parseHeosMessage(msg.heos.message);

  for (const [uuid, handler] of Object.entries(handlers)) {
    if (handler.onHeosEvent) {
      const contexts = getContextsForAction(uuid);
      if (contexts.length > 0) {
        safeCall(handler, 'onHeosEvent', eventName, params, { uuid, contexts, heosClient, vsd });
      }
    }
  }
}

// --- PI Discovery Data (saved to global settings for PI to read) ---

function savePIDiscoveryData() {
  globalSettings = {
    ...globalSettings,
    _piPlayers: heosClient.players.map(p => ({ pid: p.pid, name: p.name, model: p.model })),
    _piGroups: heosClient.groups.map(g => ({ gid: g.gid, name: g.name, pids: (g.players || []).map(p => p.pid) })),
    _piSources: heosClient.musicSources.map(s => ({ sid: s.sid, name: s.name, type: s.type })),
    _piSignedIn: heosClient.signedIn,
    _piError: null
  };
  setGlobalSettings(globalSettings);
}

function savePIError(message) {
  globalSettings = {
    ...globalSettings,
    _piPlayers: null,
    _piError: message
  };
  setGlobalSettings(globalSettings);
}

// --- Event Dispatch ---

function dispatchEvent(message) {
  const { event, action, context } = message;
  const handler = action ? handlers[action] : null;

  switch (event) {
    case 'willAppear':
      contextMap.set(context, {
        action,
        settings: (message.payload && message.payload.settings) || {}
      });
      safeCall(handler, 'onWillAppear', message, { heosClient, vsd });
      break;

    case 'willDisappear':
      contextMap.delete(context);
      safeCall(handler, 'onWillDisappear', message, { heosClient, vsd });
      break;

    case 'keyDown':
      logger.log('[HEOS-Plugin] keyDown', action, 'ctx=' + (context || '').substring(0, 12));
      safeCall(handler, 'onKeyDown', message, { heosClient, vsd });
      break;

    case 'keyUp':
      safeCall(handler, 'onKeyUp', message, { heosClient, vsd });
      break;

    case 'dialRotate':
      safeCall(handler, 'onDialRotate', message, { heosClient, vsd });
      break;

    case 'dialDown':
      logger.log('[HEOS-Plugin] dialDown', action, 'ctx=' + (context || '').substring(0, 12));
      safeCall(handler, 'onDialDown', message, { heosClient, vsd });
      break;

    case 'dialUp':
      safeCall(handler, 'onDialUp', message, { heosClient, vsd });
      break;

    case 'didReceiveSettings':
      if (contextMap.has(context)) {
        contextMap.get(context).settings = (message.payload && message.payload.settings) || {};
      }
      safeCall(handler, 'onDidReceiveSettings', message, { heosClient, vsd });
      break;

    case 'didReceiveGlobalSettings': {
      const newSettings = (message.payload && message.payload.settings) || {};
      const ipChanged = newSettings.heosIp && newSettings.heosIp !== globalSettings.heosIp;
      // Normalize playerId to a number on both sides before comparing — one side
      // can be a String (from PI) while the other is a Number (profile-switch),
      // and HEOS silently drops events when the mismatch slips into event filters.
      const newPid = newSettings.playerId != null && newSettings.playerId !== ''
        ? parseInt(newSettings.playerId, 10) : null;
      const oldPid = globalSettings.playerId != null && globalSettings.playerId !== ''
        ? parseInt(globalSettings.playerId, 10) : null;
      const playerIdChanged = newPid !== oldPid;
      const discoverRequested = newSettings._discoverRequest && newSettings._discoverRequest !== globalSettings._discoverRequest;

      // Merge: take the new settings but ALWAYS overwrite plugin-owned `_pi*`
      // keys with our current value. The PI can echo these back (stale non-null
      // data from before a plugin-side update, or a null written to "consume"
      // them) but the plugin is the sole authority. The next plugin-side write
      // is what updates them.
      const merged = { ...newSettings };
      for (const key of PLUGIN_OWNED_KEYS) {
        if (key in globalSettings) {
          merged[key] = globalSettings[key];
        } else {
          delete merged[key];
        }
      }
      globalSettings = merged;

      // Apply debug logging toggle from user settings.
      logger.setEnabled(globalSettings.debugLogging === true, LOG_PATH);

      // Notify action handlers that global settings changed. This is our
      // workaround for VSD Craft not pushing didReceiveSettings to the plugin
      // on PI writes — actions that have user-tunable prefs (e.g. showAlbumArt)
      // store them globally and re-render here.
      for (const [uuid, handler] of Object.entries(handlers)) {
        if (handler.onGlobalSettingsChange) {
          const actionContexts = getContextsForAction(uuid);
          if (actionContexts.length > 0) {
            safeCall(handler, 'onGlobalSettingsChange', {
              contexts: actionContexts, heosClient, vsd
            });
          }
        }
      }

      // Advertise the log file path to the PI so it can display it verbatim.
      if (globalSettings._piLogPath !== LOG_PATH) {
        globalSettings._piLogPath = LOG_PATH;
        setGlobalSettings(globalSettings);
      }

      // SSDP discovery request from PI
      if (discoverRequested) {
        const requestId = newSettings._discoverRequest;
        globalSettings._discoverRequest = null;
        setGlobalSettings(globalSettings);
        discoverHeosSpeakers(5000)
          .then(results => {
            globalSettings = {
              ...globalSettings,
              _piDiscoveryResults: results,
              _piDiscoveryRequestId: requestId
            };
            setGlobalSettings(globalSettings);
          })
          .catch(err => {
            logger.error('[HEOS-Plugin] SSDP discovery failed:', err.message);
            globalSettings = {
              ...globalSettings,
              _piDiscoveryResults: [],
              _piDiscoveryRequestId: requestId,
              _piError: 'Discovery failed: ' + err.message
            };
            setGlobalSettings(globalSettings);
          });
        break;
      }

      if (ipChanged || (!heosClient.isConnected() && globalSettings.heosIp)) {
        // Reset the reconnect-attempt counter for any explicit (PI-driven)
        // connect — IP change, fresh launch, or user clicking Connect after
        // the auto-loop gave up. Without this, the cap stays armed forever.
        heosClient.reconnectDelay = 1000;
        heosClient.reconnectAttempts = 0;
        heosClient.playerId = newPid;
        heosClient.connect(globalSettings.heosIp);
      } else if (playerIdChanged && heosClient.isConnected()) {
        heosClient.runInitSequence(newPid);
      } else if (heosClient.isConnected() && heosClient.players.length > 0 && !globalSettings._piPlayers) {
        // PI cleared _piPlayers (e.g. re-clicked Connect on same IP) -- re-publish
        savePIDiscoveryData();
      }
      break;
    }

    case 'systemDidWakeUp':
      logger.log('[HEOS-Plugin] System woke up, reconnecting...');
      heosClient.reconnect();
      break;

    case 'sendToPlugin':
      safeCall(handler, 'onSendToPlugin', message, { heosClient, vsd });
      break;

    case 'propertyInspectorDidAppear':
      logger.log('[HEOS-Plugin] PI appeared for', action);
      break;

    case 'propertyInspectorDidDisappear':
      logger.log('[HEOS-Plugin] PI disappeared for', action);
      break;

    default:
      if (!SILENT_EVENTS.has(event)) {
        logger.log('[HEOS-Plugin] Unknown event:', event);
      }
      break;
  }
}

// --- WebSocket Connection ---

function connectToVsdCraft(args) {
  ws = new WebSocket('ws://127.0.0.1:' + args.port);

  ws.on('open', () => {
    logger.log('[HEOS-Plugin] Connected to VSD Craft');
    // Register the plugin
    ws.send(JSON.stringify({
      event: args.registerEvent,
      uuid: args.pluginUUID
    }));
    // Request saved settings to trigger auto-connect
    getGlobalSettings();
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      dispatchEvent(message);
    } catch (e) {
      logger.error('[HEOS-Plugin] Failed to parse message:', e.message);
    }
  });

  ws.on('close', () => {
    logger.log('[HEOS-Plugin] WebSocket closed, exiting');
    process.exit(0);
  });

  ws.on('error', (err) => {
    // Don't exit here — 'close' will fire right after for any real disconnect
    // and handle teardown. Exiting on transient errors (e.g. a temporary
    // socket hiccup the ws library is going to recover from) is what locked
    // the user out before.
    logger.error('[HEOS-Plugin] WebSocket error:', err.message);
  });
}

// --- Bootstrap ---

const args = parseArgs();
pluginUUID = args.pluginUUID;
heosClient = new HeosClient(onHeosEvent);
heosClient.onInitComplete = () => {
  savePIDiscoveryData();
  // Refresh all button displays after init (player state is now current)
  for (const [ctx, info] of contextMap) {
    const handler = handlers[info.action];
    safeCall(handler, 'onWillAppear',
      { context: ctx, action: info.action, payload: { settings: info.settings } },
      { heosClient, vsd }
    );
  }
};
heosClient.onInitError = savePIError;

// Connection state listener: alert buttons on disconnect, refresh on reconnect
heosClient.onStateChange((newState, oldState) => {
  try {
    if (newState === ConnectionState.DISCONNECTED || newState === ConnectionState.RECONNECTING) {
      for (const [ctx] of contextMap) {
        vsd.showAlert(ctx);
      }
    }

    // Button refresh happens in onInitComplete (after player state is polled),
    // not here, to avoid displaying stale state.
  } catch (e) {
    logger.error('[HEOS-Plugin] onStateChange threw:', e && e.stack || e);
  }
});

connectToVsdCraft(args);

// --- Exports (for action handlers in later phases) ---

module.exports = {
  setTitle,
  setState,
  setImage,
  showOk,
  showAlert,
  setGlobalSettings,
  requestGlobalSettings: getGlobalSettings,
  setSettings,
  sendToPropertyInspector,
  getHeosClient: () => heosClient,
  getGlobalSettingsData: () => globalSettings,
  getContextMap: () => contextMap
};
