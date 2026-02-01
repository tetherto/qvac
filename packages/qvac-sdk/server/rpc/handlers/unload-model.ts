import { unloadModel } from "@/server/bare/addons";
import { getRegistryStats } from "@/server/bare/registry/model-registry";
import { hasActiveProviders } from "@/server/bare/hyperswarm";
import type { UnloadModelRequest, UnloadModelResponse } from "@/schemas";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleUnloadModel(
  request: UnloadModelRequest,
): Promise<UnloadModelResponse> {
  const { modelId, clearStorage } = request;
  try {
    logger.debug("Unloading model", modelId);
    await unloadModel({ modelId, clearStorage });

    const stats = getRegistryStats();
    const modelsActive = stats.totalModels > 0;
    const providersActive = hasActiveProviders();

    return {
      type: "unloadModel",
      success: true,
      hasActiveModels: modelsActive,
      hasActiveProviders: providersActive,
    };
  } catch (error) {
    logger.error("Error during model unload:", error);
    return {
      type: "unloadModel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
