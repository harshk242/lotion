const { test, expect } = require('bun:test');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function sessionHarness(values = {}) {
  const data = structuredClone(values);
  const state = { windows: { windows: {} }, tabs: { tabs: {} } };
  const writes = [];
  const Store = class {
    get(key, fallback) { return key in data ? data[key] : fallback; }
    has(key) { return key in data; }
    set(key, value) { writes.push(key); data[key] = value; }
  };
  const logger = new Proxy({}, { get: () => () => {} });
  const sandbox = {
    module: { exports: {} }, process, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'electron') return { app: {} };
      if (name === 'electron-store') return Store;
      if (name === 'electron-log/main') return { scope: () => logger };
      if (name === '../store/slices/tabsSlice') return require('../src/main/store/slices/tabsSlice');
      if (name === '../store/slices/windowsSlice') return require('../src/main/store/slices/windowsSlice');
      if (name === 'crypto') return { randomUUID: () => 'window' };
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/controllers/AppController.js'), 'utf8'), sandbox);
  const controller = new sandbox.module.exports({
    getState: () => state,
    dispatch: (action) => {
      const { tabsReducer } = require('../src/main/store/slices/tabsSlice');
      state.tabs = tabsReducer(state.tabs, action);
      if (action.type === 'windows/reorderTabsInWindow') {
        state.windows.windows[action.payload.windowId].tabIds = action.payload.tabIds;
      }
    },
  });
  return { controller, data, state, writes };
}

test('migrates saved fork tabs and retains automatic restoration', () => {
  const { controller, data } = sessionHarness({ savedTabs: [{ url: 'https://www.notion.so/page' }] });
  const created = [];
  controller.createNewWindow = (options) => {
    created.push(options);
    return { windowId: 'w', getActiveTabController: () => ({ tabId: 't' }) };
  };
  expect(controller.tryRestoreSession()).toBe(true);
  expect(data.restoreTabsOnStartup).toBe(true);
  expect(data.sessionTabs.windows[0].tabs[0].url).toBe('https://www.notion.so/page');
  expect(created).toEqual([{ initialUrl: 'https://www.notion.so/page' }]);
});

test('migration respects an explicit disabled restore preference', () => {
  const { controller, data } = sessionHarness({
    savedTabs: [{ url: 'https://www.notion.so/old' }], restoreTabsOnStartup: false,
  });
  expect(controller.tryRestoreSession()).toBe(false);
  expect(data.restoreTabsOnStartup).toBe(false);
});

test('new session data takes precedence over legacy saved tabs', () => {
  const sessionTabs = { windows: [{ tabs: [{ url: 'https://www.notion.so/new' }] }] };
  const { controller, data } = sessionHarness({
    savedTabs: [{ url: 'https://www.notion.so/old' }], sessionTabs, restoreTabsOnStartup: false,
  });
  expect(controller.tryRestoreSession()).toBe(false);
  expect(data.sessionTabs).toEqual(sessionTabs);
});

test('saves tab order, pinned state, active selection and multiple windows synchronously', () => {
  const { controller, data, state } = sessionHarness({ restoreTabsOnStartup: true });
  controller.windowControllers.set('one', { windowId: 'one' });
  controller.windowControllers.set('two', { windowId: 'two' });
  state.windows.windows = {
    one: { tabIds: ['b', 'a'], activeTabId: 'a' },
    two: { tabIds: ['c'], activeTabId: 'c' },
  };
  state.tabs.tabs = {
    a: { url: 'https://www.notion.so/a' },
    b: { url: 'https://www.notion.so/b', isPinned: true },
    c: { url: 'https://www.notion.so/c' },
  };
  controller.saveTabState();
  expect(data.sessionTabs.windows).toEqual([
    { tabs: [{ url: 'https://www.notion.so/b', isPinned: true }, { url: 'https://www.notion.so/a', isPinned: false }], activeTabIndex: 1 },
    { tabs: [{ url: 'https://www.notion.so/c', isPinned: false }], activeTabIndex: 0 },
  ]);
  const saved = structuredClone(data.sessionTabs);
  controller.windowControllers.clear();
  controller.saveTabState();
  expect(data.sessionTabs).toEqual(saved);
});

test('disabled session restore does not write session state', () => {
  const { controller, data } = sessionHarness({ restoreTabsOnStartup: false });
  controller.buildSessionSnapshot = () => ({ windows: [{ tabs: [{ url: 'changed' }] }] });
  controller.saveTabState();
  expect(data.sessionTabs).toBeUndefined();
});

