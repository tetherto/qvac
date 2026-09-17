"use strict";

const net = require("node:net");
const { startRpcServer } = require("../../index.js");
const { probeRpcServerProtocol } = require("../rpc-protocol.cjs");

async function main() {
  const server = await startRpcServer({
    device: "CPU",
    startTimeoutMs: 30000,
  });

  try {
    const probe = await probeRpcServerProtocol(net, server.host, server.port);
    console.log(
      `ggml-rpc-server ${probe.version} served ${probe.deviceCount} device(s) at ${server.url}`,
    );
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
