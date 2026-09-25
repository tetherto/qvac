"use strict";

const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const net = require("node:net");
const { dirname } = require("node:path");
const {
  resolveRpcServerBinaryPath,
  startRpcServer,
} = require("../../index.js");
const { probeRpcServerProtocol } = require("../mobile/rpc-protocol.cjs");

async function main() {
  if (process.platform === "win32") {
    const packagedFiles = readdirSync(dirname(resolveRpcServerBinaryPath()));
    for (const backend of ["cpu", "rpc"]) {
      assert.ok(
        packagedFiles.some((file) =>
          new RegExp(
            `^(?:lib)?qvac-ggml-${backend}(?:[-_][^.]+)?\\.dll$`,
            "i",
          ).test(file),
        ),
        `Windows prebuild is missing the ${backend} backend DLL`,
      );
    }
  }

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
