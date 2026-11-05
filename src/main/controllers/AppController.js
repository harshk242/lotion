const { app, BrowserWindow } = require('electron');
const log = require('electron-log/main').scope('AppController');
const Store = require('electron-store');
const { addWindow } = require('../store/slices/windowsSlice'); // Import addWindow
const WindowController = require('./WindowController'); // Import WindowController
const TabManager = require('../managers/TabManager'); // Import TabManager
const { randomUUID } = require('crypto');

const SESSION_KEY = 'sessionTabs';

let instance = null; // For singleton pattern

class AppController {
  constructor(store) {
    this.store = store;
    this.electronApp = app;
    this.windowControllers = new Map(); // Map of windowId to WindowController instance
    this.tabManager = null; // TabManager singleton instance
    this.isQuitting = false;
    this.prefs = null; // electron-store instance, created on first use
    this.lastSavedSessionJSON = null; // last session snapshot written to disk
    // this.createWindowCallback = null; // No longer needed from index.js

    if (!instance) {
      instance = this;
    }
    log.info('AppController initialized');
    return instance;
  }

  static getInstance() {
    return instance;
  }

  getPrefs() {
    if (!this.prefs) this.prefs = new Store();
    return this.prefs;
  }

  init(/*{ createWindowCallback }*/) { // createWindowCallback no longer needed
    log.info('Initializing app event handlers in AppController');
    // this.createWindowCallback = createWindowCallback; // Removed

    // Initialize TabManager singleton
    this.tabManager = new TabManager(this.store);
    log.info('TabManager initialized');

    this.electronApp.whenReady().then(() => {
      log.info('Electron app is ready via AppController');

      // Parse command line arguments for Notion URL
      const args = process.argv;
      let initialUrl = null;
      // Find any argument that is a Notion URL
      for (const arg of args) {
        if (arg &&
            (arg.startsWith('http://') || arg.startsWith('https://')) &&
            arg.includes('notion.so')) {
          initialUrl = arg;
          log.info(`Found Notion URL: ${initialUrl}`);
          break;
        }
      }

      // If no CLI URL was passed and session restore is enabled, try to
      // restore the previous session. If that succeeds, skip the default
      // new-window creation.
      if (!initialUrl && this.tryRestoreSession()) {
        return;
      }

      const options = initialUrl ? { initialUrl } : {};
      this.createNewWindow(options);
    });

    this.electronApp.on('window-all-closed', () => {
      log.info('All windows closed according to Electron event');
      // Note: This event might fire even if AppController still has tracked windows if they weren't closed properly.
      // The actual quitting logic should rely on whether windowControllers map is empty for non-darwin.
      if (process.platform !== 'darwin') {
         if (this.windowControllers.size === 0) {
            log.info('No active windows remaining, quitting app.');
            this.electronApp.quit();
         } else {
            log.warn('window-all-closed fired, but windowControllers map is not empty. This might indicate an issue.');
         }
      }
    });

    this.electronApp.on('activate', () => {
      log.info('App activated');
      if (this.windowControllers.size === 0) {
        this.createNewWindow();
      }
    });

    this.electronApp.on('before-quit', () => {
      log.info('App before-quit event triggered in AppController');
      this.saveTabState();
      this.isQuitting = true;
    });

    // Keep the on-disk session snapshot in sync with live state.
    // We do this here (rather than at before-quit) because clicking
    // the window's close button fires window-closed BEFORE before-quit,
    // which wipes our Redux state and empties windowControllers — so by
    // the time before-quit ran there was nothing left to save.
    this.installSessionAutoSave();
  }

