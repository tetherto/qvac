import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { completion } from '@qvac/sdk'
import type { Tool } from '@qvac/sdk'
import { HttpError, errorType } from '@/serve/lib/http-error'
import { endSSE, initSSE, sendSSE } from '@/serve/lib/sse'
import { sdkErrorAsHttp } from '@/serve/core/plugins/error-handler'
import { requireModel } from '@/serve/core/plugins/require-model'
import { logUnsupported } from '@/serve/core/plugins/log-unsupported'
import { assertToolsEnabled, toolsRequested } from '@/serve/lib/assert-tools-enabled'
import {
  responsesBody,
  responsesIdParams,
  responsesListInputItemsQuery,
  RESPONSES_UNSUPPORTED_PARAMS,
  historyPrefixFromStoredResponse,
  InvalidResponsesBackgroundError,
  InvalidResponsesConversationError,
  InvalidResponsesToolsError,
  toSdkResponsesArgs,
  type ResponsesHistoryItem
} from '@/serve/extensions/openai/schemas/responses'
import {
  InvalidResponseFormatError,
  InvalidToolChoiceError,
  hoistInstructions,
  nameToolResults,
  type GenerationParams,
  type ResponseFormat
} from '@/serve/extensions/openai/schemas/common'
import { responseId as allocResponseId } from '@/serve/extensions/openai/adapters/responses-shape'
import { RESPONSES_VOLATILE_STUB } from '@/serve/extensions/openai/adapters/responses-store'
import {
  writeBlockingResponse,
  writeStreamingResponse,
  type ResponsesHandlerParams,
  type RunTurn
} from '@/serve/extensions/openai/adapters/response-writers'
import { openaiState } from '@/serve/extensions/openai/state'

const VOLATILE_HEADER = 'X-QVAC-Stub'

interface HandlerParams {
  sdkModelId: string
  modelAlias: string
  history: ResponsesHistoryItem[]
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  rid: string
  createdAtSec: number
  storeEnabled: boolean
  inputItems: unknown[]
  metadata: Record<string, unknown> | undefined
  temperature: number | undefined
  topP: number | undefined
  maxOutputTokens: number | undefined
  parallelToolCalls: boolean
  previousResponseId: string | null
}

const descriptions = {
  create: `
OpenAI Responses API — stateful chat completion that can be retrieved /
deleted later via the returned \`id\`.

**Storage is in-memory only.** Every \`/v1/responses*\` reply carries
\`X-QVAC-Stub: responses-volatile\`. IDs expire on process restart (60-minute
TTL, 256 max entries).

**Conversation chaining** via \`previous_response_id\` walks the stored chain
(up to 32 turns) and prepends prior turns into the SDK history. A missing or
expired \`previous_response_id\` returns \`404 previous_response_not_found\`.

**\`store: false\`** opts out of storage — the response is returned but not
addressable via GET / DELETE / input_items.

**Rejections**:
- \`conversation\` → \`400 conversation_not_supported\` (Conversation persistence not implemented)
- \`background: true\` → \`400 background_not_supported\` (only synchronous responses)
- structured output (\`json_object\`/\`json_schema\`) combined with non-empty \`tools\` → \`400 invalid_response_format\`
- \`tools\` on a model loaded without \`config.tools: true\` → \`400 tools_not_enabled\`
- \`tool_choice\` demanding a tool with no matching \`tools\` entry → \`400 invalid_tool_choice\`

**Tools**: \`function\` tools, and the functions inside a \`namespace\` tool (the
model sees them as \`<namespace>__<name>\`; calls come back with \`name\` and
\`namespace\` split again; a malformed \`namespace\` → \`400 invalid_tools\`). Built-in tool types (\`web_search\`,
\`file_search\`, …) are left out of the request and logged.

**\`tool_choice\`**: \`"auto"\` (default), \`"none"\`, \`"required"\`, or
\`{ type: 'function', name }\` to force one tool. \`required\` and a named tool
constrain generation with the chat template's tool grammar.

**\`parallel_tool_calls\`**: \`true\` (default) lets one response carry several
tool calls; \`false\` limits it to one.

**Streaming** (\`stream: true\`) emits the OpenAI Responses SSE event sequence
(\`response.created\` → \`response.output_text.delta\` … → \`response.completed\`)
and terminates **without** a \`[DONE]\` sentinel (per the spec).
`.trim(),
  getById:
    'Fetch a previously-created response. **In-memory only** — 404 once expired or after a restart. Reply carries `X-QVAC-Stub: responses-volatile`.',
  deleteById:
    'Remove a stored response from memory. Subsequent chains via `previous_response_id` that referenced this one will return `404 previous_response_not_found`.',
  listInputItems:
    "Paginate over a stored response's normalized input items (the request that produced it). `limit` and `after` work as on the OpenAI cursor-paginated endpoints."
}

