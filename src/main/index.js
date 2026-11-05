// This file serves as the entry point for the main process
// Simple Notion desktop app for Linux

const { app, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const log = require('electron-log/main');

// Debug-level logging (window move/resize, every navigation, view bounds)
// is written synchronously to main.log and the console on the main
// thread. Keep it for development; packaged builds log info and above.
// Override with LOTION_LOG_LEVEL=debug when diagnosing an installed build.
{
  const logLevel = process.env.LOTION_LOG_LEVEL || (app.isPackaged ? 'info' : 'silly');
  log.transports.file.level = logLevel;
  log.transports.console.level = logLevel;
}

// Set custom user data path for development to avoid conflicts
if (process.env.NODE_ENV === 'development') {
  const devUserDataPath = path.join(app.getPath('userData'), '-dev-data');
  app.setPath('userData', devUserDataPath);
  log.info(`Development mode: User data path set to ${devUserDataPath}`);
}

// --- Single Instance Lock --- //
// IMPORTANT: Request single instance lock BEFORE any other initialization
// Use single instance lock to handle multiple windows via second-instance events
// When user runs 'lotion' again, create a new window in the existing process
const gotTheLock = app.requestSingleInstanceLock();
log.info(`Requesting single instance lock... Got lock: ${gotTheLock}`);

if (!gotTheLock) {
  log.info('Another instance of Lotion is already running. Quitting this instance.');
  app.quit();
  // Exit immediately - don't initialize anything else
  process.exit(0);
} else {
  log.info('Single instance lock acquired successfully');
}

// Load the rest of the app only once we know this process will keep
// running — a second `lotion` launch exits above without paying for it.
const { getPreferences } = require('./preferences');
const reduxStore = require('./store/store');
const AppController = require('./controllers/AppController');
const { getSpellCheckMenu } = require('./spellCheckMenu');
const config = require('../../config/config.json');

// Shared store for user preferences (menu bar visibility, theme, etc.)
const localStore = getPreferences();

// --- Initialize spell check dictionaries in Redux from electron-store before anything else ---
const spellCheckDictionaries = localStore.get('spellCheckDictionaries', ['en-US']);
reduxStore.dispatch({ type: 'app/setDictionaries', payload: spellCheckDictionaries });

// Restore prefers-color-scheme override from the saved theme before any
// BrowserWindow is created — otherwise Notion launches in its system
// mode and our --c-* overrides land on the wrong base palette until
// the user picks a theme again. Mode mapping mirrors the themes[]
// array in show-logo-menu; light-mode themes set 'light', dark-mode
// themes set 'dark', and Default leaves it as 'system'.
{
  const savedTheme = localStore.get('theme', 'default');
  const lightThemes = new Set(['catppuccin-latte', 'sakura']);
  const isExplicitlyLight = lightThemes.has(savedTheme);
  const isExplicitlyDark = savedTheme !== 'default' && !isExplicitlyLight;
  const { nativeTheme } = require('electron');
  nativeTheme.themeSource = isExplicitlyLight ? 'light' : (isExplicitlyDark ? 'dark' : 'system');
}

// Instantiate AppController (singleton)
const appController = new AppController(reduxStore);

// Handle second-instance event (must be set up after appController is created)
// This fires when someone tries to run 'lotion' again
// We create a NEW WINDOW instead of focusing existing one
app.on('second-instance', (event, commandLine, workingDirectory) => {
  log.info('Second instance detected, creating new window');

  // Find any argument that is a Notion URL
  let initialUrl = null;
  for (const arg of commandLine) {
    if (arg && 
        (arg.startsWith('http://') || arg.startsWith('https://')) && 
        arg.includes('notion.so')) {
      initialUrl = arg;
      log.info(`Found Notion URL: ${initialUrl}`);
      break;
    }
  }

  const options = initialUrl ? { initialUrl } : {};
  appController.createNewWindow(options);
});

appController.init(); // Initialize AppController event handlers

// --- Helper Functions --- //

// Toggle native-vs-custom window frame. The Electron `frame` option is
// fixed at BrowserWindow creation time, so we just persist the choice
// and tell the user to relaunch.
function toggleNativeWindowFrame(newValue) {
  localStore.set('useNativeWindowFrame', newValue);
  createNativeMenuWithNavigation(); // Keep the app menu checkbox in sync with the logo menu
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (!focusedWindow) return;
  dialog.showMessageBox(focusedWindow, {
    type: 'info',
    title: 'Restart Required',
    message: newValue ? 'Native window decorations enabled' : 'Custom (tabbed) window enabled',
    detail: newValue
      ? "Lotion will switch to native window decorations the next time you launch. The custom tab bar is replaced with single-window-per-tab behavior, and settings move to the standard menu bar."
      : "Lotion will switch back to the custom tab bar the next time you launch.",
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 0) {
      // Defer to next tick so the dialog has a chance to fully dismiss
      // before we begin shutdown. Using app.quit() (not app.exit()) so
      // BrowserWindows and WebContentsViews get torn down properly —
      // app.exit() bypasses cleanup and has been seen to leave orphan
      // renderer processes that have to be killed manually.
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
    }
  });
}

