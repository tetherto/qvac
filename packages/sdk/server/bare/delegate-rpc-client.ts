import { getSwarm } from "./hyperswarm";
import RPC from "bare-rpc";
import type { Connection } from "hyperswarm";
import type { Duplex } from "bare-stream";
import { withTimeout } from "@/utils/withTimeout";
import type { RPCOptions } from "@/schemas";
import { DelegateConnectionFailedError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { nowMs } from "@/profiling";
import {
  cacheDelegationConnectionTime,
  clearPeerConnectionTracking,
} from "@/server/rpc/profiling/delegation-profiler";
import { getNextCommandId } from "@/server/rpc/rpc-utils";

const logger = getServerLogger();

// This needs to run on Bare, hence why it's in server and not in client

// Connection key combines topic + public key for unique identification
type ConnectionKey = string;

// Map of active RPC instances by public key
const activeRPCs = new Map<ConnectionKey, RPC>();

// Map to store underlying connections for cleanup
const activeConnections = new Map<ConnectionKey, Connection>();

// Track whether the global connection handler has been registered
let connectionHandlerRegistered = false;
const HEALTH_CHECK_TIMEOUT_MS = 1500;

function isHeartbeatResponse(payload: unknown): payload is { type: "heartbeat" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)["type"] === "heartbeat"
  );
}

async function isRPCConnectionHealthy(
  rpc: RPC,
  timeout: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const req = rpc.request(getNextCommandId());
    req.send(JSON.stringify({ type: "heartbeat" }), "utf-8");
    const response = await withTimeout(req.reply("utf-8"), timeout);
    const payload: unknown = JSON.parse(response?.toString() || "{}");
    return isHeartbeatResponse(payload);
  } catch (error: unknown) {
    logger.debug("RPC health check failed", { error });
    return false;
  }
}

/**
 * Register the swarm "connection" handler once (not per getRPC call).
 * This fixes the event listener leak where each getRPC() call added
 * a new listener, causing duplicate RPC instances on the same stream.
 */
function ensureConnectionHandler(): void {
  if (connectionHandlerRegistered) return;
  connectionHandlerRegistered = true;

  const swarm = getSwarm();

  swarm.on("connection", (conn: Connection) => {
    const peerPubkey = conn.remotePublicKey?.toString("hex");
    if (!peerPubkey) return;

    logger.info(`🍺 New peer connection established: ${peerPubkey}`);

    // Create RPC instance for this connection (as client)
    const rpc = new RPC(conn as unknown as Duplex, () => {
      // No-op handler since we're only sending requests, not receiving them
    });

    // Store RPC instance and connection by peer ID for lookup
    activeRPCs.set(peerPubkey, rpc);
    activeConnections.set(peerPubkey, conn);

    conn.on("close", () => {
      logger.debug(`Connection closed for peer: ${peerPubkey}`);
      activeRPCs.delete(peerPubkey);
      activeConnections.delete(peerPubkey);
      clearPeerConnectionTracking(peerPubkey);
    });

    conn.on("error", (err) => {
      logger.error(`Connection error for peer ${peerPubkey}:`, err);
      activeRPCs.delete(peerPubkey);
      activeConnections.delete(peerPubkey);
      clearPeerConnectionTracking(peerPubkey);
    });
  });
}

async function closeConnection(publicKey: string): Promise<void> {
  const existingConnection = activeConnections.get(publicKey);
  if (existingConnection) {
    logger.info(`🔌 Closing existing connection for peer: ${publicKey}`);

    // Wait for the close event before returning so Hyperswarm's internal
    // _allConnections is cleaned up before we attempt to rejoin/flush.
    await new Promise<void>((resolve) => {
      existingConnection.on("close", () => {
        resolve();
      });
      existingConnection.destroy();
    });

    if (activeConnections.get(publicKey) !== existingConnection) return;
    activeConnections.delete(publicKey);
    activeRPCs.delete(publicKey);
    clearPeerConnectionTracking(publicKey);
  }
}

