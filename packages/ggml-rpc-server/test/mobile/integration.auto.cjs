"use strict";

const net = require("bare-net");
const { startRpcServer } = require("@qvac/ggml-rpc-server");

function _connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

// eslint-disable-next-line no-unused-vars
async function runRpcServerLifecycle() {
  const server = await startRpcServer({ device: "CPU" });
  if (server.runtime !== "in-process") {
    throw new Error(
      `Expected in-process RPC server, received ${server.runtime}`,
    );
  }

  let socket;
  try {
    socket = await _connect(server.host, server.port);
    await server.stop();
    await server.stop();
  } finally {
    if (socket) socket.destroy();
    await server.stop();
  }

  console.log(`Managed mobile RPC lifecycle passed at ${server.url}`);
}
