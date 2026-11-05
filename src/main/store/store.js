const { configureStore } = require('@reduxjs/toolkit');
const { appReducer } = require('./slices/appSlice');
const { windowsReducer } = require('./slices/windowsSlice');
const { tabsReducer } = require('./slices/tabsSlice');
const { tabSpacesReducer } = require('./slices/tabSpacesSlice');

// Root reducer with all slices
const rootReducer = {
  app: appReducer,
  windows: windowsReducer,
  tabs: tabsReducer,
  tabSpaces: tabSpacesReducer,
};

// Packaged Electron builds don't set NODE_ENV, so Redux Toolkit runs in
// development mode and its immutability/serializability checks deep-walk
// the whole state on every dispatch (each window move, navigation, title
// update). They are debugging aids only — enable them in development.
const isDevelopment = process.env.NODE_ENV === 'development';

const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) => getDefaultMiddleware({
    immutableCheck: isDevelopment,
    serializableCheck: isDevelopment,
  }),
  // Electron-specific middleware might be added later if needed,
  // for example, to forward actions from main to renderer or vice-versa.
});

// export default store; // Changed to CommonJS export
module.exports = store;
