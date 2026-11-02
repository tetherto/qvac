import { unlink } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { batchCompletion, SDK_SERVER_ERROR_CODES, type CompletionFinal, type Tool } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { requireModel } from '@/serve/core/plugins/require-model'
import { resolveModelAlias } from '@/serve/core/config/models'
import { assertToolsEnabled, toolsRequested } from '@/serve/lib/assert-tools-enabled'
import { formatToolErrors } from '@/serve/core/completion'
import {
  toSdkChatArgs,
  writeChatImages,
  type ChatCompletionsBody,
  type SdkChatArgs
} from '@/serve/extensions/openai/schemas/chat'
import {
  InvalidResponseFormatError,
  InvalidToolChoiceError,
  UnsupportedImageContentError
} from '@/serve/extensions/openai/schemas/common'
import { sdkToolCallsToOpenai } from '@/serve/extensions/openai/adapters/tool-calls'
import {
  MAX_BATCH_PROMPTS,
  chatBatchBody,
  chatBatchResult,
  type BatchPromptBody,
  type BatchResultItem
} from '@/serve/extensions/default/schemas/chat-batch'

type ChatBatchResult = z.infer<typeof chatBatchResult>
type SdkHistory = Awaited<ReturnType<typeof writeChatImages>>['history']

const description = `
Run several chat prompts through one loaded LLM in a single request, backed by
the SDK's \`batchCompletion()\`. The model decodes them together (continuous
batching), which is faster than the same prompts sent one by one.

\`model\` names a \`serve.models\` alias whose endpoint category is \`chat\`.
The alias needs \`config.parallel\` of 2 or more: up to \`parallel\` prompts
decode at once and the rest queue. The context window (\`ctx_size\`) is shared
between those slots.

\`prompts\` holds 1 to ${MAX_BATCH_PROMPTS} entries. Each takes the
\`/v1/chat/completions\` fields \`messages\`, \`tools\`, \`tool_choice\`,
\`parallel_tool_calls\`, \`response_format\`, \`temperature\`, \`top_p\`, \`seed\`,
\`frequency_penalty\`, \`presence_penalty\`, \`max_tokens\` /
\`max_completion_tokens\` and \`reasoning_budget\`, plus an optional \`id\`.

\`results\` comes back in prompt order, one entry per prompt, each with its
\`id\` (the one given, or one the server assigned), \`index\`, an assistant
\`message\` and \`finish_reason\`. Reasoning goes to \`reasoning_content\`, as on
\`/v1/chat/completions\`. \`stats\` covers the whole batch; the engine does not
break it down per prompt.

The batch succeeds or fails as a whole. The request blocks until every prompt
finishes, and a client disconnect cancels it.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/chat/batch',
    {
      schema: {
        body: chatBatchBody,
        response: {
          200: chatBatchResult,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              missing_model: '`model` is missing',
              invalid_prompts: '`prompts` is missing or empty, or a prompt is malformed',
              too_many_prompts: `\`prompts\` carries more than ${MAX_BATCH_PROMPTS} entries`,
              duplicate_prompt_id: 'Two prompts share an `id`',
              invalid_request: 'The body carries an unknown top-level field',
              invalid_model_type: 'The alias is not a `chat` model',
              batch_not_enabled: "The alias's `config.parallel` is below 2",
              deferred_tools_unsupported: 'A prompt has a tool with `defer_loading`',
              tools_not_enabled: 'A prompt has `tools` and the alias lacks `config.tools`',
              invalid_response_format:
                'A prompt has a bad `response_format`, or one combined with `tools`',
              invalid_tool_choice: "A prompt's `tool_choice` names no declared tool",
              unsupported_image_content: 'An image is not a PNG or JPEG data URL',
              context_length_exceeded: 'The batch does not fit the context window'
            },
            404: { model_not_found: 'Unknown alias' },
            429: {
              request_rejected_by_policy: 'The model is busy and its policy rejects queueing'
            },
            502: { inference_failed: 'Inference failed' },
            503: { model_not_loaded: 'The model is not loaded and lazy loading is disabled' }
          })
        },
        tags: ['Chat Batch'],
        summary: 'Batch chat completion',
        description
      },
      // Body and alias-config errors fail before a model loads.
      preHandler: [rejectDuplicateIds, rejectSingleSlot, requireModel('chat')]
    },
    async (req) => {
      const { prompts } = req.body
      const { sdkModelId, alias, entry } = req.qvacModel!
      assertBatchEnabled(entry.config, alias)

      const prepared = prompts.map((prompt, index) => prepare(req, prompt, index))

      app.qvac.logger.info(`  chat batch model=${alias} prompts=${prompts.length}`)
      return await runBatch(req, sdkModelId, alias, prompts, prepared)
    }
  )
}

// lunte-disable-next-line require-await
async function rejectDuplicateIds(req: FastifyRequest): Promise<void> {
  const { prompts } = req.body as { prompts: BatchPromptBody[] }
  const seen = new Set<string>()
  for (const { id } of prompts) {
    if (id === undefined) continue
    if (seen.has(id)) {
      throw new HttpError(400, 'duplicate_prompt_id', `Prompt id "${id}" appears more than once.`)
    }
    seen.add(id)
  }
}

