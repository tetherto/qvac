import { LayaDecisions, type LayaConfig } from '@qvac/embed-llamacpp'
import {
  decisionsConfigSchema,
  type DecisionsConfig,
  type CreateModelParams
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { ModelType } from '@/schemas/model-types'
import path from 'bare-path'
import { detectShardedModel, generateShardFilenames } from '@/utils/shard-utils'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

export function transformDecisionsConfig(config: DecisionsConfig): LayaConfig {
  return {
    ...Object.fromEntries(
      Object.entries(config)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ),
    device: config.device
  }
}

export function decisionsModelFiles(modelPath: string): string[] {
  const filename = path.basename(modelPath)
  const info = detectShardedModel(filename)
  if (!info.isSharded) return [modelPath]
  const directory = path.dirname(modelPath)
  return [
    path.join(directory, `${info.baseFilename}.tensors.txt`),
    ...generateShardFilenames(filename).map((shard) => path.join(directory, shard))
  ]
}

export function createDecisionsModel(params: CreateModelParams): LayaDecisions {
  const config = { ...transformDecisionsConfig(decisionsConfigSchema.parse(params.modelConfig)) }
  if (isMobile()) stripMultiGpuKeys(config)
  const logger = createStreamLogger(params.modelId, ModelType.llamacppDecisions)
  registerAddonLogger(params.modelId, ModelType.llamacppDecisions, logger)
  return new LayaDecisions({
    files: { model: decisionsModelFiles(params.modelPath) },
    config,
    logger
  })
}
