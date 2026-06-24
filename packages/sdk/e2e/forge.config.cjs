"use strict";

const fs = require("node:fs");
const path = require("node:path");
const QvacForgePlugin = require("@qvac/sdk/electron-forge");

const projectDir = __dirname;
const electronConfigPath = path.join(projectDir, "fixtures", "qvac.config.electron.json");
const runtimeConfigPath = path.join(projectDir, "qvac.config.json");

function ensureRuntimeConfig() {
  fs.copyFileSync(electronConfigPath, runtimeConfigPath);
}

ensureRuntimeConfig();

module.exports = {
  packagerConfig: {
    name: "QVACSDKElectronE2E",
    asar: false,
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new QvacForgePlugin({
      projectDir,
      configPath: electronConfigPath,
      logLevel: "debug",
    }),
  ],
};
