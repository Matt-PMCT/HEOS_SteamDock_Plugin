const { buildButtonSvg } = require('../button-render');
const { consumeButtonRefresh } = require('../button-refresh');

function renderButton(context, settings, vsd) {
  const presetNumber = parseInt(settings.presetNumber, 10) || 1;
  const fallback = 'P' + presetNumber;
  const label = settings.buttonTitle != null ? String(settings.buttonTitle) : fallback;
  vsd.setImage(context, buildButtonSvg(settings.iconColor, label, settings.iconGlyph || 'star'));
  vsd.setTitle(context, '');
}

module.exports = {
  actionUUID: 'com.vsd.craft.heos.preset',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }
    const pid = heosClient.playerId;
    if (pid == null) { vsd.showAlert(message.context); return; }

    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;

    if (presetNumber < 1) {
      vsd.showAlert(message.context);
      return;
    }

    heosClient.enqueue(`heos://browse/play_preset?pid=${pid}&preset=${presetNumber}`)
      .then(() => vsd.showOk(message.context))
      .catch((err) => {
        if (err.message && err.message.includes('HEOS error 8')) {
          console.warn('[HEOS-Client] Preset requires HEOS account sign-in');
        }
        vsd.showAlert(message.context);
      });
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
