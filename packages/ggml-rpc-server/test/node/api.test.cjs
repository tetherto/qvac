"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadAddon, packageDir } = require("./load-addon.cjs");

function recordingBinding(overrides = {}) {
  const calls = [];
  return {
    calls,
    binding: {
      startServer: (options) => {
        calls.push(options);
        return Promise.resolve({});
      },
      stopServer: () => Promise.resolve(),
      ...overrides,
    },
  };
}

test("rdmaCapable reports the installed backend's RDMA build", async () => {
  for (const capable of [false, true]) {
    let queriedDir;
    const { binding } = recordingBinding({
      rpcBackendSupportsRdma: ({ backendsDir }) => {
        queriedDir = backendsDir;
        return capable;
      },
    });
    const server = await loadAddon(binding).startRpcServer({ port: 50052 });
    assert.equal(server.rdmaCapable, capable);
    assert.equal(queriedDir, packageDir);
    await server.stop();
  }
});

test("the RDMA check reads the backend once per process", async () => {
  let checks = 0;
  const { binding } = recordingBinding({
    rpcBackendSupportsRdma: () => {
      checks++;
      return true;
    },
  });
  const addon = loadAddon(binding);
  for (const port of [50052, 50053]) {
    const server = await addon.startRpcServer({ port });
    assert.equal(server.rdmaCapable, true);
    await server.stop();
  }
  assert.equal(checks, 1);
});

test("expectRdma rejects a TCP-only backend before starting", async () => {
  const { binding, calls } = recordingBinding();
  await assert.rejects(
    loadAddon(binding).startRpcServer({ port: 50052, expectRdma: true }),
    { name: "RpcServerRdmaUnavailableError" },
  );
  assert.equal(calls.length, 0);
});

test("expectRdma starts when the backend supports RDMA", async () => {
  const { binding, calls } = recordingBinding({
    rpcBackendSupportsRdma: () => true,
  });
  const server = await loadAddon(binding).startRpcServer({
    port: 50052,
    expectRdma: true,
  });
  assert.equal(server.rdmaCapable, true);
  assert.equal(calls.length, 1);
  await server.stop();
});

test("the server binds loopback by default and normalizes localhost", async () => {
  const { binding, calls } = recordingBinding();
  const addon = loadAddon(binding);

  const byDefault = await addon.startRpcServer({ port: 50052 });
  assert.equal(byDefault.host, "127.0.0.1");
  assert.equal(calls[0].endpoint, "127.0.0.1:50052");
  await byDefault.stop();

  const localhost = await addon.startRpcServer({
    host: "localhost",
    port: 50053,
  });
  assert.equal(localhost.url, "127.0.0.1:50053");
  await localhost.stop();
});

test("non-loopback hosts require an explicit opt-in", async () => {
  const { binding, calls } = recordingBinding();
  const addon = loadAddon(binding);

  await assert.rejects(
    addon.startRpcServer({ host: "10.0.0.2", port: 50052 }),
    {
      name: "RpcServerNonLoopbackHostError",
    },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(addon.warnings, []);

  const server = await addon.startRpcServer({
    host: "10.0.0.2",
    port: 50052,
    allowNonLoopbackHost: true,
  });
  assert.equal(calls[0].endpoint, "10.0.0.2:50052");
  assert.equal(addon.warnings.length, 1);
  assert.match(addon.warnings[0], /QVAC_GGML_RPC_SERVER_TRUSTED_LAN/);
  await server.stop();
});

test("hosts must be IPv4 addresses or localhost", async () => {
  const { binding, calls } = recordingBinding();
  const addon = loadAddon(binding);
  for (const host of ["example.com", "::1", "127.0.0.256", "127.0.0"]) {
    await assert.rejects(
      addon.startRpcServer({ host, port: 50052, allowNonLoopbackHost: true }),
      { name: "RpcServerInvalidHostError" },
      host,
    );
  }
  assert.equal(calls.length, 0);
});

test("ports and thread counts are validated before starting", async () => {
  const { binding, calls } = recordingBinding();
  const addon = loadAddon(binding);
  for (const port of [0, 65536, 1.5]) {
    await assert.rejects(
      addon.startRpcServer({ port }),
      { name: "RangeError" },
      String(port),
    );
  }
  for (const threads of [0, -1, 1.5]) {
    await assert.rejects(
      addon.startRpcServer({ port: 50052, threads }),
      { name: "TypeError" },
      String(threads),
    );
  }
  assert.equal(calls.length, 0);
});

test("device lists are passed to the native server as one value", async () => {
  const { binding, calls } = recordingBinding();
  const server = await loadAddon(binding).startRpcServer({
    port: 50052,
    device: ["Vulkan0", "CPU"],
  });
  assert.equal(calls[0].device, "Vulkan0,CPU");
  assert.equal(server.device, "Vulkan0,CPU");
  await server.stop();
});

test("allocateFreePort returns a loopback port and rejects other hosts", async () => {
  const addon = loadAddon(recordingBinding().binding);
  const port = await addon.allocateFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.throws(() => addon.allocateFreePort("10.0.0.2"), {
    name: "RpcServerNonLoopbackHostError",
  });
});