  /**
   * Build a snapshot of the current window/tab state suitable for
   * persistence. Returns null when there's nothing meaningful to save
   * (no live windows with tabs) — callers should treat that as "keep
   * whatever was already on disk" rather than as "save an empty state."
   */
  buildSessionSnapshot() {
    const state = this.store.getState();
    const windowsState = state.windows.windows || {};
    const tabsState = state.tabs.tabs || {};

    const windows = [];
    for (const windowController of this.windowControllers.values()) {
      const w = windowsState[windowController.windowId];
      if (!w || !w.tabIds || w.tabIds.length === 0) continue;

      // Title and favicon let restored background tabs show their real
      // label in the tab bar before they are loaded.
      const tabs = w.tabIds
        .map((tabId) => tabsState[tabId])
        .filter((t) => t && t.url)
        .map((t) => {
          const tab = { url: t.url, isPinned: !!t.isPinned };
          if (t.title) tab.title = t.title;
          if (t.favicon && t.favicon.length <= 4096) tab.favicon = t.favicon;
          return tab;
        });

      if (tabs.length === 0) continue;

      const activeIdx = w.activeTabId ? w.tabIds.indexOf(w.activeTabId) : 0;
      windows.push({
        tabs,
        activeTabIndex: activeIdx >= 0 ? activeIdx : 0,
      });
    }

    return windows.length > 0 ? { savedAt: new Date().toISOString(), windows } : null;
  }

