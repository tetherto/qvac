import type {
  GetLoadedModelInfoRequest,
  GetLoadedModelInfoResponse,
  LoadedModelInfo,
} from "@/schemas";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getPlugin } from "@/server/plugins/registry";
import { ModelNotFoundError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function handleGetLoadedModelInfo(
  request: GetLoadedModelInfoRequest,
): GetLoadedModelInfoResponse {
  const { modelId } = request;

  const entry = getModelEntry(modelId);
  if (!entry) {
    throw new ModelNotFoundError(modelId);
  }

  if (entry.isDelegated) {
    const info: LoadedModelInfo = {
      modelId: entry.id,
      isDelegated: true,
      handlers: [],
      providerInfo: {
        topic: entry.delegated.topic,
        providerPublicKey: entry.delegated.providerPublicKey,
      },
    };
    return { type: "getLoadedModelInfo", info };
  }

  const plugin = getPlugin(entry.local.modelType);
  if (!plugin) {
    logger.warn(
      `getLoadedModelInfo: no plugin registered for modelType "${entry.local.modelType}" on loaded model "${modelId}"`,
    );
  }

  const info: LoadedModelInfo = {
    modelId: entry.id,
    isDelegated: false,
    modelType: entry.local.modelType,
    handlers: plugin ? Object.keys(plugin.handlers) : [],
    loadedAt: entry.local.loadedAt,
    ...(plugin && { displayName: plugin.displayName }),
    ...(plugin && { addonPackage: plugin.addonPackage }),
    ...(entry.local.name && { name: entry.local.name }),
    ...(entry.local.path && { path: entry.local.path }),
  };

  return { type: "getLoadedModelInfo", info };
}
