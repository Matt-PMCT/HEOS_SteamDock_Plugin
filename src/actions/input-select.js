const { heosEncode } = require('../heos-client');

module.exports = {
  actionUUID: 'com.vsd.craft.heos.inputselect',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const settings = message.payload.settings || {};
    const inputName = settings.inputName;
    if (!inputName) { vsd.showAlert(message.context); return; }

    heosClient.enqueue(`heos://browse/play_input?pid=${pid}&input=${heosEncode(inputName)}`)
      .then(() => vsd.showOk(message.context))
      .catch(() => vsd.showAlert(message.context));
  },

  onWillAppear(message, { vsd }) {
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.inputLabel || 'Input');
  },

  onDidReceiveSettings(message, { vsd }) {
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.inputLabel || 'Input');
  }
};
