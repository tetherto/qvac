import type { UnloadModelRequest, UnloadModelResponse } from "@/schemas";
import { getModelEntry, unregisterModel } from "@/server/bare/registry/model-registry";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { send } from "@/server/rpc/delegate-transport";
import { hasActiveProviders } from "@/server/bare/hyperswarm";
import { getRegistryStats } from "@/server/bare/registry/model-registry";
import { ModelIsDelegatedError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleUnloadModelDelegated(
  request: UnloadModelRequest,
): Promise<UnloadModelResponse> {
  const entry = getModelEntry(request.modelId);

  if (!entry?.isDelegated || !entry.delegated) {
    throw new ModelIsDelegatedError(request.modelId);
  }

  const { topic, providerPublicKey, timeout, healthCheckTimeout } = entry.delegated;

  unregisterModel(request.modelId);

  try {
    logger.info(
      `Sending delegated unload for model ${request.modelId} to provider: ${providerPublicKey}`,
    );

    const rpc = await getRPC(topic, providerPublicKey, { timeout, healthCheckTimeout });
    await send(
      { type: "unloadModel" as const, modelId: request.modelId, clearStorage: false },
      rpc,
      { timeout, peerKey: providerPublicKey },
    );

    logger.info(`Delegated model ${request.modelId} unloaded on provider`);
  } catch (error) {
    logger.error(
      `Failed to unload delegated model ${request.modelId} on provider:`,
      error,
    );
  }

  const stats = getRegistryStats();

  return {
    type: "unloadModel",
    success: true,
    hasActiveModels: stats.totalModels > 0,
    hasActiveProviders: hasActiveProviders(),
  };
}