test('tab reordering supports both directions and rejects invalid drops', () => {
  const sandbox = { document: { addEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/tab-bar/renderer.js'), 'utf8'), sandbox);
  vm.runInContext("tabs = ['a', 'b', 'c'].map(tabId => ({ tabId }))", sandbox);
  const reorder = (from, to, before) => sandbox.computeReorderedIds(from, to, before);
  expect(reorder('a', 'c', false)).toEqual(['b', 'c', 'a']);
  expect(reorder('c', 'a', true)).toEqual(['c', 'a', 'b']);
  expect(reorder('a', 'a', true)).toBeNull();
  expect(reorder('missing', 'a', true)).toBeNull();
});


test('restores tab order, pinned state and selection, loading only the selected tab up front', () => {
  const one = 'https://www.notion.so/one';
  const two = 'https://www.notion.so/two';
  const three = 'https://www.notion.so/three';
  const four = 'https://www.notion.so/four';
  const { controller, state } = sessionHarness({
    restoreTabsOnStartup: true,
    sessionTabs: { windows: [
      { tabs: [{ url: one, isPinned: true, title: 'One' }, { url: two }, { url: three, title: 'Three' }], activeTabIndex: 1 },
      { tabs: [{ url: four }], activeTabIndex: 0 },
    ] },
  });
  const { createTab } = require('../src/main/store/slices/tabsSlice');
  let nextTab = 0;
  const createdTabs = [];
  controller.tabManager = { createTab(options) {
    const tabId = `tab-${++nextTab}`;
    createdTabs.push({ tabId, ...options });
    controller.store.dispatch(createTab({ tabId, parentWindowId: options.windowId, ...options }));
    state.windows.windows[options.windowId].tabIds.push(tabId);
    return { tabId };
  } };
  const backgroundLoads = [];
  controller.createNewWindow = ({ initialUrl }) => {
    const windowId = `window-${controller.windowControllers.size}`;
    state.windows.windows[windowId] = { tabIds: [] };
    const first = controller.tabManager.createTab({ windowId, url: initialUrl });
    const window = {
      windowId,
      getActiveTabController: () => first,
      loadDeferredTabsInBackground: () => backgroundLoads.push(windowId),
    };
    controller.windowControllers.set(windowId, window);
    return window;
  };

  expect(controller.tryRestoreSession()).toBe(true);
  expect(controller.windowControllers.size).toBe(2);

  // Saved order is preserved even though the selected tab is created first.
  const urlsIn = (windowId) => state.windows.windows[windowId].tabIds.map((id) => state.tabs.tabs[id].url);
  expect(urlsIn('window-0')).toEqual([one, two, three]);
  expect(urlsIn('window-1')).toEqual([four]);

  // The selected tab is the window's initial (immediately loaded) tab.
  const byUrl = (url) => createdTabs.find((t) => t.url === url);
  expect(byUrl(two).deferLoad).toBeUndefined();
  expect(byUrl(four).deferLoad).toBeUndefined();

  // Other tabs are created in the background with deferred loading,
  // keeping their pinned state and saved title.
  expect(byUrl(one)).toMatchObject({ deferLoad: true, makeActive: false, isPinned: true, title: 'One' });
  expect(byUrl(three)).toMatchObject({ deferLoad: true, makeActive: false, isPinned: false, title: 'Three' });
  expect(state.tabs.tabs[byUrl(one).tabId].isPinned).toBe(true);

  expect(backgroundLoads).toEqual(['window-0', 'window-1']);
});

test('saves tab titles and skips rewriting an unchanged session', () => {
  const { controller, data, state, writes } = sessionHarness({ restoreTabsOnStartup: true });
  controller.windowControllers.set('one', { windowId: 'one' });
  state.windows.windows = { one: { tabIds: ['a'], activeTabId: 'a' } };
  state.tabs.tabs = { a: { url: 'https://www.notion.so/a', title: 'Page A' } };

  controller.saveTabState();
  expect(data.sessionTabs.windows[0].tabs).toEqual([{ url: 'https://www.notion.so/a', isPinned: false, title: 'Page A' }]);
  controller.saveTabState();
  controller.saveTabState();
  expect(writes.filter((k) => k === 'sessionTabs').length).toBe(1);

  state.tabs.tabs = { a: { url: 'https://www.notion.so/a', title: 'Renamed' } };
  controller.saveTabState();
  expect(writes.filter((k) => k === 'sessionTabs').length).toBe(2);
  expect(data.sessionTabs.windows[0].tabs[0].title).toBe('Renamed');
});
