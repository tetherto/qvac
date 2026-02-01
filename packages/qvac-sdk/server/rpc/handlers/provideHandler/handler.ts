import type { ProvideRequest, ProvideResponse } from "@/schemas/provide";
import { getSwarm, registerProviderTopic } from "@/server/bare/hyperswarm";
import { setupConnectionHandlers } from "./connection";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function provideHandler(
  request: ProvideRequest,
): Promise<ProvideResponse> {
  const swarm = getSwarm({
    firewallConfig: request.firewall,
  });

  logger.debug("🚀 Provide request received:", request);
  logger.debug("🔍 Swarm keyPair exists:", !!swarm.keyPair);
  logger.debug(
    "🔍 Swarm publicKey:",
    swarm.keyPair?.publicKey?.toString("hex")?.substring(0, 16),
  );

  try {
    logger.debug("⚡ Starting provide handler execution");
    const pubKey = swarm.keyPair.publicKey;
    logger.debug("🔑 Got public key:", pubKey.toString("hex"));

    // Use provided topic from hex string
    const topic = Buffer.from(request.topic, "hex");

    // Join topic as server (provider)
    logger.info("🌐 Joining topic as server...");
    const discovery = swarm.join(topic, { server: true, client: false });
    logger.debug("📡 Discovery object created:", !!discovery);

    // Wait for the topic to be fully announced on the DHT
    logger.debug("⏳ Waiting for topic announcement...");
    await discovery.flushed();
    logger.info(`✅ Topic announced: ${topic.toString("hex")}`);

    // Wait for connections
    logger.debug("⏳ Waiting for swarm flush...");
    await swarm.flush();
    logger.info(
      `🎯 Ready to accept connections on topic: ${topic.toString("hex").substring(0, 16)}...`,
    );

    // Handle incoming connections
    setupConnectionHandlers(swarm);

    registerProviderTopic(topic.toString("hex"));

    logger.debug("🏁 About to return success response...");
    const response = {
      type: "provide" as const,
      success: true,
      publicKey: pubKey.toString("hex"),
    };
    logger.debug("📤 Returning response:", response);
    return response;
  } catch (error) {
    logger.error("❌ Error in provide handler:", error);
    logger.error(
      "❌ Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );
    const errorResponse = {
      type: "provide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
    logger.debug("📤 Returning error response:", errorResponse);
    return errorResponse;
  }
}
