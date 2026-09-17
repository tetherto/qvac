"use strict";

const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const {
  DEFAULT_RPC_SERVER_HOST,
  DEFAULT_RPC_SERVER_START_TIMEOUT_MS,
  DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS,
  RPC_SERVER_HEALTH_POLL_INTERVAL_MS,
  RpcServerInvalidHostError,
  RpcServerNonLoopbackHostError,
  RpcServerRdmaUnavailableError,
  allocateFreePort,
  resolveRpcServerPrebuildTarget,
  rpcServerLogsIndicateRdmaSupport,
  startRpcServer,
} = require("../../index.js");

function createFakeRpcServerBinary(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "qvac-rpc-server-test-"));
  const binaryPath = join(dir, "fake-rpc-server.js");
  const startupLog = options.startupLog || "";
  const binaryMarker = options.binaryMarker || "";
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
${binaryMarker}
const net = require('node:net')

const args = process.argv.slice(2)
const host = args[args.indexOf('--host') + 1]
const port = Number(args[args.indexOf('--port') + 1])
const server = net.createServer((socket) => socket.end())

server.listen({ host, port }, () => {
  process.stdout.write(${JSON.stringify(startupLog)})
  process.stdout.write('ready\\n')
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})

setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  );
  chmodSync(binaryPath, 0o755);
  return {
    binaryPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function waitForWarning(code) {
  return new Promise((resolve) => {
    function onWarning(warning) {
      if (warning && warning.code === code) {
        process.removeListener("warning", onWarning);
        resolve(warning);
      }
    }
    process.on("warning", onWarning);
  });
}

test("exports conservative lifecycle defaults", () => {
  assert.equal(DEFAULT_RPC_SERVER_HOST, "127.0.0.1");
  assert.equal(DEFAULT_RPC_SERVER_START_TIMEOUT_MS, 10000);
  assert.equal(DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS, 2000);
  assert.equal(RPC_SERVER_HEALTH_POLL_INTERVAL_MS, 100);
});

test("resolves every supported prebuild target", () => {
  const targets = [
    ["android", "arm64", "android-arm64"],
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["ios", "arm64", "ios-arm64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
    ["win32", "x64", "win32-x64"],
  ];

  for (const [runtimePlatform, runtimeArch, expected] of targets) {
    assert.equal(
      resolveRpcServerPrebuildTarget(runtimePlatform, runtimeArch),
      expected,
    );
  }
});

test("rejects unsupported prebuild targets", () => {
  assert.throws(
    () => resolveRpcServerPrebuildTarget("win32", "arm64"),
    /not packaged for win32-arm64/,
  );
  assert.throws(
    () => resolveRpcServerPrebuildTarget("freebsd", "x64"),
    /not packaged for freebsd-x64/,
  );
});

test("rejects non-loopback hosts", async () => {
  assert.throws(
    () => allocateFreePort("0.0.0.0"),
    RpcServerNonLoopbackHostError,
  );
  await assert.rejects(
    () =>
      startRpcServer({
        binaryPath: process.execPath,
        host: "0.0.0.0",
      }),
    RpcServerNonLoopbackHostError,
  );
});

test("normalizes localhost for the IPv4 RPC listener", async () => {
  const fixture = createFakeRpcServerBinary();

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      host: "localhost",
      startTimeoutMs: 5000,
    });
    assert.equal(server.host, DEFAULT_RPC_SERVER_HOST);
    assert.match(server.url, /^127\.0\.0\.1:\d+$/);
    await server.stop();
  } finally {
    fixture.cleanup();
  }
});

test("rejects hosts unsupported by the IPv4 RPC listener", async () => {
  assert.throws(
    () => allocateFreePort("::1", { allowNonLoopbackHost: true }),
    RpcServerInvalidHostError,
  );
  await assert.rejects(
    () =>
      startRpcServer({
        binaryPath: process.execPath,
        host: "example.test",
        allowNonLoopbackHost: true,
      }),
    RpcServerInvalidHostError,
  );
});

test("allows non-loopback hosts only with explicit opt-in", async () => {
  const port = await allocateFreePort("0.0.0.0", {
    allowNonLoopbackHost: true,
  });

  assert.equal(typeof port, "number");
  assert.ok(port > 0);
});

