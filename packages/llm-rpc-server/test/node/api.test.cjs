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
  RpcServerNonLoopbackHostError,
  RpcServerRdmaUnavailableError,
  allocateFreePort,
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

test("exports conservative lifecycle defaults", () => {
  assert.equal(DEFAULT_RPC_SERVER_HOST, "127.0.0.1");
  assert.equal(DEFAULT_RPC_SERVER_START_TIMEOUT_MS, 10000);
  assert.equal(DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS, 2000);
  assert.equal(RPC_SERVER_HEALTH_POLL_INTERVAL_MS, 100);
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

test("allows non-loopback hosts only with explicit opt-in", async () => {
  const port = await allocateFreePort("0.0.0.0", {
    allowNonLoopbackHost: true,
  });

  assert.equal(typeof port, "number");
  assert.ok(port > 0);
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

test("detects RDMA-capable startup logs", async () => {
  assert.equal(
    rpcServerLogsIndicateRdmaSupport("transport      : TCP (RDMA auto-negotiate enabled)"),
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