// Preferences dialog - This needs to be callable, perhaps via an IPC call handled by AppController
function showPreferencesDialog() {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (!focusedWindow) {
    log.warn('showPreferencesDialog: No focused window to show dialog against.');
    return;
  }

  const menuBarVisible = localStore.get('menuBarVisible', true);
  const autoHideMenuBar = localStore.get('autoHideMenuBar', false);

  const options = {
    type: 'info',
    title: 'Lotion Preferences',
    message: 'Menu Bar Settings',
    detail: `Current Settings:
• Menu Bar Visible: ${menuBarVisible ? 'Yes' : 'No'}
• Auto-Hide Menu Bar: ${autoHideMenuBar ? 'Yes' : 'No'}

Keyboard Shortcuts:
• Ctrl+Shift+M: Toggle Menu Bar Visibility
• Ctrl+Alt+M: Toggle Auto-Hide Menu Bar
• Alt: Show Menu Bar (when auto-hide is enabled)

Note: Changes are saved automatically when using the View menu or keyboard shortcuts.`,
    buttons: ['Close', 'Reset to Defaults'],
    defaultId: 0
  };

  dialog.showMessageBox(focusedWindow, options).then((result) => {
    if (result.response === 1) {
      localStore.set('menuBarVisible', true);
      localStore.set('autoHideMenuBar', false);
      if (focusedWindow) {
        focusedWindow.setMenuBarVisibility(true);
        focusedWindow.setAutoHideMenuBar(false);
      }
      createNativeMenuWithNavigation(); // Recreate menu to update labels
      dialog.showMessageBox(focusedWindow, {
        type: 'info',
        title: 'Preferences Reset',
        message: 'Menu bar preferences have been reset to defaults.'
      });
    }
  });
}

// Menu bar control functions - These should operate on the focused window
function toggleMenuBarVisibility() {
  const focusedWC = appController.getFocusedWindowController();
  const focusedWindow = focusedWC?.getInternalBrowserWindow();
  if (!focusedWindow) return;

  const isVisible = focusedWindow.isMenuBarVisible();
  const newVisibility = !isVisible;

  focusedWindow.setMenuBarVisibility(newVisibility);
  localStore.set('menuBarVisible', newVisibility);
  createNativeMenuWithNavigation(); // Recreate menu to update labels
}

function toggleAutoHideMenuBar() {
  const focusedWC = appController.getFocusedWindowController();
  const focusedWindow = focusedWC?.getInternalBrowserWindow();
  if (!focusedWindow) return;

  const autoHide = focusedWindow.isMenuBarAutoHide();
  const newAutoHide = !autoHide;

  focusedWindow.setAutoHideMenuBar(newAutoHide);
  localStore.set('autoHideMenuBar', newAutoHide);

  if (newAutoHide) {
    focusedWindow.setMenuBarVisibility(true);
    localStore.set('menuBarVisible', true);
  }
  createNativeMenuWithNavigation(); // Recreate menu to update labels
}

// Tab switching helper functions
function switchToNextTab() {
  const focusedWC = appController.getFocusedWindowController();
  if (!focusedWC || !focusedWC.currentActiveTabController) return;

  const state = reduxStore.getState();
  const windowState = state.windows.windows[focusedWC.windowId];
  if (!windowState || windowState.tabIds.length <= 1) return;

  const currentTabId = focusedWC.currentActiveTabController.tabId;
  const currentIndex = windowState.tabIds.indexOf(currentTabId);
  const nextIndex = (currentIndex + 1) % windowState.tabIds.length;
  const nextTabId = windowState.tabIds[nextIndex];

  focusedWC.switchToTab(nextTabId);
  notifyTabBarUpdate(focusedWC.windowId);
}

