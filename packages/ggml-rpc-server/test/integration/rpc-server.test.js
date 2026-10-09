"use strict";

const test = require("brittle");
const net = require("bare-net");
const { startRpcServer } = require("../../index");
const { probeRpcServerProtocol } = require("../mobile/rpc-protocol.cjs");

// Fabric builds its RPC backend with RDMA only for desktop Linux, and uses it
// only where libibverbs is installed, as on every Linux leg that runs this test.
const RDMA_EXPECTED = Bare.platform === "linux";

async function rejection(promise) {
  let server;
  try {
    server = await promise;
  } catch (error) {
    return error;
  }
  // A server that started anyway would keep the process alive.
  await server?.stop?.();
  throw new Error("Expected the promise to reject");
}

// Register teardown before the start settles: a sibling start under
// Promise.all can end the test while this one is still in flight.
function startStopped(t, options) {
  const starting = startRpcServer(options);
  t.teardown(async () => {
    const server = await starting.catch(() => null);
    await server?.stop();
  });
  return starting;
}

test("serves the RPC protocol on the CPU device", async (t) => {
  const server = await startStopped(t, { device: "CPU" });

  t.is(server.host, "127.0.0.1");
  t.is(server.url, `${server.host}:${server.port}`);
  t.is(server.device, "CPU");

  const probe = await probeRpcServerProtocol(net, server.host, server.port);
  t.ok(probe.deviceCount >= 1, `served ${probe.deviceCount} device(s)`);
});

test("binds a free port itself when none is given", async (t) => {
  const server = await startStopped(t, { device: "CPU" });

  t.ok(
    Number.isInteger(server.port) && server.port > 0 && server.port <= 65535,
    `bound port ${server.port}`,
  );
  await probeRpcServerProtocol(net, server.host, server.port);
});

test("starts with the default device selection", async (t) => {
  const server = await startStopped(t);

  t.is(server.device, undefined);
  const probe = await probeRpcServerProtocol(net, server.host, server.port);
  t.ok(probe.deviceCount >= 1, `served ${probe.deviceCount} device(s)`);
});

test("accepts a device list", async (t) => {
  const server = await startStopped(t, { device: ["CPU"] });

  t.is(server.device, "CPU");
  await probeRpcServerProtocol(net, server.host, server.port);
});

test("accepts an explicit thread count", async (t) => {
  const server = await startStopped(t, { device: "CPU", threads: 1 });

  await probeRpcServerProtocol(net, server.host, server.port);
});

test("stop is idempotent, including concurrent calls", async (t) => {
  const server = await startStopped(t, { device: "CPU" });

  await Promise.all([server.stop(), server.stop()]);
  await server.stop();
  t.pass("repeated stops resolved");
});

test("restarts on the same port after stopping", async (t) => {
  const first = await startStopped(t, { device: "CPU" });
  await probeRpcServerProtocol(net, first.host, first.port);
  await first.stop();

  const second = await startStopped(t, { device: "CPU", port: first.port });
  t.is(second.port, first.port);
  await probeRpcServerProtocol(net, second.host, second.port);
});

test("runs two servers side by side", async (t) => {
  const [first, second] = await Promise.all([
    startStopped(t, { device: "CPU" }),
    startStopped(t, { device: "CPU" }),
  ]);

  t.not(first.port, second.port);
  await probeRpcServerProtocol(net, first.host, first.port);
  await probeRpcServerProtocol(net, second.host, second.port);
});

test("normalizes localhost to the IPv4 loopback address", async (t) => {
  const server = await startStopped(t, { device: "CPU", host: "localhost" });

  t.is(server.host, "127.0.0.1");
  await probeRpcServerProtocol(net, server.host, server.port);
});

test("rejects an unknown device", async (t) => {
  const error = await rejection(
    startRpcServer({ device: "__qvac_unknown_device__" }),
  );

  t.is(error.code, "RpcServerDeviceError");
  t.ok(/unknown RPC server device/.test(error.message), error.message);
});

test("rejects a non-loopback host without opt-in", async (t) => {
  const error = await rejection(
    startRpcServer({ device: "CPU", host: "10.0.0.1" }),
  );

  t.is(error.name, "RpcServerNonLoopbackHostError");
});

test("rejects a host that is not an IPv4 address", async (t) => {
  const error = await rejection(
    startRpcServer({ device: "CPU", host: "example.com" }),
  );

  t.is(error.name, "RpcServerInvalidHostError");
});

test("rejects an invalid port or thread count", async (t) => {
  for (const port of [0, 65536, 1.5]) {
    const error = await rejection(startRpcServer({ device: "CPU", port }));
    t.ok(error instanceof RangeError, `port ${port}`);
  }
  for (const threads of [0, -1, 1.5]) {
    const error = await rejection(startRpcServer({ device: "CPU", threads }));
    t.ok(error instanceof TypeError, `threads ${threads}`);
  }
});

test("reports the installed backend's RDMA build", async (t) => {
  const server = await startStopped(t, { device: "CPU" });

  t.is(server.rdmaCapable, RDMA_EXPECTED);
});

test("expectRdma matches the backend's RDMA build", async (t) => {
  if (RDMA_EXPECTED) {
    const server = await startStopped(t, { device: "CPU", expectRdma: true });
    t.is(server.rdmaCapable, true);
    return;
  }

  const error = await rejection(
    startRpcServer({ device: "CPU", expectRdma: true }),
  );
  t.is(error.name, "RpcServerRdmaUnavailableError");
});