test("warns when starting on a non-loopback host", async () => {
  const fixture = createFakeRpcServerBinary();
  const warningPromise = waitForWarning("QVAC_GGML_RPC_SERVER_TRUSTED_LAN");

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      host: "0.0.0.0",
      allowNonLoopbackHost: true,
      startTimeoutMs: 5000,
    });
    const warning = await warningPromise;
    assert.match(warning.message, /no authentication or encryption/);
    await server.stop();
  } finally {
    fixture.cleanup();
  }
});

test("starts and stops a managed server process", async () => {
  const fixture = createFakeRpcServerBinary();
  const exitListenersBefore = process.listenerCount("exit");

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      startTimeoutMs: 5000,
    });
    assert.equal(process.listenerCount("exit"), exitListenersBefore + 1);
    assert.equal(server.runtime, "process");
    assert.equal(server.host, DEFAULT_RPC_SERVER_HOST);
    assert.match(server.url, /^127\.0\.0\.1:\d+$/);
    assert.equal(server.rdmaCapable, false);
    assert.equal(server.child.exitCode, null);
    await server.stop();
    assert.notEqual(server.child.exitCode, null);
    assert.equal(process.listenerCount("exit"), exitListenersBefore);
  } finally {
    fixture.cleanup();
  }
});

test("rejects startup when another process already owns the requested port", async () => {
  const fixture = createFakeRpcServerBinary();
  const incumbent = require("node:net").createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    incumbent.once("error", reject);
    incumbent.listen(0, DEFAULT_RPC_SERVER_HOST, resolve);
  });
  const address = incumbent.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");

  try {
    await assert.rejects(
      () =>
        startRpcServer({
          binaryPath: fixture.binaryPath,
          port: address.port,
          startTimeoutMs: 5000,
        }),
      /is unavailable/,
    );
  } finally {
    await new Promise((resolve) => incumbent.close(resolve));
    fixture.cleanup();
  }
});

test("rejects an invalid server thread count", async () => {
  const fixture = createFakeRpcServerBinary();
  try {
    await assert.rejects(
      () => startRpcServer({ binaryPath: fixture.binaryPath, threads: 0 }),
      /threads must be a positive integer/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects invalid ports and lifecycle durations before spawning", async () => {
  await assert.rejects(
    () => startRpcServer({ binaryPath: process.execPath, port: 0 }),
    /port must be an integer between 1 and 65535/,
  );
  await assert.rejects(
    () =>
      startRpcServer({
        binaryPath: process.execPath,
        startTimeoutMs: Number.NaN,
      }),
    /startTimeoutMs must be a positive finite number/,
  );
  await assert.rejects(
    () =>
      startRpcServer({
        binaryPath: process.execPath,
        shutdownGraceMs: Number.POSITIVE_INFINITY,
      }),
    /shutdownGraceMs must be a non-negative finite number/,
  );
});

test("detects RDMA-capable startup logs", async () => {
  assert.equal(
    rpcServerLogsIndicateRdmaSupport(
      "transport      : TCP (RDMA auto-negotiate enabled)",
    ),
    true,
  );
  assert.equal(rpcServerLogsIndicateRdmaSupport("transport      : TCP"), false);

  const fixture = createFakeRpcServerBinary({
    startupLog: "transport      : TCP (RDMA auto-negotiate enabled)\\n",
  });

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      expectRdma: true,
      startTimeoutMs: 5000,
    });
    assert.equal(server.rdmaCapable, true);
    await server.stop();
  } finally {
    fixture.cleanup();
  }
});

test("detects RDMA-capable packaged binaries", async () => {
  const fixture = createFakeRpcServerBinary({
    binaryMarker: "// RDMA auto-negotiate enabled\n",
  });

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      expectRdma: true,
      startTimeoutMs: 5000,
    });
    assert.equal(server.rdmaCapable, true);
    await server.stop();
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when RDMA support is expected but not reported", async () => {
  const fixture = createFakeRpcServerBinary();

  try {
    await assert.rejects(
      () =>
        startRpcServer({
          binaryPath: fixture.binaryPath,
          expectRdma: true,
          startTimeoutMs: 5000,
        }),
      RpcServerRdmaUnavailableError,
    );
  } finally {
    fixture.cleanup();
  }
});

test("allows parent exit cleanup to be disabled", async () => {
  const fixture = createFakeRpcServerBinary();
  const exitListenersBefore = process.listenerCount("exit");

  try {
    const server = await startRpcServer({
      binaryPath: fixture.binaryPath,
      cleanupOnExit: false,
      startTimeoutMs: 5000,
    });
    assert.equal(process.listenerCount("exit"), exitListenersBefore);
    await server.stop();
  } finally {
    fixture.cleanup();
  }
});
