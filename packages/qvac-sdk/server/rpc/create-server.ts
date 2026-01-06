import RPC from "bare-rpc";
import { connect } from "bare-net";
import { handleRequest } from "./handle-request";
import type { Duplex, DuplexEvents } from "bare-stream";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function createBareKitRPCServer() {
  const { IPC } = (globalThis as { BareKit?: { IPC: Duplex<DuplexEvents> } })
    .BareKit!;
  return new RPC(IPC, handleRequest);
}

export function createIPCClient(socketPath: string) {
  logger.info(`Connecting to IPC socket at ${socketPath}`);
  const socket = connect(socketPath);

  socket.on("connect", () => {
    logger.info("Connected to IPC server");
  });

  socket.on("error", (err: Error) => {
    logger.error("IPC client connection error:", err);
  });

  return new RPC(socket as unknown as Duplex<DuplexEvents>, handleRequest);
}
