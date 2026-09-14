const net = require("bare-net");
const { startRpcServer } = require("../../mobile");

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function main() {
  const server = await startRpcServer({ device: "CPU" });
  let socket;
  try {
    socket = await connect(server.host, server.port);
    await server.stop();
    console.log(
      `in-process ggml-rpc-server prebuild listening at ${server.url}`,
    );
  } finally {
    if (socket) socket.destroy();
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  Bare.exitCode = 1;
});
