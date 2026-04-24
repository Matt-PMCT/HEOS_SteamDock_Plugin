// Shared helper for the PI→plugin live-update workaround. VSD Craft doesn't
// reliably echo per-action `didReceiveSettings` to the plugin on PI writes,
// and `sendToPlugin` routing is similarly unreliable. So every trigger-style
// action relies on the PI piggy-backing on `setGlobalSettings` with a
// transient `_buttonRefresh` key:
//
//   _buttonRefresh: { action, context, settings, at }
//
// Each action's `onGlobalSettingsChange` calls `consumeButtonRefresh()` with
// its own actionUUID. We dedup by timestamp per-action so one bump doesn't
// retrigger the render on unrelated ticks.

const _lastSeenAt = new Map(); // actionUUID -> last `at`

function consumeButtonRefresh(actionUUID, contexts, vsd, renderFn) {
  const gs = vsd.getGlobalSettings();
  const refresh = gs && gs._buttonRefresh;
  if (!refresh || !refresh.at) return;
  if (refresh.action !== actionUUID) return;
  if (_lastSeenAt.get(actionUUID) === refresh.at) return;
  _lastSeenAt.set(actionUUID, refresh.at);
  if (!refresh.context || !contexts.includes(refresh.context)) return;
  renderFn(refresh.context, refresh.settings || {}, vsd);
}

module.exports = { consumeButtonRefresh };
