"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const mobileDir = join(__dirname, "../mobile");

// Match the mobile test builder's local-require removal and per-file wrapper.
// The helper must survive that merge and the runner must return a counted test.
test("mobile test files merge into a runnable lifecycle probe", async () => {
  const files = [
    "integration-runtime.cjs",
    "rpc-protocol.cjs",
    "integration.auto.cjs",
  ];
  const merged = files
    .map((file) => {
      let source = readFileSync(join(mobileDir, file), "utf8").replace(
        /require\s*\(\s*['"]\.\/([\w-]+)(\.cjs)?['"]\s*\)\s*\n?/g,
        "",
      );
      const exportsAt = source.indexOf("module.exports");
      if (exportsAt !== -1) source = source.slice(0, exportsAt);
      const functions = [
        ...source.matchAll(/async\s+function\s+(\w+)\s*\(/g),
      ].map((match) => match[1]);
      return (
        "(() => {\n" +
        source +
        "\nObject.assign(globalThis, { " +
        functions.join(", ") +
        " });\n})();"
      );
    })
    .join("\n");

  let stopCount = 0;
  const sandbox = {
    console: { log() {}, error() {} },
    require(name) {
      if (name === "bare-net") return {};
      if (name === "@qvac/ggml-rpc-server") {
        return {
          startRpcServer: () =>
            Promise.resolve({
              runtime: "in-process",
              host: "127.0.0.1",
              port: 50052,
              url: "127.0.0.1:50052",
              stop: () => {
                stopCount += 1;
                return Promise.resolve();
              },
            }),
        };
      }
      throw new Error(`Unexpected bundled require: ${name}`);
    },
  };
  vm.runInNewContext(merged, sandbox);
  assert.equal(typeof sandbox.probeRpcServerProtocol, "function");
  assert.equal(typeof sandbox.runRpcServerLifecycle, "function");

  sandbox.probeRpcServerProtocol = () => Promise.resolve({ deviceCount: 1 });
  const result = await sandbox.runRpcServerLifecycle();
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.failed, 0);
  assert.equal(stopCount, 3);
});
