const WebSocket = require('ws');
const { HeosClient, parseHeosMessage } = require('./heos-client');
const playPause = require('./actions/play-pause');
const nextPrev = require('./actions/next-prev');
const mute = require('./actions/mute');
const volume = require('./actions/volume');
const preset = require('./actions/preset');

// --- Module-Level State ---

let pluginUUID = null;
let ws = null;
let heosClient = null;
let globalSettings = {};
const contextMap = new Map(); // Map<context, { action, settings }>

// --- Action Handler Registry ---

const handlers = {};
handlers[playPause.actionUUID] = playPause;
for (const uuid of nextPrev.actionUUIDs) {
  handlers[uuid] = nextPrev;
}
handlers[mute.actionUUID] = mute;
handlers[volume.actionUUID] = volume;
handlers[preset.actionUUID] = preset;

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
  send({ event: 'setImage', context, payload: { image, target } });
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

// --- HEOS Event Callback ---

function onHeosEvent(msg) {
  const eventName = msg.heos.command;
  const params = parseHeosMessage(msg.heos.message);

  for (const [uuid, handler] of Object.entries(handlers)) {
    if (handler.onHeosEvent) {
      const contexts = getContextsForAction(uuid);
      if (contexts.length > 0) {
        handler.onHeosEvent(eventName, params, { contexts, heosClient, vsd });
      }
    }
  }
}

// --- PI Discovery Data (saved to global settings for PI to read) ---

function savePIDiscoveryData() {
  globalSettings = {
    ...globalSettings,
    _piPlayers: heosClient.players.map(p => ({ pid: p.pid, name: p.name, model: p.model })),
    _piGroups: heosClient.groups.map(g => ({ name: g.name, pids: (g.players || []).map(p => p.pid) })),
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
      if (handler && handler.onWillAppear) handler.onWillAppear(message, { heosClient, vsd });
      break;

    case 'willDisappear':
      contextMap.delete(context);
      if (handler && handler.onWillDisappear) handler.onWillDisappear(message, { heosClient, vsd });
      break;

    case 'keyDown':
      if (handler && handler.onKeyDown) handler.onKeyDown(message, { heosClient, vsd });
      break;

    case 'keyUp':
      if (handler && handler.onKeyUp) handler.onKeyUp(message, { heosClient, vsd });
      break;

    case 'dialRotate':
      if (handler && handler.onDialRotate) handler.onDialRotate(message, { heosClient, vsd });
      break;

    case 'dialDown':
      if (handler && handler.onDialDown) handler.onDialDown(message, { heosClient, vsd });
      break;

    case 'dialUp':
      if (handler && handler.onDialUp) handler.onDialUp(message, { heosClient, vsd });
      break;

    case 'didReceiveSettings':
      if (contextMap.has(context)) {
        contextMap.get(context).settings = (message.payload && message.payload.settings) || {};
      }
      if (handler && handler.onDidReceiveSettings) handler.onDidReceiveSettings(message, { heosClient, vsd });
      break;

    case 'didReceiveGlobalSettings': {
      const newSettings = (message.payload && message.payload.settings) || {};
      const ipChanged = newSettings.heosIp && newSettings.heosIp !== globalSettings.heosIp;
      const playerIdChanged = newSettings.playerId !== globalSettings.playerId;
      const pid = newSettings.playerId ? parseInt(newSettings.playerId, 10) : null;
      globalSettings = newSettings;

      if (ipChanged || (!heosClient.isConnected() && globalSettings.heosIp)) {
        if (ipChanged) heosClient.reconnectDelay = 1000;
        heosClient.playerId = pid;
        heosClient.connect(globalSettings.heosIp);
      } else if (playerIdChanged && heosClient.isConnected()) {
        heosClient.runInitSequence(pid);
      } else if (heosClient.isConnected() && heosClient.players.length > 0 && !globalSettings._piPlayers) {
        // PI cleared _piPlayers (e.g. re-clicked Connect on same IP) -- re-publish
        savePIDiscoveryData();
      }
      break;
    }

    case 'systemDidWakeUp':
      heosClient.reconnect();
      break;

    case 'sendToPlugin':
      if (handler && handler.onSendToPlugin) handler.onSendToPlugin(message, { heosClient, vsd });
      break;

    case 'propertyInspectorDidAppear':
      console.log('[Plugin] PI appeared for', action);
      break;

    case 'propertyInspectorDidDisappear':
      console.log('[Plugin] PI disappeared for', action);
      break;

    default:
      console.log('[Plugin] Unknown event:', event);
      break;
  }
}

// --- WebSocket Connection ---

function connectToVsdCraft(args) {
  ws = new WebSocket('ws://127.0.0.1:' + args.port);

  ws.on('open', () => {
    console.log('[Plugin] Connected to VSD Craft');
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
      console.error('[Plugin] Failed to parse message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[Plugin] WebSocket closed, exiting');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('[Plugin] WebSocket error:', err.message);
    process.exit(1);
  });
}

// --- Bootstrap ---

const args = parseArgs();
pluginUUID = args.pluginUUID;
heosClient = new HeosClient(onHeosEvent);
heosClient.onInitComplete = savePIDiscoveryData;
heosClient.onInitError = savePIError;
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
