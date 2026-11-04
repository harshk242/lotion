// Shared electron-store instance for user preferences.
//
// Constructing a Store synchronously reads, parses and deep-compares
// config.json (and may rewrite it), so creating one per call site — per
// tab, per page load, per menu open — adds avoidable main-thread work.
// Store#get() re-reads the file on every call, so sharing one instance
// does not change what callers observe.
const Store = require('electron-store');

const PREFERENCE_DEFAULTS = {
  menuBarVisible: true,
  autoHideMenuBar: false,
  restoreTabsOnStartup: false,
  useNativeWindowFrame: false,
};

let instance = null;

function getPreferences() {
  if (!instance) {
    instance = new Store({ defaults: PREFERENCE_DEFAULTS });
  }
  return instance;
}

module.exports = { getPreferences, PREFERENCE_DEFAULTS };
