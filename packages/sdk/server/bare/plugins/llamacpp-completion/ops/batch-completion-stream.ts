import type { AbortSignal } from 'bare-abort-controller'
import type { BatchCompletionStreamPrompt, CompletionStats, ResponseFormat, Tool } from '@/schemas'
import { TOOLS_MODE } from '@/schemas/tools'
import { getModel, getModelConfig, type AnyModel } from '@/server/bare/registry/model-registry'
import type { DisposableScope } from '@/server/bare/runtime/disposable-scope'
import type { Logger } from '@/logging/types'
import { getServerLogger } from '@/logging'
import { nowMs } from '@/profiling'
import { buildStreamResult } from '@/profiling/model-execution'
import type { LlmStats } from '@/server/bare/types/addon-responses'
import { getResponseFormatJsonSchema } from '@/server/utils/response-format'
import {
  transformMessages,
  type CompletionGenerationParams
} from '@/server/bare/plugins/llamacpp-completion/ops/completion-stream'
import { normalizeCompletionStats } from '@/server/bare/plugins/llamacpp-completion/ops/completion-stats'
import { appendToolsToHistory, prependToolsToHistory } from '@/server/utils/tool-integration'

const logger = getServerLogger()

type AddonBatchOutputChunk = {
  id: string
  chunk: string
}

type BatchCompletionRunOptions = {
  generationParams: CompletionGenerationParams
}

type HistoryMessage = {
  role: string
  content: string
  attachments?: { path: string }[] | undefined
}

type AddonBatchMessage = ReturnType<typeof transformMessages>[number]

type AddonBatchPrompt = {
  id?: string
  prompt: AddonBatchMessage[]
  runOptions?: BatchCompletionRunOptions
}

type AddonBatchResponse = {
  ids: string[]
  stats?: LlmStats
  iterate(): AsyncIterable<unknown>
  await(): Promise<BatchModelResult[]>
}

type BatchModelEvent = { type: 'ids'; ids: string[] } | { type: 'token'; id: string; token: string }

type BatchModelResult = {
  id: string
  output: string
}

type BatchModelStreamResult = {
  ids: string[]
  results: BatchModelResult[]
  modelExecutionMs: number
  stats?: CompletionStats
}

type BatchPromptRenderOptions = {
  toolsEnabled: boolean
  toolsMode?: string | undefined
}

function runBatchModel(model: AnyModel, prompts: AddonBatchPrompt[]) {
  const run = model.run.bind(model) as unknown as (
    prompts: AddonBatchPrompt[]
  ) => Promise<AddonBatchResponse>

  return run(prompts)
}

function mergeGenerationParams(
  generationParams: CompletionGenerationParams | undefined,
  responseFormat: ResponseFormat | undefined
) {
  if (!responseFormat) return generationParams

  const jsonSchema = getResponseFormatJsonSchema(responseFormat)
  if (jsonSchema === undefined) return generationParams

  return {
    ...(generationParams ?? {}),
    json_schema: jsonSchema
  }
}

function renderPromptHistory(
  prompt: BatchCompletionStreamPrompt,
  options: BatchPromptRenderOptions
) {
  const tools =
    options.toolsEnabled && prompt.tools && prompt.tools.length > 0 ? prompt.tools : undefined
  let historyWithTools: Array<HistoryMessage | Tool> = prompt.history

  if (tools) {
    historyWithTools =
      options.toolsMode === TOOLS_MODE.dynamic
        ? appendToolsToHistory(prompt.history, tools)
        : prependToolsToHistory(prompt.history, tools)
  }

  // Uses the same attachment expansion as single completion: each SDK
  // attachment becomes an addon `type: "media"` message before the text turn.
  return transformMessages(historyWithTools)
}

function buildBatchPrompt(
  prompt: BatchCompletionStreamPrompt,
  options: BatchPromptRenderOptions
): AddonBatchPrompt {
  const mergedGenerationParams = mergeGenerationParams(
    prompt.generationParams,
    prompt.responseFormat
  )
  return {
    ...(prompt.id !== undefined && { id: prompt.id }),
    prompt: renderPromptHistory(prompt, options),
    ...(mergedGenerationParams && {
      runOptions: { generationParams: mergedGenerationParams }
    })
  }
}

function isBatchOutputChunk(output: unknown): output is AddonBatchOutputChunk {
  return (
    output !== null &&
    typeof output === 'object' &&
    'id' in output &&
    'chunk' in output &&
    typeof output.id === 'string' &&
    typeof output.chunk === 'string'
  )
}

export async function* batchCompletion(
  params: {
    modelId: string
    prompts: BatchCompletionStreamPrompt[]
  },
  opts: {
    signal: AbortSignal
    scope: DisposableScope
    logger?: Logger
  }
): AsyncGenerator<BatchModelEvent, BatchModelStreamResult, unknown> {
  const { modelId, prompts } = params
  const { signal, scope } = opts
  const requestLogger = opts.logger ?? logger
  const model = getModel(modelId)
  const modelConfig = getModelConfig(modelId)
  const renderOptions: BatchPromptRenderOptions = {
    toolsEnabled: (modelConfig as { tools?: boolean }).tools === true,
    toolsMode: (modelConfig as { toolsMode?: string }).toolsMode
  }

  const onAbort = () => {
    const addon = model.addon
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during batch abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  scope.defer(() => {
    signal.removeEventListener('abort', onAbort)
  })

  const addonPrompts = prompts.map((prompt) => buildBatchPrompt(prompt, renderOptions))
  const modelStart = nowMs()
  const response = await runBatchModel(model, addonPrompts)
  const ids = response.ids

  yield { type: 'ids', ids }

  for await (const output of response.iterate()) {
    if (!isBatchOutputChunk(output)) continue
    yield { type: 'token', id: output.id, token: output.chunk }
  }

  const results = await response.await()
  const modelExecutionMs = nowMs() - modelStart
  const stats = normalizeCompletionStats(response.stats)

  return {
    ...buildStreamResult(modelExecutionMs, stats),
    ids,
    results
  }
}
