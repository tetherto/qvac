const net = require("bare-net");
const { startRpcServer } = require("../../mobile");
const { probeRpcServerProtocol } = require("../rpc-protocol.cjs");

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
}

main().catch((error) => {
  console.error(error);
  Bare.exitCode = 1;
});
