import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { unregisterModel } from "@/server/bare/registry/model-registry";
import { unregisterAllLoggingStreams } from "@/server/bare/registry/logging-stream-registry";
import { clearFinetuneRuntimeState } from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import { unregisterAddonLogger, getServerLogger } from "@/logging";
import { type UnloadModelParams, unloadModelParamsSchema } from "@/schemas";
import { ModelNotLoadedError } from "@/utils/errors-server";
import { detectShardedModel } from "@/server/utils";

const logger = getServerLogger();

export async function unloadModel(params: UnloadModelParams) {
  const { modelId, clearStorage } = unloadModelParamsSchema.parse(params);
  const entry = unregisterModel(modelId);

  if (!entry) {
    throw new ModelNotLoadedError(modelId);
  }

  clearFinetuneRuntimeState(modelId);

  if (entry.local?.loader) {
    await entry.local.loader.close();
  }

  if (entry.local?.model && entry.local.model.unload) {
    await entry.local.model.unload();
  }
  if (clearStorage && entry.local?.path) {
    const modelPath = entry.local.path;
    const modelFileName = path.basename(modelPath);
    const shardInfo = detectShardedModel(modelFileName);

    if (shardInfo.isSharded) {
      // Delete entire shard directory
      const shardDir = path.dirname(modelPath);
      await fsPromises.rm(shardDir, { recursive: true, force: true });
      logger.info(`Sharded model storage cleared: ${shardDir}`);
    } else {
      // Delete single file
      await fsPromises.rm(modelPath, { recursive: true, force: true });
      logger.info(`Model storage cleared: ${modelPath}`);
    }
  }

  unregisterAddonLogger(modelId);
  unregisterAllLoggingStreams(modelId);

  logger.info(`Model ${modelId} unloaded`);
}
