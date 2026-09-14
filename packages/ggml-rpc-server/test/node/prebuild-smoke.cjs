"use strict";

const { startRpcServer } = require("../../index.js");

async function main() {
  const server = await startRpcServer({
    device: "CPU",
    startTimeoutMs: 30000,
  });

  try {
    console.log(`ggml-rpc-server prebuild listening at ${server.url}`);
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
