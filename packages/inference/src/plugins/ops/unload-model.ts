import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { unregisterModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { unregisterAllLoggingStreams } from '@/runtime/logging-stream-registry'
import { clearFinetuneRuntimeState } from '@/plugins/builtin/llamacpp-completion/ops/finetune'
import { unregisterAddonLogger, getEngineLogger } from '@/logging/index'
import { type UnloadModelParams, unloadModelParamsSchema } from '@/schemas/index'
import { ModelNotLoadedError } from '@/errors/index'
import { detectShardedModel } from '@/utils/index'
import { getClearStorageTarget } from '@/utils/cache/paths'

const logger = getEngineLogger()

export async function unloadModel(params: UnloadModelParams) {
  const { modelId, clearStorage } = unloadModelParamsSchema.parse(params)
  const entry = unregisterModel(modelId)

  if (!entry) {
    throw new ModelNotLoadedError(modelId)
  }

  // Cancel and drain the model's requests, then tear down under the admission
  // barrier so nothing goes active against a model being freed. The barrier is
  // lifted for us when this resolves.
  await getRequestRegistry().withModelDraining(modelId, async () => {
    clearFinetuneRuntimeState(modelId)

    if (entry.local.model.unload) {
      await entry.local.model.unload()
    }

    if (clearStorage && entry.local.path) {
      const modelPath = entry.local.path
      const modelFileName = path.basename(modelPath)
      const shardInfo = detectShardedModel(modelFileName)

      if (shardInfo.isSharded) {
        const shardDir = path.dirname(modelPath)
        await fsPromises.rm(shardDir, { recursive: true, force: true })
        logger.info(`Sharded model storage cleared: ${shardDir}`)
      } else {
        const target = getClearStorageTarget(modelPath)
        await fsPromises.rm(target.path, {
          recursive: target.kind === 'directory',
          force: true
        })
        logger.info(`Model storage cleared (${target.kind}): ${target.path}`)
      }
    }

    unregisterAddonLogger(modelId)
    unregisterAllLoggingStreams(modelId)

    logger.info(`Model ${modelId} unloaded`)
  })
}
