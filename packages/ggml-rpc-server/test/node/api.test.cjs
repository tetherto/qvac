"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadAddon } = require("./load-addon.cjs");

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
    let queried;
    const { binding } = recordingBinding({
      rpcBackendSupportsRdma: (options) => {
        queried = options;
        return capable;
      },
    });
    const server = await loadAddon(binding).startRpcServer({ port: 50052 });
    assert.equal(server.rdmaCapable, capable);
    // The native side checks the module @qvac/fabric loads; JS names no path.
    assert.deepEqual(Object.keys(queried), []);
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

test("the server handle exposes only live fields", async () => {
  const server = await loadAddon(recordingBinding().binding).startRpcServer({
    port: 50052,
  });
  assert.deepEqual(Object.keys(server).sort(), [
    "device",
    "host",
    "port",
    "rdmaCapable",
    "stop",
    "url",
  ]);
  await server.stop();
});

test("the non-loopback error names the opt-in", async () => {
  const addon = loadAddon(recordingBinding().binding);
  await assert.rejects(
    addon.startRpcServer({ host: "10.0.0.2", port: 50052 }),
    {
      name: "RpcServerNonLoopbackHostError",
      message: /allowNonLoopbackHost: true/,
    },
  );
});

function nativeError(code, message = `native ${code}`) {
  return Object.assign(new Error(message), { code });
}

test("native start failures become typed errors", async () => {
  for (const code of [
    "RpcServerDeviceError",
    "RpcServerCacheError",
    "RpcServerStartError",
  ]) {
    const native = nativeError(code);
    const addon = loadAddon(
      recordingBinding({ startServer: () => Promise.reject(native) }).binding,
    );
    const error = await addon.startRpcServer({ port: 50052 }).then(
      () => assert.fail("expected a rejection"),
      (caught) => caught,
    );
    assert.ok(error instanceof addon[code], code);
    assert.ok(error instanceof addon.RpcServerNativeError, code);
    assert.equal(error.name, code);
    assert.equal(error.code, code);
    assert.equal(error.message, native.message);
    assert.equal(error.cause, native);
  }
});

test("synchronous native failures become typed errors", async () => {
  const addon = loadAddon(
    recordingBinding({
      startServer: () => {
        throw nativeError("RpcServerBackendError");
      },
    }).binding,
  );
  await assert.rejects(addon.startRpcServer({ port: 50052 }), {
    name: "RpcServerBackendError",
    code: "RpcServerBackendError",
  });

  const rdmaFailure = loadAddon(
    recordingBinding({
      rpcBackendSupportsRdma: () => {
        throw nativeError("RpcServerBackendError");
      },
    }).binding,
  );
  await assert.rejects(rdmaFailure.startRpcServer({ port: 50052 }), {
    name: "RpcServerBackendError",
  });
});

test("native stop failures become typed errors", async () => {
  let failStop = true;
  const addon = loadAddon(
    recordingBinding({
      stopServer: () =>
        failStop
          ? Promise.reject(nativeError("RpcServerStopError"))
          : Promise.resolve(),
    }).binding,
  );
  const server = await addon.startRpcServer({ port: 50052 });
  await assert.rejects(server.stop(), (error) => {
    assert.ok(error instanceof addon.RpcServerStopError);
    return true;
  });
  failStop = false;
  await server.stop();
});

test("errors without a known native code pass through unchanged", async () => {
  const native = nativeError("InvalidArgument");
  const addon = loadAddon(
    recordingBinding({ startServer: () => Promise.reject(native) }).binding,
  );
  await assert.rejects(addon.startRpcServer({ port: 50052 }), (error) => {
    assert.equal(error, native);
    return true;
  });
});

test("device names are trimmed before reaching the native server", async () => {
  for (const [device, expected] of [
    ["Vulkan0, CPU", "Vulkan0,CPU"],
    [" Vulkan0 / CPU ", "Vulkan0,CPU"],
    [[" Vulkan0 ", "CPU "], "Vulkan0,CPU"],
  ]) {
    const { binding, calls } = recordingBinding();
    const server = await loadAddon(binding).startRpcServer({
      port: 50052,
      device,
    });
    assert.equal(calls[0].device, expected, JSON.stringify(device));
    assert.equal(server.device, expected);
    await server.stop();
  }
});

test("blank device values are not turned into the default device", async () => {
  for (const [device, expected] of [
    ["  ", "  "],
    [[" "], " "],
    ["", ""],
    [[], ""],
  ]) {
    const { binding, calls } = recordingBinding();
    const server = await loadAddon(binding).startRpcServer({
      port: 50052,
      device,
    });
    assert.equal(calls[0].device, expected, JSON.stringify(device));
    await server.stop();
  }
});
