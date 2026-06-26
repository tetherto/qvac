"use strict";

const fs = require("node:fs");
const path = require("node:path");
const QvacForgePlugin = require("@qvac/sdk/electron-forge");

const projectDir = __dirname;
const electronConfigPath = path.join(projectDir, "fixtures", "qvac.config.electron.json");
const runtimeConfigPath = path.join(projectDir, "qvac.config.json");
const generatedWorkerDir = path.join(projectDir, "qvac");

function ensureRuntimeConfig() {
  fs.copyFileSync(electronConfigPath, runtimeConfigPath);
}

function cleanupSourceArtifacts() {
  fs.rmSync(generatedWorkerDir, { recursive: true, force: true });
  fs.rmSync(runtimeConfigPath, { force: true });
}

ensureRuntimeConfig();

module.exports = {
  packagerConfig: {
    name: "QVACSDKElectronE2E",
    asar: false,
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    postPackage: async () => {
      cleanupSourceArtifacts();
    },
  },
  plugins: [
    new QvacForgePlugin({
      projectDir,
      configPath: electronConfigPath,
      logLevel: "debug",
    }),
  ],
};
