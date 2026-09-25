const net = require("bare-net");
const { startRpcServer } = require("../../mobile");
const { probeRpcServerProtocol } = require("../mobile/rpc-protocol.cjs");

async function main() {
  const server = await startRpcServer({ device: "CPU" });
  try {
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
    if (!/an unknown RPC server device was requested/.test(error.message)) {
      throw error;
    }
  }
}

main().catch((error) => {
  console.error(error);
  Bare.exitCode = 1;
});
