"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const packageDir = join(__dirname, "../..");
const mobileSource = readFileSync(join(packageDir, "mobile.js"), "utf8");

function loadMobile(binding) {
  const module = { exports: {} };
  vm.runInNewContext(
    `${mobileSource}\nmodule.exports.activeHandleCount = () => activeServerHandles.size;`,
    {
      __dirname: packageDir,
      console,
      exports: module.exports,
      module,
      require(name) {
        if (name === "bare-net") return {};
        if (name === "bare-path") return { join };
        if (name === "./binding") return binding;
        throw new Error(`Unexpected mobile require: ${name}`);
      },
    },
  );
  return module.exports;
}

test("mobile server handle stays pinned until asynchronous stop completes", async () => {
  let finishStop;
  const stopPending = new Promise((resolve) => {
    finishStop = resolve;
  });
  let stopCalls = 0;
  const mobile = loadMobile({
    startServer: () => Promise.resolve({}),
    stopServer: () => {
      stopCalls++;
      return stopPending;
    },
  });
  let server = await mobile.startRpcServer({ port: 50052 });
  assert.equal(mobile.activeHandleCount(), 1);

  const firstStop = server.stop();
  assert.strictEqual(server.stop(), firstStop);
  server = undefined;
  assert.equal(mobile.activeHandleCount(), 1);
  assert.equal(stopCalls, 1);

  finishStop();
  await firstStop;
  assert.equal(mobile.activeHandleCount(), 0);
});

test("mobile server handle stays pinned if stop fails and can be retried", async () => {
  let stopCalls = 0;
  const mobile = loadMobile({
    startServer: () => Promise.resolve({}),
    stopServer: () => {
      stopCalls++;
      return stopCalls === 1
        ? Promise.reject(new Error("stop failed"))
        : Promise.resolve();
    },
  });
  const server = await mobile.startRpcServer({ port: 50052 });

  await assert.rejects(server.stop(), /stop failed/);
  assert.equal(mobile.activeHandleCount(), 1);
  await server.stop();
  assert.equal(stopCalls, 2);
  assert.equal(mobile.activeHandleCount(), 0);
});

test("mobile startup awaits the native result without blocking JS work", async () => {
  let finishStart;
  const startPending = new Promise((resolve) => {
    finishStart = resolve;
  });
  const mobile = loadMobile({
    startServer: () => startPending,
    stopServer: () => Promise.resolve(),
  });

  const starting = mobile.startRpcServer({ port: 50052 });
  await Promise.resolve();
  assert.equal(mobile.activeHandleCount(), 0);

  finishStart({});
  const server = await starting;
  assert.equal(mobile.activeHandleCount(), 1);
  await server.stop();
  assert.equal(mobile.activeHandleCount(), 0);
});
