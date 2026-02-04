import type { EmbedRequest, EmbedResponse } from "@/schemas";
import { embed } from "@/server/bare/addons/llamacpp-embedding";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleEmbed(
  request: EmbedRequest,
): Promise<EmbedResponse> {
  const { modelId, text } = request;
  try {
    const embedding = await embed({ modelId, text });
    return {
      type: "embed",
      success: true,
      embedding,
    };
  } catch (error) {
    logger.error("Error during embedding:", error);
    return {
      type: "embed",
      success: false,
      embedding: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
