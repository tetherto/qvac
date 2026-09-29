"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const packageDir = join(__dirname, "../..");
const addonSource = readFileSync(join(packageDir, "index.js"), "utf8");

// Runs the generated index.js against a stubbed native binding. Tests that do
// not exercise RDMA get a TCP-only backend by default.
function loadAddon(binding, resolveBackendsDir = () => packageDir) {
  const module = { exports: {} };
  const warnings = [];
  vm.runInNewContext(
    `${addonSource}\nmodule.exports.activeHandleCount = () => activeServerHandles.size;`,
    {
      __dirname: packageDir,
      console: { ...console, warn: (message) => warnings.push(message) },
      exports: module.exports,
      module,
      require(name) {
        if (name === "bare-net") return require("node:net");
        if (name === "bare-path") return require("node:path");
        if (name === "@qvac/fabric/backends") {
          return { resolveBackendsDir };
        }
        if (name === "./binding") {
          return { rpcBackendSupportsRdma: () => false, ...binding };
        }
        throw new Error(`Unexpected mobile require: ${name}`);
      },
    },
  );
  module.exports.warnings = warnings;
  return module.exports;
}

module.exports = { loadAddon, packageDir };