// Tag every fastify-managed reply for these routes with the volatile-store
// stub header. Attached per-route (not as a plugin-wide `onSend` keyed on URL
// prefix), so future siblings like `/v1/responses_export` can't pick it up
// by accident. Raw replies (POST streaming via initSSE, POST blocking
// via writeBlockingResponse) inject the header themselves
// when writing raw response headers.
// lunte-disable-next-line require-await
async function markVolatile(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header(VOLATILE_HEADER, RESPONSES_VOLATILE_STUB)
}

// A Responses stream reports a failure as `response.failed`. Codex reads the
// error code from it; any other frame looks like a dropped connection to retry.
function sendResponseFailed(
  reply: FastifyReply,
  params: HandlerParams,
  err: unknown,
  logger: { error: (message: string) => void }
): void {
  // Like the shared error handler: expected SDK input errors are not logged,
  // everything else (including a 502 inference_failed) is.
  const sdkHttpError = sdkErrorAsHttp(err)
  const httpError = sdkHttpError ?? (err instanceof HttpError ? err : undefined)
  if (!sdkHttpError) {
    logger.error(`streaming_error POST /v1/responses\n${(err as Error)?.stack ?? String(err)}`)
  }
  sendSSE(reply.raw, {
    type: 'response.failed',
    response: {
      id: params.rid,
      object: 'response',
      created_at: params.createdAtSec,
      status: 'failed',
      model: params.modelAlias,
      output: [],
      error: {
        type: httpError ? errorType(httpError.status) : 'server_error',
        code: httpError?.code ?? 'internal_error',
        message: httpError?.message ?? 'An internal error occurred.'
      }
    }
  })
  endSSE(reply.raw, { sentinel: false })
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const openai = openaiState(app.qvac)

  app.post(
    '/v1/responses',
    {
      schema: {
        body: responsesBody,
        tags: ['Responses'],
        summary: 'Create a model response',
        description: descriptions.create
      },
      config: { unsupportedParams: [...RESPONSES_UNSUPPORTED_PARAMS], sseSentinel: false },
      onRequest: markVolatile,
      preHandler: [requireModel('chat'), logUnsupported]
    },
    async (req, reply) => {
      const ctx = app.qvac

      let sdk
      try {
        sdk = toSdkResponsesArgs(req.body)
      } catch (err) {
        if (err instanceof InvalidResponsesToolsError) {
          throw new HttpError(400, 'invalid_tools', err.message)
        }
        if (err instanceof InvalidResponsesConversationError) {
          throw new HttpError(400, 'conversation_not_supported', err.message)
        }
        if (err instanceof InvalidResponsesBackgroundError) {
          throw new HttpError(400, 'background_not_supported', err.message)
        }
        if (err instanceof InvalidResponseFormatError) {
          throw new HttpError(400, 'invalid_response_format', err.message)
        }
        if (err instanceof InvalidToolChoiceError) {
          throw new HttpError(400, 'invalid_tool_choice', err.message)
        }
        throw err
      }

      if (sdk.skippedToolTypes.length > 0) {
        ctx.logger.info(`Ignoring unsupported tool types: ${sdk.skippedToolTypes.join(', ')}`)
      }

      assertToolsEnabled(req.qvacModel!.entry.config, sdk.tools, req.qvacModel!.alias)

      if (sdk.responseFormat && sdk.responseFormat.type !== 'text' && toolsRequested(sdk.tools)) {
        throw new HttpError(
          400,
          'invalid_response_format',
          'Structured output (json_object/json_schema) cannot be combined with "tools".'
        )
      }

      let history = sdk.history
      if (sdk.previousResponseId) {
        const prev = openai.responsesStore.get(sdk.previousResponseId)
        if (!prev) {
          throw new HttpError(
            404,
            'previous_response_not_found',
            `No response found for previous_response_id "${sdk.previousResponseId}".`
          )
        }
        const prefix = historyPrefixFromStoredResponse(prev, (id) => openai.responsesStore.get(id))
        // A result in this request can answer a call from the stored turns, and
        // the stored turns can carry instructions of their own.
        history = nameToolResults(hoistInstructions([...prefix, ...history]))
      }

      const params: HandlerParams = {
        sdkModelId: req.qvacModel!.sdkModelId,
        modelAlias: req.qvacModel!.alias,
        history,
        tools: sdk.tools,
        generationParams: sdk.generationParams,
        responseFormat: sdk.responseFormat,
        rid: allocResponseId(),
        createdAtSec: Math.floor(Date.now() / 1000),
        storeEnabled: sdk.storeEnabled,
        inputItems: sdk.inputItems,
        metadata: sdk.metadata,
        temperature: sdk.temperature,
        topP: sdk.topP,
        maxOutputTokens: sdk.maxOutputTokens,
        parallelToolCalls: sdk.parallelToolCalls,
        previousResponseId: sdk.previousResponseId ?? null
      }
      const streaming = sdk.stream

      ctx.logger.info(
        `  responses model=${params.modelAlias} stream=${streaming}` +
          `${params.tools ? ` tools=${params.tools.length}` : ''}` +
          `${params.generationParams ? ` genParams=${JSON.stringify(params.generationParams)}` : ''}` +
          `${params.responseFormat ? ` responseFormat=${params.responseFormat.type}` : ''}` +
          `${params.previousResponseId ? ` prev=${params.previousResponseId}` : ''}`
      )

      const writerParams: ResponsesHandlerParams = {
        ctx: { logger: ctx.logger, responsesStore: openai.responsesStore },
        sdkModelId: params.sdkModelId,
        history: params.history,
        ...(params.tools !== undefined ? { tools: params.tools } : {}),
        toolNamespaces: sdk.toolNamespaces,
        ...(params.generationParams !== undefined
          ? { generationParams: params.generationParams }
          : {}),
        ...(params.responseFormat !== undefined ? { responseFormat: params.responseFormat } : {}),
        modelAlias: params.modelAlias,
        rid: params.rid,
        createdAtSec: params.createdAtSec,
        storeEnabled: params.storeEnabled,
        inputItems: params.inputItems,
        metadata: params.metadata,
        temperature: params.temperature,
        topP: params.topP,
        maxOutputTokens: params.maxOutputTokens,
        parallelToolCalls: params.parallelToolCalls,
        previousResponseId: params.previousResponseId
      }

      const completionFn = openaiState(req.server.qvac).completionOverride ?? completion

      // One turn per call: the writers re-run it with the search results
      // appended when the model asks for `tool_search`.
      const runTurn = (stream: boolean): RunTurn => {
        return (history) => {
          const result = completionFn({
            modelId: params.sdkModelId,
            history,
            stream,
            ...(params.tools !== undefined ? { tools: params.tools } : {}),
            ...(params.generationParams !== undefined
              ? { generationParams: params.generationParams }
              : {}),
            ...(params.responseFormat !== undefined
              ? { responseFormat: params.responseFormat }
              : {})
          })
          req.bindCancel(result.requestId)
          return result
        }
      }

      if (streaming) {
        initSSE(reply, { [VOLATILE_HEADER]: RESPONSES_VOLATILE_STUB })
        try {
          await writeStreamingResponse(reply.raw, writerParams, runTurn(true))
        } catch (err) {
          if (reply.raw.destroyed || reply.raw.writableEnded) throw err
          sendResponseFailed(reply, params, err, ctx.logger)
        }
      } else {
        // The writer ends the raw response on success. Keep the reply managed
        // until then so inference errors before headers can produce HTTP errors.
        await writeBlockingResponse(reply.raw, writerParams, runTurn(false))
      }
    }
  )

  app.get(
    '/v1/responses/:id',
    {
      schema: {
        params: responsesIdParams,
        tags: ['Responses'],
        summary: 'Retrieve a stored response',
        description: descriptions.getById
      },
      onRequest: markVolatile
    },
    // lunte-disable-next-line require-await
    async (req, reply) => {
      const rec = openai.responsesStore.get(req.params.id)
      if (!rec) {
        throw new HttpError(
          404,
          'response_not_found',
          `Response "${req.params.id}" not found or expired.`
        )
      }
      reply.send(rec.responseObject)
    }
  )

  app.delete(
    '/v1/responses/:id',
    {
      schema: {
        params: responsesIdParams,
        tags: ['Responses'],
        summary: 'Delete a stored response',
        description: descriptions.deleteById
      },
      onRequest: markVolatile
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const ok = openai.responsesStore.delete(req.params.id)
      if (!ok) {
        throw new HttpError(
          404,
          'response_not_found',
          `Response "${req.params.id}" not found or expired.`
        )
      }
      return { id: req.params.id, object: 'response.deleted' as const, deleted: true }
    }
  )

  app.get(
    '/v1/responses/:id/input_items',
    {
      schema: {
        params: responsesIdParams,
        querystring: responsesListInputItemsQuery,
        tags: ['Responses'],
        summary: 'List input items for a stored response',
        description: descriptions.listInputItems
      },
      onRequest: markVolatile
    },
    // lunte-disable-next-line require-await
    async (req, reply) => {
      const opts: { limit?: number; after?: string } = {}
      if (req.query.limit !== undefined) opts.limit = req.query.limit
      if (req.query.after !== undefined) opts.after = req.query.after
      const page =
        opts.limit !== undefined || opts.after !== undefined
          ? openai.responsesStore.listInputItems(req.params.id, opts)
          : openai.responsesStore.listInputItems(req.params.id)
      if (!page) {
        throw new HttpError(
          404,
          'response_not_found',
          `Response "${req.params.id}" not found or expired.`
        )
      }
      reply.send(page)
    }
  )
}
export default plugin