function switchToPreviousTab() {
  const focusedWC = appController.getFocusedWindowController();
  if (!focusedWC || !focusedWC.currentActiveTabController) return;

  const state = reduxStore.getState();
  const windowState = state.windows.windows[focusedWC.windowId];
  if (!windowState || windowState.tabIds.length <= 1) return;

  const currentTabId = focusedWC.currentActiveTabController.tabId;
  const currentIndex = windowState.tabIds.indexOf(currentTabId);
  const prevIndex = (currentIndex - 1 + windowState.tabIds.length) % windowState.tabIds.length;
  const prevTabId = windowState.tabIds[prevIndex];

  focusedWC.switchToTab(prevTabId);
  notifyTabBarUpdate(focusedWC.windowId);
}

function switchToTabByIndex(index) {
  const focusedWC = appController.getFocusedWindowController();
  if (!focusedWC) return;

  const state = reduxStore.getState();
  const windowState = state.windows.windows[focusedWC.windowId];
  if (!windowState || windowState.tabIds.length === 0) return;

  let targetIndex;
  if (index === -1) {
    // -1 means last tab (Ctrl+9 behavior)
    targetIndex = windowState.tabIds.length - 1;
  } else {
    targetIndex = index;
  }

  // Check if the tab exists at that index
  if (targetIndex >= 0 && targetIndex < windowState.tabIds.length) {
    const targetTabId = windowState.tabIds[targetIndex];
    focusedWC.switchToTab(targetTabId);
    notifyTabBarUpdate(focusedWC.windowId);
  }
}

