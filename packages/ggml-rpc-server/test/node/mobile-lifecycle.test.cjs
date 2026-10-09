"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadAddon } = require("./load-addon.cjs");

test("the server leaves backend discovery to @qvac/fabric", async () => {
  let receivedOptions;
  const addon = loadAddon({
    startServer: (options) => {
      receivedOptions = options;
      return Promise.resolve({});
    },
    stopServer: () => Promise.resolve(),
  });

  const server = await addon.startRpcServer({ port: 50052 });
  // A packed bundle has no package tree to compute a directory from; fabric
  // locates its backends natively, next to its runtime.
  assert.equal("backendsDir" in receivedOptions, false);
  await server.stop();
});

test("mobile server handle stays pinned until asynchronous stop completes", async () => {
  let finishStop;
  const stopPending = new Promise((resolve) => {
    finishStop = resolve;
  });
  let stopCalls = 0;
  const addon = loadAddon({
    startServer: () => Promise.resolve({}),
    stopServer: () => {
      stopCalls++;
      return stopPending;
    },
  });
  let server = await addon.startRpcServer({ port: 50052 });
  assert.equal(addon.activeHandleCount(), 1);

  const firstStop = server.stop();
  assert.strictEqual(server.stop(), firstStop);
  server = undefined;
  assert.equal(addon.activeHandleCount(), 1);
  assert.equal(stopCalls, 1);

  finishStop();
  await firstStop;
  assert.equal(addon.activeHandleCount(), 0);
});

test("mobile server handle stays pinned if stop fails and can be retried", async () => {
  let stopCalls = 0;
  const addon = loadAddon({
    startServer: () => Promise.resolve({}),
    stopServer: () => {
      stopCalls++;
      return stopCalls === 1
        ? Promise.reject(new Error("stop failed"))
        : Promise.resolve();
    },
  });
  const server = await addon.startRpcServer({ port: 50052 });

  await assert.rejects(server.stop(), /stop failed/);
  assert.equal(addon.activeHandleCount(), 1);
  await server.stop();
  assert.equal(stopCalls, 2);
  assert.equal(addon.activeHandleCount(), 0);
});

test("mobile startup awaits the native result without blocking JS work", async () => {
  let finishStart;
  const startPending = new Promise((resolve) => {
    finishStart = resolve;
  });
  const addon = loadAddon({
    startServer: () => startPending,
    stopServer: () => Promise.resolve(),
  });

  const starting = addon.startRpcServer({ port: 50052 });
  await Promise.resolve();
  assert.equal(addon.activeHandleCount(), 0);

  finishStart({});
  const server = await starting;
  assert.equal(addon.activeHandleCount(), 1);
  await server.stop();
  assert.equal(addon.activeHandleCount(), 0);
});
