"use strict";

require("./integration-runtime.cjs");
require("./rpc-protocol.cjs");

const net = require("bare-net");
const { startRpcServer } = require("@qvac/ggml-rpc-server");

// eslint-disable-next-line no-unused-vars
async function runRpcServerLifecycle() {
  const server = await startRpcServer({ device: "CPU" });
  if (server.runtime !== "in-process") {
    throw new Error(
      `Expected in-process RPC server, received ${server.runtime}`,
    );
  }

  try {
    const probe = await globalThis.probeRpcServerProtocol(
      net,
      server.host,
      server.port,
    );
    if (probe.deviceCount < 1) {
      throw new Error("Expected the managed RPC server to expose a device");
    }
    await server.stop();
    await server.stop();
  } finally {
    await server.stop();
  }

  console.log(`Managed mobile RPC lifecycle passed at ${server.url}`);
  return { summary: { total: 1, passed: 1, failed: 0 } };
}
