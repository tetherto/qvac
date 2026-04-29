import RPC from "bare-rpc";
import type { Duplex } from "bare-stream";
import type { Connection } from "hyperswarm";
import type Hyperswarm from "hyperswarm";
import { createRpcProxy } from "./proxy";
import { hasActiveProviders } from "@/server/bare/hyperswarm";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function setupConnectionHandlers(swarm: Hyperswarm) {
  logger.debug("👂 Setting up connection listener...");

  swarm.on("close", () => {
    logger.debug("🔗 Connection closed!");
  });

  swarm.on("connection", (conn: Connection) => {
    const peerPubkey = conn.remotePublicKey?.toString("hex");

    // The swarm is shared between consumer and provider sides, and once
    // `swarm.listen()` has bound our keyPair on the DHT we cannot un-bind
    // it without destroying the swarm. To honor `stopQVACProvider()` —
    // which decrements `activeProviderCount` to 0 — we drop incoming
    // connections at the RPC layer when there's no active provider, so
    // peers can no longer dispatch delegated requests at us.
    if (!hasActiveProviders()) {
      logger.debug(
        `🚪 Dropping inbound connection from ${peerPubkey?.substring(0, 16)}... — provider is stopped`,
      );
      conn.destroy();
      return;
    }

    logger.debug("🔗 Connection event triggered!");
    logger.info(
      `📡 New connection established from: ${peerPubkey?.substring(0, 16)}...`,
    );
    logger.debug("🔐 Full peer public key:", peerPubkey);

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
