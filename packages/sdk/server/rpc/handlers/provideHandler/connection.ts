import RPC from "bare-rpc";
import type { Duplex } from "bare-stream";
import type { Connection } from "hyperswarm";
import type Hyperswarm from "hyperswarm";
import { createRpcProxy } from "./proxy";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function setupConnectionHandlers(swarm: Hyperswarm) {
  logger.debug("👂 Setting up connection listener...");

  swarm.on("close", () => {
    logger.debug("🔗 Connection closed!");
  });

  swarm.on("connection", (conn: Connection) => {
    logger.debug("🔗 Connection event triggered!");
    const peerPubkey = conn.remotePublicKey?.toString("hex");
    logger.info(
      `📡 New connection established from: ${peerPubkey?.substring(0, 16)}...`,
    );
    logger.debug("🔐 Full peer public key:", peerPubkey);

    // Create RPC instance for this connection (as server)
    logger.debug("⚙️ Creating RPC instance for connection...");
    new RPC(conn as unknown as Duplex, createRpcProxy());
    logger.debug("✅ RPC instance created successfully");

    conn.on("close", () => {
      logger.debug(
        `🔌 Connection closed for peer: ${peerPubkey?.substring(0, 16)}`,
      );
    });

    conn.on("error", (err: Error) => {
      logger.error(
        `❌ Connection error for peer ${peerPubkey?.substring(0, 16)}:`,
        err,
      );
    });
  });

  logger.debug("✅ Connection listener set up");
}
