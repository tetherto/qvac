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

  async function probeStartup(label, options, expectedMetalLog) {
    const startedAt = Date.now();
    let server;
    try {
      server = await startRpcServer({ device: "CPU", ...options });
    } catch (error) {
      console.error(
        `${label} startup failed after ${Date.now() - startedAt}ms`,
      );
      throw error;
    }

    try {
      const startupMs = Date.now() - startedAt;
      if (expectedMetalLog !== null) {
        const metalLoaded = server
          .logs()
          .includes("ggml_metal_library_init: loaded in");
        assert.equal(
          metalLoaded,
          expectedMetalLog,
          `${label} Metal initialization`,
        );
      }
      const probe = await probeRpcServerProtocol(net, server.host, server.port);
      console.log(
        `${label}: ggml-rpc-server ${probe.version} served ${probe.deviceCount} device(s) at ${server.url} (startup ${startupMs}ms)`,
      );
    } finally {
      await server.stop();
    }
  }

  if (process.platform === "darwin" && process.arch === "x64") {
    await probeStartup(
      "Darwin x64 CPU-only",
      {
        startTimeoutMs: 30000,
        env: { ...process.env, GGML_METAL_DEVICES: "0" },
      },
      false,
    );
    await probeStartup(
      "Darwin x64 Metal-enabled",
      {
        startTimeoutMs: 120000,
        env: { ...process.env, GGML_METAL_DEVICES: "1" },
      },
      true,
    );
  } else {
    await probeStartup("Packaged", { startTimeoutMs: 30000 }, null);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
