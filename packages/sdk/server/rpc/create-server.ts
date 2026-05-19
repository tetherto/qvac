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

export interface IPCClientOptions {
  onDisconnect?: () => void;
}

export function createIPCClient(
  socketPath: string,
  options?: IPCClientOptions,
) {
  logger.info(`Connecting to IPC socket at ${socketPath}`);
  const socket = connect(socketPath);

  socket.on("connect", () => {
    logger.info("Connected to IPC server");
  });

  socket.on("error", (err: Error) => {
    logger.error("IPC client connection error:", err);
  });

  socket.on("close", () => {
    logger.warn("IPC socket closed — parent process likely terminated");
    options?.onDisconnect?.();
  });

  return new RPC(socket as unknown as Duplex<DuplexEvents>, handleRequest);
}
