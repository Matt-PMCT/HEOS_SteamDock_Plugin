const WebSocket = require('ws');
const { HeosClient, parseHeosMessage } = require('./heos-client');

// --- Module-Level State ---

let pluginUUID = null;
let ws = null;
let heosClient = null;
let globalSettings = {};
const contextMap = new Map(); // Map<context, { action, settings }>

// --- Action Handler Registry ---

// Keyed by action UUID. Phase 1: test handler that sends heartbeat.
// Phase 2+ replaces with real action handlers.
const handlers = {};

// Phase 1 test: all actions send heartbeat on keyDown
const ACTION_UUIDS = [
  'com.vsd.craft.heos.playpause',
  'com.vsd.craft.heos.next',
  'com.vsd.craft.heos.previous',
  'com.vsd.craft.heos.mute',
  'com.vsd.craft.heos.volume',
  'com.vsd.craft.heos.preset'
];

for (const uuid of ACTION_UUIDS) {
  handlers[uuid] = {
    onKeyDown(message) {
      console.log('[Plugin] keyDown on', message.action);
      if (!heosClient.isConnected()) {
        showAlert(message.context);
        return;
      }
      heosClient.enqueue('heos://system/heart_beat')
        .then(res => console.log('[Plugin] Heartbeat response:', JSON.stringify(res.heos)))
        .catch(err => console.error('[Plugin] Heartbeat error:', err.message));
    },
    onDialDown(message) {
      console.log('[Plugin] dialDown on', message.action);
      if (!heosClient.isConnected()) {
        showAlert(message.context);
        return;
      }
      heosClient.enqueue('heos://system/heart_beat')
        .then(res => console.log('[Plugin] Heartbeat response:', JSON.stringify(res.heos)))
        .catch(err => console.error('[Plugin] Heartbeat error:', err.message));
    }
  };
}

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

// --- HEOS Event Callback ---

function onHeosEvent(msg) {
  // Phase 2 adds real event handling (player_state_changed, etc.)
  console.log('[HEOS Event]', msg.heos.command, msg.heos.message || '');
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
      if (handler && handler.onWillAppear) handler.onWillAppear(message);
      break;

    case 'willDisappear':
      contextMap.delete(context);
      if (handler && handler.onWillDisappear) handler.onWillDisappear(message);
      break;

    case 'keyDown':
      if (handler && handler.onKeyDown) handler.onKeyDown(message);
      break;

    case 'keyUp':
      if (handler && handler.onKeyUp) handler.onKeyUp(message);
      break;

    case 'dialRotate':
      if (handler && handler.onDialRotate) handler.onDialRotate(message);
      break;

    case 'dialDown':
      if (handler && handler.onDialDown) handler.onDialDown(message);
      break;

    case 'dialUp':
      if (handler && handler.onDialUp) handler.onDialUp(message);
      break;

    case 'didReceiveSettings':
      if (contextMap.has(context)) {
        contextMap.get(context).settings = (message.payload && message.payload.settings) || {};
      }
      if (handler && handler.onDidReceiveSettings) handler.onDidReceiveSettings(message);
      break;

    case 'didReceiveGlobalSettings': {
      const newSettings = (message.payload && message.payload.settings) || {};
      const ipChanged = newSettings.heosIp && newSettings.heosIp !== globalSettings.heosIp;
      globalSettings = newSettings;

      if (ipChanged || (!heosClient.isConnected() && globalSettings.heosIp)) {
        if (ipChanged) heosClient.reconnectDelay = 1000; // Reset backoff on explicit IP change
        heosClient.connect(globalSettings.heosIp);
        // Phase 2 adds: heosClient.runInitSequence(parseInt(globalSettings.playerId, 10))
      }
      break;
    }

    case 'systemDidWakeUp':
      heosClient.reconnect();
      break;

    case 'sendToPlugin':
      if (handler && handler.onSendToPlugin) handler.onSendToPlugin(message);
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
