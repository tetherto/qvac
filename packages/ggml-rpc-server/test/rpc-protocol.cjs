"use strict";

const RPC_CMD_HELLO = 14;
const RPC_CMD_DEVICE_COUNT = 15;
const RPC_CONN_CAPS_SIZE = 24;
const HELLO_RESPONSE_SIZE = 4 + RPC_CONN_CAPS_SIZE;

function encodeRequest(command, payloadSize) {
  const request = new Uint8Array(1 + 8 + payloadSize);
  request[0] = command;
  request[1] = payloadSize;
  return request;
}

function decodeUint32Le(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function assertFrameSize(frame, expected) {
  if (
    frame[0] !== expected ||
    frame.subarray(1, 8).some((byte) => byte !== 0)
  ) {
    throw new Error(`Unexpected ggml RPC response size; expected ${expected}`);
  }
}

function readExactly(socket, size) {
  return new Promise((resolve, reject) => {
    const output = new Uint8Array(size);
    let offset = 0;

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onClose = () =>
      fail(new Error("ggml RPC server closed the protocol probe connection"));
    const onData = (chunk) => {
      if (offset + chunk.length > size) {
        fail(new Error("ggml RPC server returned an oversized protocol frame"));
        return;
      }
      output.set(chunk, offset);
      offset += chunk.length;
      if (offset === size) {
        cleanup();
        resolve(output);
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function connect(net, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function probeRpcServerProtocol(net, host, port) {
  const socket = await connect(net, host, port);
  try {
    socket.write(encodeRequest(RPC_CMD_HELLO, RPC_CONN_CAPS_SIZE));
    const hello = await readExactly(socket, 8 + HELLO_RESPONSE_SIZE);
    assertFrameSize(hello, HELLO_RESPONSE_SIZE);
    if (hello[8] === 0) {
      throw new Error("ggml RPC server returned an invalid protocol version");
    }

    socket.write(encodeRequest(RPC_CMD_DEVICE_COUNT, 0));
    const deviceCountResponse = await readExactly(socket, 8 + 4);
    assertFrameSize(deviceCountResponse, 4);
    const deviceCount = decodeUint32Le(deviceCountResponse, 8);
    if (deviceCount === 0) {
      throw new Error("ggml RPC server reported no devices");
    }

    return {
      version: `${hello[8]}.${hello[9]}.${hello[10]}`,
      deviceCount,
    };
  } finally {
    socket.destroy();
  }
}

module.exports = { probeRpcServerProtocol };
