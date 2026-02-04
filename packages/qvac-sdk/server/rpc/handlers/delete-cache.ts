import type { DeleteCacheRequest, DeleteCacheResponse } from "@/schemas";
import { deleteCache as deleteCacheUtil } from "@/server/bare/addons/llamacpp-completion";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleDeleteCache(
  request: DeleteCacheRequest,
): Promise<DeleteCacheResponse> {
  try {
    if ("all" in request && request.all) {
      await deleteCacheUtil({ all: true });
    } else if ("kvCacheKey" in request) {
      const params: { kvCacheKey: string; modelId?: string } = {
        kvCacheKey: request.kvCacheKey,
      };
      if (request.modelId !== undefined) {
        params.modelId = request.modelId;
      }
      await deleteCacheUtil(params);
    }

    return {
      type: "deleteCache",
      success: true,
    };
  } catch (error) {
    logger.error("Error deleting cache:", error);
    return {
      type: "deleteCache",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