// lunte-disable-next-line require-await
async function rejectSingleSlot(req: FastifyRequest): Promise<void> {
  const { model } = req.body as { model: string }
  const alias = resolveModelAlias(req.server.qvac.serveConfig, model.trim())
  // Anything else is left to `requireModel`, which reports it.
  if (alias?.endpointCategory === 'chat') assertBatchEnabled(alias.config, alias.alias)
}

// The addon refuses a batch on a single sequence slot (`n_seq_max > 1`).
function assertBatchEnabled(config: Record<string, unknown>, alias: string): void {
  const parallel = Math.floor(Number(config['parallel']))
  if (Number.isFinite(parallel) && parallel >= 2) return
  throw new HttpError(
    400,
    'batch_not_enabled',
    `Model "${alias}" has one decode slot. Set serve.models.${alias}.config.parallel to 2 or more and reload the model.`
  )
}

function prepare(req: FastifyRequest, prompt: BatchPromptBody, index: number): SdkChatArgs {
  const where = `prompts[${index}]`
  const { id: _id, ...fields } = prompt
  let sdk: SdkChatArgs
  try {
    sdk = toSdkChatArgs({ model: req.qvacModel!.alias, ...fields } as ChatCompletionsBody)
  } catch (err) {
    if (err instanceof InvalidResponseFormatError) {
      throw new HttpError(400, 'invalid_response_format', `${where}: ${err.message}`)
    }
    if (err instanceof InvalidToolChoiceError) {
      throw new HttpError(400, 'invalid_tool_choice', `${where}: ${err.message}`)
    }
    if (err instanceof UnsupportedImageContentError) {
      throw new HttpError(400, 'unsupported_image_content', `${where}: ${err.message}`)
    }
    throw err
  }

  assertToolsEnabled(req.qvacModel!.entry.config, sdk.tools, req.qvacModel!.alias)

  // `/v1/chat/completions` answers `tool_search` itself and asks the model
  // again; a batch has one round per prompt, so it cannot.
  if (sdk.tools?.some((tool: Tool) => tool.deferLoading === true)) {
    throw new HttpError(
      400,
      'deferred_tools_unsupported',
      `${where}: tools with "defer_loading" are not supported in a batch.`
    )
  }

  if (sdk.responseFormat && sdk.responseFormat.type !== 'text' && toolsRequested(sdk.tools)) {
    throw new HttpError(
      400,
      'invalid_response_format',
      `${where}: "response_format" (json_object/json_schema) cannot be combined with "tools".`
    )
  }

  return sdk
}

async function runBatch(
  req: FastifyRequest,
  modelId: string,
  model: string,
  prompts: BatchPromptBody[],
  prepared: SdkChatArgs[]
): Promise<ChatBatchResult> {
  const tmpPaths: string[] = []
  try {
    const histories: SdkHistory[] = []
    for (const sdk of prepared) {
      const written = await writeChatImages(sdk.history)
      tmpPaths.push(...written.tmpPaths)
      histories.push(written.history)
    }

    const run = batchCompletion({
      modelId,
      stream: false,
      captureThinking: true,
      prompts: prepared.map((sdk, index) => {
        const id = prompts[index]!.id
        return {
          ...(id !== undefined ? { id } : {}),
          history: histories[index]!,
          ...(sdk.tools !== undefined ? { tools: sdk.tools } : {}),
          ...(sdk.generationParams !== undefined ? { generationParams: sdk.generationParams } : {}),
          ...(sdk.responseFormat !== undefined ? { responseFormat: sdk.responseFormat } : {})
        }
      })
    })
    req.bindCancel(run.requestId)

    let results: Awaited<typeof run.results>
    let stats: Awaited<typeof run.stats>
    try {
      ;[results, stats] = await Promise.all([run.results, run.stats])
    } catch (err) {
      throw toHttpError(err)
    }

    const toolErrors = results.flatMap(({ final }) => final.toolErrors ?? [])
    req.server.qvac.logger.info(
      `  chat batch done prompts=${results.length}${formatToolErrors(toolErrors)}`
    )

    return {
      object: 'chat.batch',
      model,
      results: results.map(({ id, final }, index) => toResultItem(id, index, final)),
      ...(stats !== undefined ? { stats } : {})
    }
  } finally {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
  }
}

// Matched by code: the SDK does not export `CompletionFailedError`. A
// cancellation only follows a client disconnect, so nobody reads its reply.
export function toHttpError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  if (code === SDK_SERVER_ERROR_CODES.CONTEXT_OVERFLOW) {
    return new HttpError(400, 'context_length_exceeded', (err as Error).message)
  }
  if (code === SDK_SERVER_ERROR_CODES.COMPLETION_FAILED) {
    return new HttpError(502, 'inference_failed', 'Inference failed mid-stream.')
  }
  return err
}

export function toResultItem(id: string, index: number, final: CompletionFinal): BatchResultItem {
  const toolCalls = sdkToolCallsToOpenai(final.toolCalls)
  const finishReason =
    toolCalls !== undefined ? 'tool_calls' : final.stopReason === 'length' ? 'length' : 'stop'
  return {
    id,
    index,
    message: {
      role: 'assistant',
      content: toolCalls !== undefined ? null : final.contentText || null,
      ...(final.thinkingText ? { reasoning_content: final.thinkingText } : {}),
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {})
    },
    finish_reason: finishReason
  }
}

export default plugin
