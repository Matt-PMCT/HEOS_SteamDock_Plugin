const { heosEncode } = require('../heos-client');
const { buildButtonSvg } = require('../button-render');
const { consumeButtonRefresh } = require('../button-refresh');

function renderButton(context, settings, vsd) {
  const label = settings.buttonTitle != null
    ? String(settings.buttonTitle)
    : (settings.inputLabel || 'Input');
  vsd.setImage(context, buildButtonSvg(settings.iconColor, label, settings.iconGlyph || 'input'));
  vsd.setTitle(context, '');
}

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
    renderButton(message.context, message.payload.settings || {}, vsd);
  },

  onDidReceiveSettings(message, { vsd }) {
    renderButton(message.context, message.payload.settings || {}, vsd);
  },

  onGlobalSettingsChange({ contexts, vsd }) {
    consumeButtonRefresh(module.exports.actionUUID, contexts, vsd, renderButton);
  }
};
