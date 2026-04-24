const { buildButtonSvg } = require('../button-render');
const { consumeButtonRefresh } = require('../button-refresh');

function renderButton(context, settings, vsd) {
  const label = settings.buttonTitle != null
    ? String(settings.buttonTitle)
    : (settings.profileLabel || 'Profile');
  vsd.setImage(context, buildButtonSvg(settings.iconColor, label, settings.iconGlyph || 'home'));
  vsd.setTitle(context, '');
}

module.exports = {
  actionUUID: 'com.vsd.craft.heos.profileswitch',

  onKeyDown(message, { vsd }) {
    const settings = message.payload.settings || {};
    const targetProfileId = settings.profileId;
    if (!targetProfileId) { vsd.showAlert(message.context); return; }

    const gs = vsd.getGlobalSettings();
    const profiles = gs.profiles || [];
    const profile = profiles.find(p => String(p.id) === String(targetProfileId));
    if (!profile) { vsd.showAlert(message.context); return; }

    vsd.setGlobalSettings({
      ...gs,
      activeProfileId: profile.id,
      heosIp: profile.ip,
      playerId: profile.playerId,
      _piError: null
    });

    vsd.showOk(message.context);
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
