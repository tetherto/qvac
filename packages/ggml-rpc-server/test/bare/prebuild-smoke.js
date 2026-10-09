const net = require("bare-net");
const { startRpcServer } = require("../../index");
const { probeRpcServerProtocol } = require("../mobile/rpc-protocol.cjs");

// Fail unless main() runs to completion. If a running server stopped keeping
// the event loop alive, Bare would exit mid-check with this code still set.
Bare.exitCode = 1;

async function main() {
  const server = await startRpcServer({ device: "CPU" });
  try {
    // @qvac/fabric enables rpc-rdma for Linux only, and the backend tries RDMA
    // only when it can load libibverbs. smoke-packaged.cjs checks the host for
    // the library and passes the result.
    const expectRdma = Bare.argv.includes("--expect-rdma=true");
    if (server.rdmaCapable !== expectRdma) {
      throw new Error(
        `Expected rdmaCapable ${expectRdma} on ${Bare.platform}-${Bare.arch}, got ${server.rdmaCapable}`,
      );
    }
    console.log(
      `in-process ggml-rpc-server rdmaCapable=${server.rdmaCapable} on ${Bare.platform}-${Bare.arch}`,
    );
    const probe = await probeRpcServerProtocol(net, server.host, server.port);
    console.log(
      `in-process ggml-rpc-server ${probe.version} served ${probe.deviceCount} device(s) at ${server.url}`,
    );
  } finally {
    await server.stop();
  }

  try {
    await startRpcServer({ device: "__qvac_invalid_device__" });
    throw new Error("Expected an unknown-device startup failure");
  } catch (error) {
    if (
      error.name !== "RpcServerDeviceError" ||
      !/an unknown RPC server device was requested/.test(error.message)
    ) {
      throw error;
    }
  }

  // Only the running server can keep the process alive until this unref'd
  // timer fires, as it must for a standalone worker that just waits.
  const idleServer = await startRpcServer({ device: "CPU" });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        probeRpcServerProtocol(net, idleServer.host, idleServer.port).then(
          resolve,
          reject,
        );
      }, 500);
      timer.unref();
    });
    console.log("in-process ggml-rpc-server kept the process alive while idle");
  } finally {
    await idleServer.stop();
  }
}

main().then(
  () => {
    Bare.exitCode = 0;
  },
  (error) => {
    console.error(error);
    Bare.exitCode = 1;
  },
);
