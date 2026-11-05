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
  restoreTabsOnStartup: true,
  useNativeWindowFrame: false,
};

// Set once the restoreTabsOnStartup default has been switched back on.
const RESTORE_DEFAULT_MIGRATION_KEY = 'restoreTabsDefaultMigrated';

let instance = null;

/**
 * Builds based on upstream v1.6.0 defaulted restoreTabsOnStartup to false,
 * and electron-store writes defaults into config.json, so a stored `false`
 * was never a user choice. It silently turned off the fork's always-on tab
 * restore. Turn it back on once; after that the menu toggle is respected.
 */
function migrateRestoreTabsDefault(store) {
  if (store.get(RESTORE_DEFAULT_MIGRATION_KEY, false)) return;
  store.set('restoreTabsOnStartup', true);
  store.set(RESTORE_DEFAULT_MIGRATION_KEY, true);
}

function getPreferences() {
  if (!instance) {
    instance = new Store({ defaults: PREFERENCE_DEFAULTS });
    migrateRestoreTabsDefault(instance);
  }
  return instance;
}

module.exports = { getPreferences, migrateRestoreTabsDefault, PREFERENCE_DEFAULTS };
