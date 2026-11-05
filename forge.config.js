const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const config = {
  "packagerConfig": {
    "name": "Lotion",
    "executableName": "lotion",
    "icon": "./assets/icon",
    "asar": true,
    "osxSign": {
      "identity": "-"
    }
  },
  "makers": [
    {
      "name": "@electron-forge/maker-zip",
      "platforms": [
        "linux",
        "darwin",
        "win32"
      ]
    },
    {
      "name": "@electron-forge/maker-deb",
      "platforms": [
        "linux"
      ],
      "config": {
        "options": {
          "maintainer": "Lotion Team",
          "homepage": "https://github.com/puneetsl/lotion",
          "description": "Unofficial Notion.so Desktop app for Linux",
          "icon": "./assets/icon.png",
          "categories": [
            "Office",
            "TextEditor"
          ]
        }
      }
    },
    {
      "name": "@electron-forge/maker-rpm",
      "platforms": [
        "linux"
      ],
      "config": {
        "options": {
          "license": "MIT",
          "homepage": "https://github.com/puneetsl/lotion",
          "description": "Unofficial Notion.so Desktop app for Linux",
          "icon": "./assets/icon.png"
        }
      }
    },
    {
      "name": "@electron-forge/maker-squirrel",
      "platforms": [
        "win32"
      ],
      "config": {
        "name": "lotion",
        "authors": "Lotion Team",
        "description": "Unofficial Notion.so Desktop app"
      }
    }
  ]
};

// Fuse keys must be FuseV1Options enum values; unknown keys are silently ignored.
config.plugins = [
  {
    name: '@electron-forge/plugin-fuses',
    config: {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    },
  },
];

module.exports = config;
