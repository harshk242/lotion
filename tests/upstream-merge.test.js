const { test, expect } = require('bun:test');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function sessionHarness(values = {}) {
  const data = structuredClone(values);
  const state = { windows: { windows: {} }, tabs: { tabs: {} } };
  const Store = class {
    get(key, fallback) { return key in data ? data[key] : fallback; }
    has(key) { return key in data; }
    set(key, value) { data[key] = value; }
  };
  const logger = new Proxy({}, { get: () => () => {} });
  const sandbox = {
    module: { exports: {} }, process, setTimeout, clearTimeout,
    require: (name) => {
      if (name === 'electron') return { app: {} };
      if (name === 'electron-store') return Store;
      if (name === 'electron-log') return { scope: () => logger };
      if (name === '../store/slices/tabsSlice') return require('../src/main/store/slices/tabsSlice');
      if (name === 'uuid') return { v4: () => 'window' };
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/controllers/AppController.js'), 'utf8'), sandbox);
  const controller = new sandbox.module.exports({
    getState: () => state,
    dispatch: (action) => {
      const { tabsReducer } = require('../src/main/store/slices/tabsSlice');
      state.tabs = tabsReducer(state.tabs, action);
    },
  });
  return { controller, data, state };
}

test('migrates saved fork tabs and retains automatic restoration', () => {
  const { controller, data } = sessionHarness({ savedTabs: [{ url: 'https://www.notion.so/page' }] });
  const created = [];
  controller.createNewWindow = (options) => { created.push(options); return {}; };
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


test('restores pinned first tabs, additional tabs and the selected tab in each window', () => {
  const { controller, state } = sessionHarness({
    restoreTabsOnStartup: true,
    sessionTabs: { windows: [
      { tabs: [{ url: 'https://www.notion.so/one', isPinned: true }, { url: 'https://www.notion.so/two' }], activeTabIndex: 1 },
      { tabs: [{ url: 'https://www.notion.so/three' }], activeTabIndex: 0 },
    ] },
  });
  const { createTab } = require('../src/main/store/slices/tabsSlice');
  let nextTab = 0;
  controller.tabManager = { createTab(options) {
    const tabId = `tab-${++nextTab}`;
    controller.store.dispatch(createTab({ tabId, ...options }));
    state.windows.windows[options.windowId].tabIds.push(tabId);
    return { tabId };
  } };
  const selections = [];
  controller.createNewWindow = ({ initialUrl }) => {
    const windowId = `window-${controller.windowControllers.size}`;
    state.windows.windows[windowId] = { tabIds: [] };
    const first = controller.tabManager.createTab({ windowId, url: initialUrl });
    const window = { windowId, getActiveTabController: () => first, switchToTab: (tabId) => selections.push(tabId) };
    controller.windowControllers.set(windowId, window);
    return window;
  };
  expect(controller.tryRestoreSession()).toBe(true);
  expect(controller.windowControllers.size).toBe(2);
  expect(state.tabs.tabs['tab-1'].isPinned).toBe(true);
  expect(state.tabs.tabs['tab-2'].url).toBe('https://www.notion.so/two');
  expect(state.tabs.tabs['tab-3'].url).toBe('https://www.notion.so/three');
  expect(selections).toEqual(['tab-2']);
});
