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

type PeerPublicKey = string;

const activeRPCs = new Map<PeerPublicKey, RPC>();
const activeConnections = new Map<PeerPublicKey, Connection>();

// In-flight `ensureRPCConnection` promises keyed by peer. Concurrent
// `getRPC(publicKey)` callers (without `forceNewConnection`) join the same
// promise instead of each running their own bootstrap+connect, which would
// open multiple sockets, clobber the active maps, and leak the loser.
const inflightConnections = new Map<PeerPublicKey, Promise<RPC>>();

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

function trackConnection(publicKey: string, conn: Connection, rpc: RPC): void {
  activeRPCs.set(publicKey, rpc);
  activeConnections.set(publicKey, conn);

  conn.on("close", () => {
    logger.debug(`Connection closed for peer: ${publicKey}`);
    if (activeConnections.get(publicKey) === conn) {
      activeConnections.delete(publicKey);
      activeRPCs.delete(publicKey);
      clearPeerConnectionTracking(publicKey);
    }
  });

  conn.on("error", (err) => {
    logger.error(`Connection error for peer ${publicKey}:`, err);
    if (activeConnections.get(publicKey) === conn) {
      activeConnections.delete(publicKey);
      activeRPCs.delete(publicKey);
      clearPeerConnectionTracking(publicKey);
    }
  });
}

async function closeConnection(publicKey: string): Promise<void> {
  const existingConnection = activeConnections.get(publicKey);
  if (!existingConnection) return;

  logger.info(`🔌 Closing existing connection for peer: ${publicKey}`);

  // Wait for the close event before returning so any pending cleanup
  // in the underlying DHT stream completes before we reconnect.
  await new Promise<void>((resolve) => {
    existingConnection.once("close", () => resolve());
    existingConnection.destroy();
  });

  if (activeConnections.get(publicKey) === existingConnection) {
    activeConnections.delete(publicKey);
    activeRPCs.delete(publicKey);
    clearPeerConnectionTracking(publicKey);
  }
}

// Open a direct DHT connection to a peer by public key. Bypasses topic
// discovery entirely — we already know who we're talking to, so we skip
// swarm.join()/flush() and let the DHT route by public key.
function openDhtConnection(publicKey: string): Connection {
  const swarm = getSwarm();
  const relayThrough = swarm.relayThrough
    ? swarm.relayThrough(false, swarm)
    : null;

  return swarm.dht.connect(Buffer.from(publicKey, "hex"), {
    keyPair: swarm.keyPair,
    relayThrough,
  });
}

// Resolve when the DHT connection emits "open"; reject promptly on "error"
// or "close" so firewall-rejected / abruptly-closed connects fail fast
// instead of dragging out the full delegate timeout (60s on cold paths).
function waitForOpen(conn: Connection, timeout?: number): Promise<void> {
  const opened = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      conn.removeListener("open", onOpen);
      conn.removeListener("error", onError);
      conn.removeListener("close", onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new DelegateConnectionFailedError(
          "Connection closed before open (peer unreachable or rejected by firewall)",
        ),
      );
    };
    conn.once("open", onOpen);
    conn.once("error", onError);
    conn.once("close", onClose);
  });

  return withTimeout(opened, timeout);
}

async function ensureRPCConnection(
  publicKey: string,
  timeout?: number,
  healthCheckTimeout?: number,
): Promise<RPC> {
  const healthCheckCap = healthCheckTimeout ?? HEALTH_CHECK_TIMEOUT_MS;
  const operationStart = nowMs();
  const getRemainingTimeout = (): number | undefined => {
    if (timeout === undefined) return undefined;
    return Math.max(timeout - (nowMs() - operationStart), 0);
  };

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

  const connectionStart = nowMs();
  let conn: Connection | undefined;

  try {
    logger.info(
      `🔗 Establishing direct DHT connection to peer: ${publicKey}${timeout ? `, timeout: ${timeout}ms` : ""}`,
    );

    // Ensure the DHT routing table is populated before attempting to look up
    // the peer. On a cold swarm the table is nearly empty and findPeer can
    // return PEER_NOT_FOUND immediately even when the provider is reachable.
    const bootstrapStart = nowMs();
    const swarm = getSwarm();
    logger.info(`⏳ Waiting for DHT to fully bootstrap before connect...`);
    await withTimeout(swarm.dht.fullyBootstrapped(), getRemainingTimeout());
    logger.info(
      `✅ DHT bootstrapped in ${(nowMs() - bootstrapStart).toFixed(0)}ms`,
    );

    conn = openDhtConnection(publicKey);
    await waitForOpen(conn, getRemainingTimeout());

    logger.info(`🍺 Peer connection opened: ${publicKey}`);

    const rpc = new RPC(conn as unknown as Duplex, () => {
      // No-op handler since we're only sending requests, not receiving them
    });

    trackConnection(publicKey, conn, rpc);

    const connectionDuration = nowMs() - connectionStart;
    cacheDelegationConnectionTime(publicKey, connectionDuration);

    return rpc;
  } catch (error: unknown) {
    if (conn && !conn.destroyed) {
      conn.destroy();
    }
    cleanupStaleConnection(publicKey);

    logger.error("Failed to establish RPC connection:", error);
    throw new DelegateConnectionFailedError(
      `RPC connection failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

// Create an RPC instance for a specific HyperSwarm peer.
// Connects directly via the DHT using the peer's public key — no topic
// discovery required.
//
// Concurrent calls for the same peer share a single in-flight bootstrap +
// connect operation, but each caller still gets its own `timeout` enforced
// against the shared promise (via `withTimeout`) — so a fast caller that
// gives up at 5s does not block a slow caller waiting up to 60s.
//
// `forceNewConnection` always tears down the existing socket first and
// starts a fresh attempt outside the shared promise.
export async function getRPC(
  publicKey: string,
  options: RPCOptions = {},
): Promise<RPC> {
  if (options.forceNewConnection) {
    await closeConnection(publicKey);
    return await ensureRPCConnection(
      publicKey,
      options.timeout,
      options.healthCheckTimeout,
    );
  }

  let inflight = inflightConnections.get(publicKey);
  if (!inflight) {
    inflight = ensureRPCConnection(
      publicKey,
      options.timeout,
      options.healthCheckTimeout,
    );
    const tracked = inflight;
    inflightConnections.set(publicKey, tracked);
    // Clear the inflight entry on settle. We register a single combined
    // settle handler via `then(handler, handler)` so that on rejection the
    // failure is *observed* on `tracked` itself — using `tracked.finally(...)`
    // returns a fresh promise that re-rejects with the original error, and
    // since nothing awaits that fresh promise it would surface as an
    // unhandled rejection. The worker treats unhandled rejections as fatal
    // and tears down the swarm + cancels all in-flight downloads, which then
    // breaks the legitimate fallback-to-local path that the caller awaits via
    // `withTimeout(inflight, ...)` below. Caller still observes the original
    // rejection through `await withTimeout(inflight, ...)`.
    const clearInflight = (): void => {
      if (inflightConnections.get(publicKey) === tracked) {
        inflightConnections.delete(publicKey);
      }
    };
    tracked.then(clearInflight, clearInflight);
  }

  return await withTimeout(inflight, options.timeout);
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
