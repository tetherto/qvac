import type { ProvideRequest, ProvideResponse } from "@/schemas/provide";
import {
  getSwarm,
  hasActiveProviders,
  registerProvider,
} from "@/server/bare/hyperswarm";
import { setupConnectionHandlers } from "./connection";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

// Tracks whether the connection listener has been attached on this swarm
// instance. `swarm.listen()` and `swarm.on("connection", ...)` cannot be
// undone without destroying the swarm (which is shared with consumers), so
// we only ever set them up once per process and gate inbound RPC mounting
// inside the listener on `hasActiveProviders()`.
let listenerAttached = false;

// Consumers reach the provider by calling `dht.connect(publicKey)` directly,
// so the provider only needs its DHT server bound on its keyPair — no topic
// announce required. `swarm.listen()` is the minimal operation that makes
// the keyPair reachable on the DHT.
//
// This handler is idempotent: a second `startQVACProvider()` call returns
// success without re-listening, re-attaching listeners, or double-counting
// the active-provider counter (which would prevent a single `stopQVACProvider`
// from cleanly shutting things down).
export async function provideHandler(
  request: ProvideRequest,
): Promise<ProvideResponse> {
  const swarm = getSwarm({
    firewallConfig: request.firewall,
  });

  logger.debug("🚀 Provide request received:", request);

  try {
    const pubKey = swarm.keyPair.publicKey;
    logger.debug("🔑 Provider public key:", pubKey.toString("hex"));

    if (hasActiveProviders()) {
      logger.info("ℹ️ Provider already running, returning existing identity");
      return {
        type: "provide" as const,
        success: true,
        publicKey: pubKey.toString("hex"),
      };
    }

    // We must wait for the DHT routing table to populate BEFORE announcing.
    // `swarm.listen()` only does a single initial announce using whatever
    // peers are in the routing table at that moment — if the DHT isn't
    // bootstrapped yet, that announce reaches very few nodes and consumers
    // won't be able to find us via dht.connect(publicKey).
    logger.info("🌐 Waiting for DHT to fully bootstrap...");
    await swarm.dht.fullyBootstrapped();

    logger.info("🌐 Announcing provider on DHT (binding keyPair)...");
    await swarm.listen();
    logger.info("🎯 Provider is listening and ready to accept connections");

    if (!listenerAttached) {
      setupConnectionHandlers(swarm);
      listenerAttached = true;
    }
    registerProvider();

    return {
      type: "provide" as const,
      success: true,
      publicKey: pubKey.toString("hex"),
    };
  } catch (error) {
    logger.error("❌ Error in provide handler:", error);
    logger.error(
      "❌ Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );
    return {
      type: "provide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