// Establish RPC connection to a peer if not already connected
async function ensureRPCConnection(
  topic: string,
  publicKey: string,
  timeout?: number,
  healthCheckTimeout?: number,
): Promise<RPC> {
  const healthCheckCap = healthCheckTimeout ?? HEALTH_CHECK_TIMEOUT_MS;
  const operationStart = nowMs();
  const getRemainingTimeout = (): number | undefined => {
    if (timeout === undefined) {
      return undefined;
    }

    return Math.max(timeout - (nowMs() - operationStart), 0);
  };

  // Check if we already have an RPC instance for this peer
  const existingRpc = activeRPCs.get(publicKey);
  if (existingRpc) {
    const remainingTimeout = getRemainingTimeout();
    const probeTimeout =
      remainingTimeout === undefined
        ? healthCheckCap
        : Math.min(remainingTimeout / 2, healthCheckCap);
    const isHealthy = await isRPCConnectionHealthy(existingRpc, probeTimeout);
    if (isHealthy) {
      return existingRpc;
    }
    logger.info(
      `🧹 Cached RPC failed health check for peer ${publicKey}, reconnecting`,
    );
    cleanupStaleConnection(publicKey);
  }

  const swarm = getSwarm();
  const connectionStart = nowMs();

  // Track the listener so we can clean it up on timeout
  let onConnection: (conn: Connection) => void = () => {};

  try {
    logger.info(
      `🔗 Establishing RPC connection to topic: ${topic}, peer: ${publicKey}, timeout: ${timeout}ms`,
    );

    const connectionPromise = new Promise<RPC>((resolve, reject) => {
      const topicBuffer = Buffer.from(topic, "hex");
      swarm.join(topicBuffer, {
        server: false,
        client: true,
      });

      // Wait for the specific peer's connection event instead of just
      // checking after flush. This handles the case where flush resolves
      // (discovery done) but the P2P connection is still being established
      // via holepunching or relays.
      onConnection = (conn: Connection): void => {
        const peerPubkey = conn.remotePublicKey?.toString("hex");
        if (peerPubkey === publicKey) {
          swarm.removeListener("connection", onConnection);
          // The global handler (ensureConnectionHandler) will create the RPC
          // and store it in activeRPCs. Give it a tick to run first.
          const rpc = activeRPCs.get(publicKey);
          if (rpc) {
            resolve(rpc);
          } else {
            // Global handler runs synchronously before us in the same event,
            // so this shouldn't happen, but handle it just in case
            setTimeout(() => {
              const delayedRpc = activeRPCs.get(publicKey);
              if (delayedRpc) {
                resolve(delayedRpc);
              } else {
                reject(
                  new DelegateConnectionFailedError(
                    `Connection established but RPC not created for peer ${publicKey}`,
                  ),
                );
              }
            }, 100);
          }
        }
      };

      swarm.on("connection", onConnection);

      // Also flush to trigger discovery. After flush, check if the connection
      // was already established (the global handler may have caught it).
      void swarm.flush().then(() => {
        logger.info(`✅ Flush completed for topic: ${topic}`);
        logger.debug(`📊 Active RPC connections: ${activeRPCs.size}`);

        const rpc = activeRPCs.get(publicKey);
        if (rpc) {
          swarm.removeListener("connection", onConnection);
          resolve(rpc);
        }
        // If not connected after flush, the onConnection listener keeps
        // waiting until the timeout from withTimeout kicks in.
        // Hyperswarm may still establish the connection via retries/relays.
        logger.debug(
          `⏳ Peer not connected after flush, waiting for connection event...`,
        );
      });
    });

    const rpc = await withTimeout(connectionPromise, getRemainingTimeout());

    const connectionDuration = nowMs() - connectionStart;
    cacheDelegationConnectionTime(publicKey, connectionDuration);

    return rpc;
  } catch (error: unknown) {
    // Clean up the per-request connection listener
    swarm.removeListener("connection", onConnection);

    // Remove stale connection so next attempt creates a fresh one
    // instead of reusing a dead RPC
    cleanupStaleConnection(publicKey);

    logger.error("Failed to establish RPC connection:", error);
    throw new DelegateConnectionFailedError(
      `RPC connection failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// Create an RPC instance for a specific HyperSwarm peer
export async function getRPC(
  topic: string,
  publicKey: string,
  options: RPCOptions = {},
): Promise<RPC> {
  // Ensure the global connection handler is registered (once)
  ensureConnectionHandler();

  // Close existing connection if forceNewConnection is true
  // Await the close to avoid racing with the subsequent join/flush
  if (options.forceNewConnection) {
    await closeConnection(publicKey);
  }

  return await ensureRPCConnection(
    topic,
    publicKey,
    options.timeout,
    options.healthCheckTimeout,
  );
}

/**
 * Remove a stale RPC connection for a peer.
 * Called when a delegation request fails (e.g., timeout) so the next
 * attempt creates a fresh connection instead of reusing a dead RPC.
 */
export function cleanupStaleConnection(publicKey: string): void {
  logger.info(
    `🗑️ Removing stale connection for peer: ${publicKey} after failed delegation`,
  );
  activeRPCs.delete(publicKey);
  const conn = activeConnections.get(publicKey);
  if (conn) {
    conn.destroy();
    activeConnections.delete(publicKey);
  }
  clearPeerConnectionTracking(publicKey);
}
