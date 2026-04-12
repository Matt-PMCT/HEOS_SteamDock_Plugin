module.exports = {
  actionUUID: 'com.vsd.craft.heos.preset',

  onKeyDown(message, { heosClient, vsd }) {
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
          console.warn('[HEOS] Preset requires HEOS account sign-in');
        }
        vsd.showAlert(message.context);
      });
  },

  onWillAppear(message, { vsd }) {
    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;
    vsd.setTitle(message.context, `P${presetNumber}`);
  },

  onDidReceiveSettings(message, { vsd }) {
    const settings = message.payload.settings || {};
    const presetNumber = parseInt(settings.presetNumber, 10) || 1;
    vsd.setTitle(message.context, `P${presetNumber}`);
  }
};
