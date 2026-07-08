import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { unregisterModel } from '../state/model-registry'
import { unregisterAllLoggingStreams } from '../state/logging-stream-registry'
import { clearFinetuneRuntimeState } from '../../plugins/builtin/llamacpp-completion/ops/finetune'
import { unregisterAddonLogger, getServerLogger } from '../../logging'
import { type UnloadModelParams, unloadModelParamsSchema } from '../../schemas'
import { ModelNotLoadedError } from '../../errors'
import { detectShardedModel } from '../utils'
import { getClearStorageTarget } from '../utils/cache/paths'

const logger = getServerLogger()

export async function unloadModel(params: UnloadModelParams) {
  const { modelId, clearStorage } = unloadModelParamsSchema.parse(params)
  const entry = unregisterModel(modelId)

  if (!entry) {
    throw new ModelNotLoadedError(modelId)
  }

  clearFinetuneRuntimeState(modelId)

  if (!entry.isDelegated) {
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
  }

  unregisterAddonLogger(modelId)
  unregisterAllLoggingStreams(modelId)

  logger.info(`Model ${modelId} unloaded`)
}
