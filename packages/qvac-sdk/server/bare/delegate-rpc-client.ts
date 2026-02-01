import { getSwarm } from "./hyperswarm";
import RPC from "bare-rpc";
import type { Connection } from "hyperswarm";
import type { Duplex } from "bare-stream";
import { withTimeout } from "@/utils/withTimeout";
import type { RPCOptions } from "@/schemas";
import { DelegateConnectionFailedError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// This needs to run on Bare, hence why it's in server and not in client

// Connection key combines topic + public key for unique identification
type ConnectionKey = string;

// Map of active RPC instances by public key
const activeRPCs = new Map<ConnectionKey, RPC>();

// Map to store underlying connections for cleanup
const activeConnections = new Map<ConnectionKey, Connection>();

function closeConnection(publicKey: string) {
  const existingConnection = activeConnections.get(publicKey);
  if (existingConnection) {
    logger.info(`🔌 Closing existing connection for peer: ${publicKey}`);
    existingConnection.destroy();
    activeConnections.delete(publicKey);
    activeRPCs.delete(publicKey);
  }
}

// Establish RPC connection to a peer if not already connected
async function ensureRPCConnection(
  topic: string,
  publicKey: string,
  timeout?: number,
): Promise<RPC> {
  // Check if we already have an RPC instance for this peer
  let rpc = activeRPCs.get(publicKey);
  const swarm = getSwarm();

  if (!rpc) {
    // Need to establish connection first
    try {
      logger.info(
        `🔗 Establishing RPC connection to topic: ${topic}, peer: ${publicKey}, timeout: ${timeout}ms`,
      );

      const connectionPromise = (async () => {
        const topicBuffer = Buffer.from(topic, "hex");
        // const discovery =
        swarm.join(topicBuffer, {
          server: false,
          client: true,
        });

        await swarm.flush();

        logger.info(`✅ Connected to topic: ${topic}`);
        logger.debug(`📊 Active RPC connections: ${activeRPCs.size}`);

        // Check again if we now have an RPC instance for the target peer
        rpc = activeRPCs.get(publicKey);

        if (!rpc) {
          logger.error(`❌ No RPC instance found for peer ${publicKey}`);
          logger.debug(
            `📊 Available RPC connections:`,
            Array.from(activeRPCs.keys()),
          );
          throw new DelegateConnectionFailedError(
            `Could not establish RPC connection to peer ${publicKey} on topic ${topic}`,
          );
        } else {
          logger.debug(`✅ RPC instance found for peer ${publicKey}`);
        }
      })();

      await withTimeout(connectionPromise, timeout);
    } catch (error: unknown) {
      logger.error("Failed to establish RPC connection:", error);
      throw new DelegateConnectionFailedError(
        `RPC connection failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  return rpc as RPC;
}

// Create an RPC instance for a specific HyperSwarm peer
export async function getRPC(
  topic: string,
  publicKey: string,
  options: RPCOptions = {},
): Promise<RPC> {
  const swarm = getSwarm();

  // Close existing connection if forceNewConnection is true
  if (options.forceNewConnection) {
    closeConnection(publicKey);
  }

  // Set up connection tracking
  swarm.on("connection", (conn: Connection) => {
    const peerPubkey = conn.remotePublicKey?.toString("hex");
    if (!peerPubkey) return;

    logger.debug(`🍺 New peer connection established: ${peerPubkey}`);

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
    });

    conn.on("error", (err) => {
      logger.error(`Connection error for peer ${peerPubkey}:`, err);
      activeRPCs.delete(peerPubkey);
      activeConnections.delete(peerPubkey);
    });
  });

  return await ensureRPCConnection(topic, publicKey, options.timeout);
}