// Create a native menu with navigation controls
function createNativeMenuWithNavigation() {
  const focusedWC = appController.getFocusedWindowController();
  const focusedWindow = focusedWC?.getInternalBrowserWindow();

  const template = [
    {
      label: 'Lotion',
      submenu: [
        {
          label: 'About Lotion',
          click: () => {
            if (focusedWindow) {
              dialog.showMessageBox(focusedWindow, {
                type: 'info',
                title: 'About Lotion',
                message: 'Lotion',
                detail: 'Unofficial Notion.so Desktop app for Linux\nVersion ' + app.getVersion()
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => { showPreferencesDialog(); }
        },
        {
          label: 'Use Native Window Decorations',
          type: 'checkbox',
          checked: localStore.get('useNativeWindowFrame', false),
          click: (menuItem) => toggleNativeWindowFrame(menuItem.checked),
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => { appController.requestQuit(); }
        }
      ]
    },
    {
      label: 'Navigation',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => { focusedWC?.getInternalBrowserWindow()?.webContents.goBack(); }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => { focusedWC?.getInternalBrowserWindow()?.webContents.goForward(); }
        },
        {
          label: 'Refresh',
          accelerator: 'CmdOrCtrl+R',
          click: () => { focusedWC?.getInternalBrowserWindow()?.webContents.reload(); }
        },
        { type: 'separator' },
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+H',
          click: () => { focusedWC?.loadURL(config.domainBaseUrl); }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectall' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const wc = focusedWC?.getActiveTabController()?.webContentsView?.webContents;
            if (wc) wc.setZoomLevel(0);
          }
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            const wc = focusedWC?.getActiveTabController()?.webContentsView?.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          }
        },
        {
          // Hidden alias so US-layout users pressing Ctrl + + (i.e. Ctrl+Shift+=) still trigger zoom in
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Shift+=',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => {
            const wc = focusedWC?.getActiveTabController()?.webContentsView?.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const wc = focusedWC?.getActiveTabController()?.webContentsView?.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5);
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: focusedWindow?.isMenuBarVisible() ? 'Hide Menu Bar' : 'Show Menu Bar',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: toggleMenuBarVisibility
        },
        {
          label: focusedWindow?.isMenuBarAutoHide() ? 'Disable Auto-Hide Menu Bar' : 'Enable Auto-Hide Menu Bar',
          accelerator: 'CmdOrCtrl+Alt+M',
          click: toggleAutoHideMenuBar
        },
        { type: 'separator' },
        {
          label: 'Toggle Menu Bar (Alt Key)',
          accelerator: 'Alt',
          click: () => {
            if (!focusedWindow) return;
            const isVisible = focusedWindow.isMenuBarVisible();
            const autoHide = focusedWindow.isMenuBarAutoHide();

            if (autoHide) {
              focusedWindow.setMenuBarVisibility(true);
            } else {
              toggleMenuBarVisibility();
            }
          }
        },
        { type: 'separator' },
        getSpellCheckMenu(appController)
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const focusedWC = appController.getFocusedWindowController();
            if (focusedWC) {
              const TabManager = require('./managers/TabManager');
              const tabManager = TabManager.getInstance();
              const tabController = tabManager.createTab({
                windowId: focusedWC.windowId,
                url: config.domainBaseUrl,
                title: 'New Tab',
                makeActive: true,
              });
              focusedWC.setActiveTab(tabController);
              notifyTabBarUpdate(focusedWC.windowId);
            }
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const focusedWC = appController.getFocusedWindowController();
            if (focusedWC && focusedWC.currentActiveTabController) {
              const tabId = focusedWC.currentActiveTabController.tabId;
              const TabManager = require('./managers/TabManager');
              const tabManager = TabManager.getInstance();
              const state = reduxStore.getState();
              const windowState = state.windows.windows[focusedWC.windowId];
              
              // Don't close if it's the last tab - close the window instead
              if (windowState && windowState.tabIds.length <= 1) {
                focusedWC.getInternalBrowserWindow()?.close();
                return;
              }
              
              // Find next tab to switch to before closing
              const currentIndex = windowState.tabIds.indexOf(tabId);
              const nextIndex = currentIndex > 0 ? currentIndex - 1 : 1;
              const nextTabId = windowState.tabIds[nextIndex];
              
              tabManager.destroyTab(tabId);
              focusedWC.switchToTab(nextTabId);
              notifyTabBarUpdate(focusedWC.windowId);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'CmdOrCtrl+Tab',
          click: () => { switchToNextTab(); }
        },
        {
          label: 'Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+Tab',
          click: () => { switchToPreviousTab(); }
        },
        { type: 'separator' },
        {
          label: 'Tab 1',
          accelerator: 'CmdOrCtrl+1',
          click: () => { switchToTabByIndex(0); }
        },
        {
          label: 'Tab 2',
          accelerator: 'CmdOrCtrl+2',
          click: () => { switchToTabByIndex(1); }
        },
        {
          label: 'Tab 3',
          accelerator: 'CmdOrCtrl+3',
          click: () => { switchToTabByIndex(2); }
        },
        {
          label: 'Tab 4',
          accelerator: 'CmdOrCtrl+4',
          click: () => { switchToTabByIndex(3); }
        },
        {
          label: 'Tab 5',
          accelerator: 'CmdOrCtrl+5',
          click: () => { switchToTabByIndex(4); }
        },
        {
          label: 'Tab 6',
          accelerator: 'CmdOrCtrl+6',
          click: () => { switchToTabByIndex(5); }
        },
        {
          label: 'Tab 7',
          accelerator: 'CmdOrCtrl+7',
          click: () => { switchToTabByIndex(6); }
        },
        {
          label: 'Tab 8',
          accelerator: 'CmdOrCtrl+8',
          click: () => { switchToTabByIndex(7); }
        },
        {
          label: 'Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => { switchToTabByIndex(-1); }
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            appController.createNewWindow();
          }
        },
        { type: 'separator' },
        { role: 'minimize' },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
            if (focusedWindow) {
              focusedWindow.close();
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// Handle certificate errors
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // For development, you might want to ignore certificate errors
  // In production, you should handle this properly
  if (process.env.NODE_ENV === 'development') {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// IPC handlers for communication with renderer process
ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// Window control handlers
ipcMain.handle('window-minimize', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow) {
    focusedWindow.minimize();
  }
});

ipcMain.handle('window-toggle-maximize', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow) {
    if (focusedWindow.isMaximized()) {
      focusedWindow.unmaximize();
    } else {
      focusedWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow) {
    focusedWindow.close();
  }
});

// Open external URL in default browser
ipcMain.handle('open-external', async (event, url) => {
  const { shell } = require('electron');
  await shell.openExternal(url);
  return { success: true };
});

// Open URL in new tab (Ctrl+Click feature)
ipcMain.handle('open-in-new-tab', async (event, url) => {
  const webContents = event.sender;
  
  // Find the window that contains this webContents
  let windowController = null;
  for (const wc of appController.windowControllers.values()) {
    // Check all tabs in this window
    const TabManager = require('./managers/TabManager');
    const tabManager = TabManager.getInstance();
    const tabs = tabManager.getTabsForWindow(wc.windowId);
    
    for (const tab of tabs) {
      if (tab.webContentsView && tab.webContentsView.webContents === webContents) {
        windowController = wc;
        break;
      }
    }
    if (windowController) break;
  }
  
  if (!windowController) {
    log.warn('open-in-new-tab: could not find parent window');
    return { success: false };
  }
  
  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();
  
  // Get current active tab ID to insert after it
  const currentActiveTabId = windowController.currentActiveTabController?.tabId;
  
  const tabController = tabManager.createTab({
    windowId: windowController.windowId,
    url: url,
    title: 'Loading...',
    makeActive: true,
    insertAfterTabId: currentActiveTabId,
  });
  
  // Switch to the new tab
  windowController.setActiveTab(tabController);
  
  // Notify tab bar of update
  notifyTabBarUpdate(windowController.windowId);
  
  return { success: true, tabId: tabController.tabId };
});

