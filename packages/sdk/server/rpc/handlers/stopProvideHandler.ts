import type {
  StopProvideRequest,
  StopProvideResponse,
} from "@/schemas/stop-provide";
import { getSwarm, unregisterProviderTopic } from "@/server/bare/hyperswarm";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function stopProvideHandler(
  request: StopProvideRequest,
): StopProvideResponse {
  const swarm = getSwarm();

  try {
    const topic = Buffer.from(request.topic, "hex");
    const topicHex = request.topic;

    swarm.leave(topic);
    unregisterProviderTopic(topicHex);

    return {
      type: "stopProvide" as const,
      success: true,
    };
  } catch (error) {
    logger.error("❌ Error in stop provide handler:", error);
    return {
      type: "stopProvide" as const,
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
