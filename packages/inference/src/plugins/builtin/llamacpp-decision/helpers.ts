import type {
  LayaConfig,
  LayaQuestion as NativeLayaQuestion,
  LayaRequest as NativeLayaRequest
} from '@qvac/embed-llamacpp'
import path from 'bare-path'
import type { DecisionConfig, LayaQuestion, LayaRequest } from '@/schemas/index'
import { detectShardedModel, generateShardFilenames } from '@/utils/shard-utils'

export function transformDecisionConfig(config: DecisionConfig): LayaConfig {
  return {
    ...Object.fromEntries(
      Object.entries(config)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ),
    device: config.device
  }
}

function transformDecisionQuestion(question: LayaQuestion): NativeLayaQuestion {
  const base = {
    instructions: question.instructions,
    ...(question.option_order === undefined ? {} : { option_order: question.option_order })
  }
  if (question.type === 'choice') {
    return { ...base, type: 'choice', criteria: question.criteria }
  }
  if (question.type === 'score') {
    return { ...base, type: 'score', criteria: question.criteria }
  }
  const criteria = question.criteria
  return {
    ...base,
    type: 'noul',
    ...(criteria === undefined
      ? {}
      : {
          criteria:
            criteria === null
              ? null
              : {
                  ...(criteria.true === undefined ? {} : { true: criteria.true }),
                  ...(criteria.false === undefined ? {} : { false: criteria.false })
                }
        }),
    ...(question.labels === undefined ? {} : { labels: question.labels })
  }
}

export function transformDecisionRequest(request: LayaRequest): NativeLayaRequest {
  return {
    ...('states' in request ? { states: request.states } : { state: request.state }),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        transformDecisionQuestion(question)
      ])
    ),
    ...(request.max_len === undefined ? {} : { max_len: request.max_len }),
    ...(request.head_max_len === undefined ? {} : { head_max_len: request.head_max_len })
  }
}

export function decisionModelFiles(modelPath: string): string[] {
  const filename = path.basename(modelPath)
  const info = detectShardedModel(filename)
  if (!info.isSharded) return [modelPath]
  const directory = path.dirname(modelPath)
  return [
    path.join(directory, `${info.baseFilename}.tensors.txt`),
    ...generateShardFilenames(filename).map((shard) => path.join(directory, shard))
  ]
}