// Get current theme
ipcMain.handle('get-current-theme', () => {
  return localStore.get('theme', 'default');
});

// Show logo menu as native popup
ipcMain.handle('show-logo-menu', async (event) => {
  const { Menu, shell } = require('electron');
  const focusedWindowController = appController.getFocusedWindowController();

  if (!focusedWindowController) {
    return { success: false, error: 'No focused window' };
  }

  // Get current spell check setting
  const store = localStore;
  const spellCheckEnabled = store.get('spellCheckEnabled', true); // Default to enabled
  const currentTheme = store.get('theme', 'default'); // Default to Notion's default theme
  const restoreTabsOnStartup = store.get('restoreTabsOnStartup', false);

  // Theme switcher helper function
  const switchTheme = async (themeName) => {
    store.set('theme', themeName);
    console.log(`Switching theme to: ${themeName}`);

    // Match Notion's "use system setting" detection to the theme so
    // its prefers-color-scheme media queries flip appropriately.
    const themeMode = (themes.find((t) => t.id === themeName) || {}).mode || 'system';
    require('electron').nativeTheme.themeSource = themeMode;

    // Apply theme to all tabs in focused window
    if (focusedWindowController) {
      const windowId = focusedWindowController.windowId;
      const tabManager = require('./managers/TabManager').getInstance();

      // Notify tab bar about theme change
      if (focusedWindowController.tabBarView && focusedWindowController.tabBarView.webContents) {
        focusedWindowController.tabBarView.webContents.send('tab-bar:theme-changed', themeName);
        console.log(`Sent theme change to tab bar: ${themeName}`);
      }

      // Get all tabs and filter by window
      const allTabs = tabManager.getAllTabs();
      const tabs = allTabs.filter(tab => tab.windowId === windowId);

      console.log(`Found ${tabs.length} tabs to apply theme to`);

      for (const tabController of tabs) {
        // Reload the page to apply theme
        if (tabController.webContentsView && tabController.webContentsView.webContents) {
          tabController.webContentsView.webContents.reload();
        }
      }
    }
  };

  // Use `type: 'checkbox'` rather than 'radio' because Electron's
  // radio behavior in popup menus on Linux/GTK doesn't reliably
  // reset sibling state across menu instances — we ended up showing
  // multiple "checked" themes after the user picked several in a
  // row. Each menu open rebuilds the items fresh, so a single
  // `checked: true` (the current theme) renders correctly.
  // `mode` drives nativeTheme.themeSource so Notion's "use system
  // setting" auto-switches between its own light/dark mode to match
  // the theme intent — keeps our --c-* overrides applied to the right
  // base palette.
  const themes = [
    { id: 'default', label: 'Default', mode: 'system' },
    { id: 'dracula', label: 'Dracula', mode: 'dark' },
    { id: 'nord', label: 'Nord', mode: 'dark' },
    { id: 'gruvbox-dark', label: 'Gruvbox Dark', mode: 'dark' },
    { id: 'monokai', label: 'Monokai', mode: 'dark' },
    { id: 'noir', label: 'Noir', mode: 'dark' },
    { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', mode: 'dark' },
    { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato', mode: 'dark' },
    { id: 'catppuccin-frappe', label: 'Catppuccin Frappe', mode: 'dark' },
    { id: 'catppuccin-latte', label: 'Catppuccin Latte', mode: 'light' },
    { id: 'sakura', label: 'Sakura', mode: 'light' },
  ];

  const themeSubmenu = themes.map((t) => ({
    label: t.label,
    type: 'checkbox',
    checked: currentTheme === t.id,
    click: () => switchTheme(t.id),
  }));

  const applySpellCheckToTabs = (enabled) => {
    if (!focusedWindowController) return;
    const tabManager = require('./managers/TabManager').getInstance();
    const tabs = tabManager.getTabsForWindow(focusedWindowController.windowId);
    tabs.forEach((tabController) => {
      const wc = tabController.webContentsView?.webContents;
      if (wc) wc.session.setSpellCheckerEnabled(enabled);
    });
  };

  const menu = Menu.buildFromTemplate([
    {
      label: `Lotion v${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Spell Check',
      type: 'checkbox',
      checked: spellCheckEnabled,
      click: (menuItem) => {
        store.set('spellCheckEnabled', menuItem.checked);
        applySpellCheckToTabs(menuItem.checked);
      },
    },
    {
      label: 'Restore Tabs on Startup',
      type: 'checkbox',
      checked: restoreTabsOnStartup,
      click: (menuItem) => {
        store.set('restoreTabsOnStartup', menuItem.checked);
      },
    },
    {
      label: 'Use Native Window Decorations',
      type: 'checkbox',
      checked: localStore.get('useNativeWindowFrame', false),
      click: (menuItem) => toggleNativeWindowFrame(menuItem.checked),
    },
    { type: 'separator' },
    {
      label: 'Theme',
      submenu: themeSubmenu,
    },
    {
      label: 'Reload Custom CSS',
      click: async () => {
        if (!focusedWindowController) return;
        const tabManager = require('./managers/TabManager').getInstance();
        const tabs = tabManager.getTabsForWindow(focusedWindowController.windowId);
        for (const tabController of tabs) {
          await tabController.reloadCustomCSS();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'About Lotion',
      click: () => {
        dialog.showMessageBox(focusedWindowController.browserWindow, {
          type: 'info',
          title: 'About Lotion',
          message: `Lotion ${app.getVersion()}`,
          detail: 'Unofficial Notion.so desktop client.\n\nhttps://github.com/puneetsl/lotion',
          buttons: ['Close', 'Open GitHub'],
          defaultId: 0,
          cancelId: 0,
        }).then((result) => {
          if (result.response === 1) {
            shell.openExternal('https://github.com/puneetsl/lotion');
          }
        });
      },
    },
    {
      label: 'Help & GitHub',
      submenu: [
        {
          label: 'Star on GitHub',
          click: () => shell.openExternal('https://github.com/puneetsl/lotion'),
        },
        {
          label: 'Follow @puneetsl',
          click: () => shell.openExternal('https://github.com/puneetsl'),
        },
        { type: 'separator' },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/puneetsl/lotion/issues/new'),
        },
      ],
    },
  ]);

  // Popup the menu at the mouse cursor position
  menu.popup({
    window: focusedWindowController.browserWindow
  });

  return { success: true };
});

// Navigation handlers
ipcMain.handle('navigation-back', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow && focusedWindow.webContents.navigationHistory.canGoBack()) {
    focusedWindow.webContents.navigationHistory.goBack();
  }
});

ipcMain.handle('navigation-forward', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow && focusedWindow.webContents.navigationHistory.canGoForward()) {
    focusedWindow.webContents.navigationHistory.goForward();
  }
});

ipcMain.handle('navigation-refresh', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  if (focusedWindow) {
    focusedWindow.webContents.reload();
  }
});

// Menu bar control handlers
ipcMain.handle('menu-bar-toggle-visibility', () => {
  toggleMenuBarVisibility();
});

ipcMain.handle('menu-bar-toggle-auto-hide', () => {
  toggleAutoHideMenuBar();
});

ipcMain.handle('menu-bar-get-status', () => {
  const focusedWindow = appController.getFocusedWindowController()?.getInternalBrowserWindow();
  return {
    visible: focusedWindow ? focusedWindow.isMenuBarVisible() : true,
    autoHide: focusedWindow ? focusedWindow.isMenuBarAutoHide() : false
  };
});

ipcMain.handle('preferences-show', () => {
  showPreferencesDialog();
});

// --- Tab Bar IPC Handlers --- //

// Get initial tab state for tab bar renderer
ipcMain.handle('tab-bar:get-initial-state', (event) => {
  const webContents = event.sender;

  // Find which window this tab bar belongs to
  let windowController = null;
  for (const wc of appController.windowControllers.values()) {
    if (wc.tabBarView && wc.tabBarView.webContents === webContents) {
      windowController = wc;
      break;
    }
  }

  if (!windowController) {
    log.warn('Tab bar requested initial state but could not find parent window');
    return { tabs: [], activeTabId: null, windowId: null };
  }

  // The tab bar (re)loaded and starts from this snapshot; forget what was
  // last pushed so the next change is always delivered.
  lastTabBarSignature.delete(windowController.windowId);

  // Get tabs for this window from Redux state
  const state = reduxStore.getState();
  const windowState = state.windows.windows[windowController.windowId];

  if (!windowState) {
    return { tabs: [], activeTabId: null, windowId: windowController.windowId };
  }

  // Build tab list with details
  const tabs = windowState.tabIds.map((tabId) => {
    const tabState = state.tabs.tabs[tabId];
    return tabState || { tabId };
  });

  return {
    tabs,
    activeTabId: windowState.activeTabId,
    windowId: windowController.windowId,
  };
});

// Create new tab
ipcMain.handle('tab-bar:create-tab', async (event, options = {}) => {
  const webContents = event.sender;

  // Find parent window
  let windowController = null;
  for (const wc of appController.windowControllers.values()) {
    if (wc.tabBarView && wc.tabBarView.webContents === webContents) {
      windowController = wc;
      break;
    }
  }

  if (!windowController) {
    log.warn('Tab bar create-tab: could not find parent window');
    return { success: false };
  }

  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();

  const tabController = tabManager.createTab({
    windowId: windowController.windowId,
    url: options.url || config.domainBaseUrl,
    title: options.title || 'New Tab',
    makeActive: true,
  });

  // Switch to the new tab
  windowController.setActiveTab(tabController);

  // Notify tab bar of update
  notifyTabBarUpdate(windowController.windowId);

  return { success: true, tabId: tabController.tabId };
});

// Close tab
ipcMain.handle('tab-bar:close-tab', async (event, tabId) => {
  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();

  const tabController = tabManager.getTab(tabId);
  if (!tabController) {
    log.warn(`Cannot close tab ${tabId}: not found`);
    return { success: false };
  }

  const windowId = tabController.windowId;
  const windowController = appController.windowControllers.get(windowId);

  // Destroy the tab
  tabManager.destroyTab(tabId);

  // If this was the active tab, switch to another tab
  if (windowController && windowController.currentActiveTabController?.tabId === tabId) {
    const state = reduxStore.getState();
    const windowState = state.windows.windows[windowId];

    if (windowState && windowState.tabIds.length > 0) {
      // Switch to first available tab
      const nextTabId = windowState.tabIds[0];
      windowController.switchToTab(nextTabId);
    }
  }

  // Notify tab bar of update
  if (windowController) {
    notifyTabBarUpdate(windowId);
  }

  return { success: true };
});

// Switch to tab
ipcMain.handle('tab-bar:switch-tab', async (event, tabId) => {
  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();

  const tabController = tabManager.getTab(tabId);
  if (!tabController) {
    log.warn(`Cannot switch to tab ${tabId}: not found`);
    return { success: false };
  }

  const windowController = appController.windowControllers.get(tabController.windowId);
  if (windowController) {
    windowController.switchToTab(tabId);
    // Notify tab bar of the active tab change
    notifyTabBarUpdate(tabController.windowId);
    return { success: true };
  }

  return { success: false };
});

// Reorder tabs
ipcMain.handle('tab-bar:reorder-tabs', async (event, { windowId, tabIds }) => {
  const { reorderTabsInWindow } = require('./store/slices/windowsSlice');
  reduxStore.dispatch(reorderTabsInWindow({ windowId, tabIds }));

  notifyTabBarUpdate(windowId);
  return { success: true };
});

// Pin tab
ipcMain.handle('tab-bar:pin-tab', async (event, tabId) => {
  const { setTabPinned } = require('./store/slices/tabsSlice');
  reduxStore.dispatch(setTabPinned({ tabId, isPinned: true }));

  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();
  const tabController = tabManager.getTab(tabId);

  if (tabController) {
    notifyTabBarUpdate(tabController.windowId);
  }

  return { success: true };
});

// Navigate back in active tab
ipcMain.handle('tab-bar:navigate-back', async (event) => {
  const focusedWindowController = appController.getFocusedWindowController();
  if (focusedWindowController && focusedWindowController.currentActiveTabController) {
    const webContents = focusedWindowController.currentActiveTabController.webContentsView.webContents;
    if (webContents.canGoBack()) {
      webContents.goBack();
    }
  }
  return { success: true };
});

// Navigate forward in active tab
ipcMain.handle('tab-bar:navigate-forward', async (event) => {
  const focusedWindowController = appController.getFocusedWindowController();
  if (focusedWindowController && focusedWindowController.currentActiveTabController) {
    const webContents = focusedWindowController.currentActiveTabController.webContentsView.webContents;
    if (webContents.canGoForward()) {
      webContents.goForward();
    }
  }
  return { success: true };
});

// Refresh active tab
ipcMain.handle('tab-bar:refresh', async (event) => {
  const focusedWindowController = appController.getFocusedWindowController();
  if (focusedWindowController && focusedWindowController.currentActiveTabController) {
    const webContents = focusedWindowController.currentActiveTabController.webContentsView.webContents;
    webContents.reload();
  }
  return { success: true };
});

// Unpin tab
ipcMain.handle('tab-bar:unpin-tab', async (event, tabId) => {
  const { setTabPinned } = require('./store/slices/tabsSlice');
  reduxStore.dispatch(setTabPinned({ tabId, isPinned: false }));

  const TabManager = require('./managers/TabManager');
  const tabManager = TabManager.getInstance();
  const tabController = tabManager.getTab(tabId);

  if (tabController) {
    notifyTabBarUpdate(tabController.windowId);
  }

  return { success: true };
});

// Tab bar updates are coalesced: a single user action (new tab, close,
// navigation) dispatches several Redux actions, and each used to trigger
// its own IPC send + full tab bar re-render. Requests are batched into one
// flush per event-loop turn, and a window is only re-sent when something
// the tab bar actually renders has changed (order, title, favicon, pin
// state, active tab) — not on url/isLoaded/unusedSince churn.
const pendingTabBarWindowIds = new Set();
const lastTabBarSignature = new Map(); // windowId -> signature last sent
let tabBarFlushScheduled = false;

function notifyTabBarUpdate(windowId) {
  pendingTabBarWindowIds.add(windowId);
  if (tabBarFlushScheduled) return;
  tabBarFlushScheduled = true;
  setImmediate(flushTabBarUpdates);
}

function flushTabBarUpdates() {
  tabBarFlushScheduled = false;
  const windowIds = [...pendingTabBarWindowIds];
  pendingTabBarWindowIds.clear();
  const state = reduxStore.getState();

  for (const windowId of windowIds) {
    const windowController = appController.windowControllers.get(windowId);
    const windowState = state.windows.windows[windowId];
    if (!windowController || !windowState) {
      lastTabBarSignature.delete(windowId);
      continue;
    }
    const tabBarContents = windowController.tabBarView?.webContents;
    if (!tabBarContents || tabBarContents.isDestroyed()) continue;

    // Build tab list
    const tabs = windowState.tabIds.map((tabId) => {
      const tabState = state.tabs.tabs[tabId];
      return tabState || { tabId };
    });

    const signature = JSON.stringify([
      windowState.activeTabId,
      tabs.map((t) => [t.tabId, t.title, t.favicon, !!t.isPinned]),
    ]);
    if (lastTabBarSignature.get(windowId) === signature) continue;
    lastTabBarSignature.set(windowId, signature);

    // Send update to tab bar
    tabBarContents.send('tab-bar:tabs-updated', { tabs });

    // Send active tab update
    if (windowState.activeTabId) {
      tabBarContents.send('tab-bar:tab-activated', windowState.activeTabId);
    }
  }
}

// Add command line switches to potentially reduce graphics errors on Linux
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Subscribe to Redux state changes to update UI.
//
// This runs on every dispatch — including each window move/resize event
// and every in-page navigation — so it must stay cheap. Redux Toolkit
// state is immutable, so reference comparisons tell us exactly what
// changed without serializing the state.
let previousDictionaries = null;
let previousFocusedWindowId;
let previousTabsState = null;
let previousWindowTabs = new Map(); // windowId -> [tabIds, activeTabId]
reduxStore.subscribe(() => {
  const state = reduxStore.getState();

  // Rebuilding the native menu is expensive (it re-registers every
  // accelerator). Only do it when its inputs change: the spell check
  // dictionaries and the focused window (menu click handlers and the
  // menu bar labels are bound to the focused window).
  if (state.app.dictionaries !== previousDictionaries ||
      state.windows.focusedWindowId !== previousFocusedWindowId) {
    previousDictionaries = state.app.dictionaries;
    previousFocusedWindowId = state.windows.focusedWindowId;
    createNativeMenuWithNavigation();
  }

  // Notify tab bars when tab data (titles, favicons, etc.), tab order or
  // the active tab changes. The per-window activeTabId lives in
  // state.windows, not state.tabs, so it is watched separately or tab
  // clicks won't update the highlighted tab in the bar.
  const tabsChanged = state.tabs.tabs !== previousTabsState;
  previousTabsState = state.tabs.tabs;

  const windows = state.windows.windows || {};
  const currentWindowTabs = new Map();
  for (const [wid, w] of Object.entries(windows)) {
    const prev = previousWindowTabs.get(wid);
    currentWindowTabs.set(wid, [w.tabIds, w.activeTabId]);
    if (tabsChanged || !prev || prev[0] !== w.tabIds || prev[1] !== w.activeTabId) {
      notifyTabBarUpdate(wid);
    }
  }
  for (const wid of previousWindowTabs.keys()) {
    if (!currentWindowTabs.has(wid)) lastTabBarSignature.delete(wid);
  }
  previousWindowTabs = currentWindowTabs;
});