  /**
   * Subscribe to Redux state changes and write a debounced snapshot of
   * the current session to electron-store. Only writes non-empty
   * snapshots, so closing the last window leaves the previous good
   * snapshot in place for restoration on next launch.
   */
  installSessionAutoSave() {
    let timer = null;
    const SAVE_DEBOUNCE_MS = 800;

    const persistNow = () => {
      if (!this.isQuitting) this.saveTabState();
    };

    this.store.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
    });
  }

  /**
   * Attempt to restore the previous session. Returns true iff at least
   * one window was created from saved state (caller should then skip
   * its default first-window creation).
   */
  tryRestoreSession() {
    const store = this.getPrefs();
    const legacyTabs = store.get('savedTabs', []);
    if (!store.has(SESSION_KEY) && Array.isArray(legacyTabs) && legacyTabs.length > 0) {
      const tabs = legacyTabs.filter((tab) => tab && tab.url)
        .map((tab) => (tab.title
          ? { url: tab.url, isPinned: !!tab.isPinned, title: tab.title }
          : { url: tab.url, isPinned: !!tab.isPinned }));
      if (tabs.length > 0) {
        store.set(SESSION_KEY, {
          savedAt: new Date().toISOString(),
          windows: [{ tabs, activeTabIndex: 0 }],
        });
        if (!store.has('restoreTabsOnStartup')) store.set('restoreTabsOnStartup', true);
      }
    }
    if (!store.get('restoreTabsOnStartup', true)) {
      return false;
    }

    const saved = store.get(SESSION_KEY);
    if (!saved || !Array.isArray(saved.windows) || saved.windows.length === 0) {
      return false;
    }

    log.info(`Restoring session: ${saved.windows.length} window(s) saved at ${saved.savedAt}`);
    let restoredAny = false;

    const { setTabPinned } = require('../store/slices/tabsSlice');
    const { reorderTabsInWindow } = require('../store/slices/windowsSlice');

    for (const w of saved.windows) {
      if (!w.tabs || w.tabs.length === 0) continue;

      // Only the tab the user will see is loaded right away. It becomes
      // the window's initial tab; the others are created deferred (with
      // their saved title/favicon) and loaded one at a time in the
      // background once it has finished loading — see
      // WindowController#loadDeferredTabsInBackground.
      const activeIdx = Math.min(Math.max(w.activeTabIndex || 0, 0), w.tabs.length - 1);
      const activeTab = w.tabs[activeIdx];
      const windowController = this.createNewWindow({ initialUrl: activeTab.url });
      const activeTabController = windowController.getActiveTabController();

      if (activeTab.isPinned && activeTabController) {
        this.store.dispatch(setTabPinned({ tabId: activeTabController.tabId, isPinned: true }));
      }

      const orderedTabIds = [];
      for (let i = 0; i < w.tabs.length; i++) {
        if (i === activeIdx) {
          orderedTabIds.push(activeTabController?.tabId);
          continue;
        }
        const t = w.tabs[i];
        const tabController = this.tabManager.createTab({
          windowId: windowController.windowId,
          url: t.url,
          title: t.title || undefined,
          favicon: t.favicon || undefined,
          isPinned: !!t.isPinned,
          makeActive: false,
          deferLoad: true,
        });
        orderedTabIds.push(tabController.tabId);
      }

      // Tabs before the active one were appended after it; put them back
      // in their saved order.
      if (activeIdx > 0 && orderedTabIds.every(Boolean)) {
        this.store.dispatch(reorderTabsInWindow({ windowId: windowController.windowId, tabIds: orderedTabIds }));
      }

      if (typeof windowController.loadDeferredTabsInBackground === 'function') {
        windowController.loadDeferredTabsInBackground();
      }

      restoredAny = true;
    }

    return restoredAny;
  }

  createNewWindow(options = {}) {
    const windowId = options.windowId || randomUUID();
    log.info(`AppController: creating new window with id: ${windowId}`, options);

    if (this.windowControllers.has(windowId)) {
      log.warn(`Window with id ${windowId} already exists. Focusing existing window.`);
      this.windowControllers.get(windowId).focus();
      return this.windowControllers.get(windowId);
    }

    const windowController = new WindowController({
      windowId,
      store: this.store,
      ...options, // Pass through any other options like initialUrl, title, bounds
    });

    this.windowControllers.set(windowId, windowController);
    windowController.init(); // This creates the BrowserWindow and dispatches addWindow

    log.info(`WindowController for ${windowId} created and initialized. Total windows: ${this.windowControllers.size}`);
    return windowController;
  }

  handleWindowClosed(windowId) {
    log.info(`AppController handling closed window: ${windowId}`);
    if (this.windowControllers.has(windowId)) {
      this.windowControllers.delete(windowId);
      log.info(`WindowController for ${windowId} removed. Remaining windows: ${this.windowControllers.size}`);
    } else {
      log.warn(`Attempted to handle close for non-existent windowId: ${windowId}`);
    }

    // If on non-darwin and it was the last window, quit the app
    if (process.platform !== 'darwin' && this.windowControllers.size === 0 && !this.isQuitting) {
        log.info('Last window closed on non-darwin platform, quitting application.');
        this.electronApp.quit();
    }
  }

  requestQuit() {
    log.info('Quit requested via AppController');
    this.isQuitting = true;
    // Optionally, tell all window controllers to clean up or save state
    // for (const wc of this.windowControllers.values()) { wc.prepareForQuit(); }
    this.electronApp.quit();
  }

  getFocusedWindowController() {
    const focusedWindowId = this.store.getState().windows.focusedWindowId;
    if (focusedWindowId) {
      return this.windowControllers.get(focusedWindowId) || null;
    }
    // Fallback if no windowId in store, or if a window is focused but not yet in map (race condition on init)
    // This part is tricky without fully relying on Redux state for focus source of truth.
    // For now, let's assume Redux is the source of truth for focusedWindowId
    return null;
  }

  /**
   * Save current tab state to electron-store for persistence across restarts
   */
  saveTabState() {
    try {
      const store = this.getPrefs();
      if (!store.get('restoreTabsOnStartup', true)) return;
      const snapshot = this.buildSessionSnapshot();
      if (!snapshot) return;
      // The debounced auto-save fires after any state change (window
      // moves, focus, loading flags). Skip the synchronous config.json
      // rewrite when the saved tabs haven't actually changed.
      const json = JSON.stringify(snapshot.windows);
      if (json === this.lastSavedSessionJSON) return;
      store.set(SESSION_KEY, snapshot);
      this.lastSavedSessionJSON = json;
    } catch (error) {
      log.error('Failed to save session:', error);
    }
  }

  // getMainWindowInstance() { // This was a temporary hack and should be removed
  //   const allWindows = BrowserWindow.getAllWindows();
  //   return allWindows.length > 0 ? allWindows[0] : null;
  // }
}

module.exports = AppController;
