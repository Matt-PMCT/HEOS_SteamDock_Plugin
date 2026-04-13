module.exports = {
  actionUUID: 'com.vsd.craft.heos.grouppreset',

  onKeyDown(message, { heosClient, vsd }) {
    if (!heosClient.isConnected()) { vsd.showAlert(message.context); return; }

    const settings = message.payload.settings || {};
    const rawPids = settings.groupPids;
    if (!Array.isArray(rawPids) || rawPids.length === 0) {
      vsd.showAlert(message.context);
      return;
    }

    // Sanitize: ensure integers, remove NaN, deduplicate
    const seen = new Set();
    const groupPids = [];
    for (const p of rawPids) {
      const pid = parseInt(p, 10);
      if (!isNaN(pid) && !seen.has(pid)) {
        seen.add(pid);
        groupPids.push(pid);
      }
    }
    if (groupPids.length === 0) {
      vsd.showAlert(message.context);
      return;
    }

    // Filter out PIDs that no longer exist on the network
    const knownPids = new Set(heosClient.players.map(p => p.pid));
    const validPids = groupPids.filter(pid => knownPids.has(pid));
    if (validPids.length === 0) {
      console.warn('[HEOS-Plugin] Group preset: none of the configured players are available');
      vsd.showAlert(message.context);
      return;
    }
    // If user configured multiple speakers but only 1 is online, alert instead of
    // silently ungrouping (the degraded result wouldn't match expectations)
    if (groupPids.length > 1 && validPids.length < 2) {
      console.warn('[HEOS-Plugin] Group preset: not enough players online to form a group');
      vsd.showAlert(message.context);
      return;
    }
    if (validPids.length < groupPids.length) {
      console.warn('[HEOS-Plugin] Group preset: some configured players not found, using subset');
    }

    // Determine leader: use saved leaderPid if still valid, else first valid PID
    let leaderPid = parseInt(settings.leaderPid, 10);
    if (isNaN(leaderPid) || !validPids.includes(leaderPid)) {
      leaderPid = validPids[0];
    }

    // Build PID list with leader first
    const orderedPids = [leaderPid, ...validPids.filter(pid => pid !== leaderPid)];
    const pidList = orderedPids.join(',');

    heosClient.enqueue(`heos://group/set_group?pid=${pidList}`)
      .then(() => vsd.showOk(message.context))
      .catch((err) => {
        console.error('[HEOS-Plugin] Group preset failed:', err.message);
        vsd.showAlert(message.context);
      });
  },

  onWillAppear(message, { vsd }) {
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.groupLabel || 'Grp');
  },

  onDidReceiveSettings(message, { vsd }) {
    const settings = message.payload.settings || {};
    vsd.setTitle(message.context, settings.groupLabel || 'Grp');
  }
};
