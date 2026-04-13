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

    // Switch: update heosIp and playerId, which triggers reconnection.
    // showOk is optimistic -- the actual connection happens asynchronously.
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
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.profileLabel || 'Profile');
  },

  onDidReceiveSettings(message, { vsd }) {
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.profileLabel || 'Profile');
  }
};
