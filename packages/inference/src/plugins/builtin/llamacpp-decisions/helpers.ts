import type { LayaConfig } from '@qvac/embed-llamacpp'
import path from 'bare-path'
import type { DecisionsConfig } from '@/schemas/index'
import { detectShardedModel, generateShardFilenames } from '@/utils/shard-utils'

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
