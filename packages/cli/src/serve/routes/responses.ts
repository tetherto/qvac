import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { completion } from '@qvac/sdk'
import type { Tool } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { initSSE } from '../lib/sse.js'
import { requireModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import {
  responsesBody,
  responsesIdParams,
  responsesListInputItemsQuery,
  RESPONSES_UNSUPPORTED_PARAMS
} from '../schemas/responses.js'
import { InvalidResponseFormatError, type GenerationParams, type ResponseFormat } from '../schemas/common.js'
import {
  historyPrefixFromStoredResponse,
  InvalidResponsesBackgroundError,
  InvalidResponsesConversationError,
  toSdkResponsesArgs,
  UnsupportedToolTypeError
} from '../schemas/responses.js'
import { responseId as allocResponseId } from '../adapters/openai/responses-shape.js'
import { RESPONSES_VOLATILE_STUB } from '../adapters/openai/responses-store.js'
import { writeBlockingResponse, writeStreamingResponse, type ResponsesHandlerParams } from '../adapters/openai/response-writers.js'

const VOLATILE_HEADER = 'X-QVAC-Stub'

interface HandlerParams {
  sdkModelId: string
  modelAlias: string
  history: Array<{ role: string; content: string }>
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
- \`tools[].type\` other than \`function\` (e.g. \`web_search\`, \`file_search\`, \`code_interpreter\`) → \`400 invalid_tool_type\`
- structured output (\`json_object\`/\`json_schema\`) combined with non-empty \`tools\` → \`400 invalid_response_format\`

**Streaming** (\`stream: true\`) emits the OpenAI Responses SSE event sequence
(\`response.created\` → \`response.output_text.delta\` … → \`response.completed\`)
and terminates **without** a \`[DONE]\` sentinel (per the spec).
`.trim(),
  getById: 'Fetch a previously-created response. **In-memory only** — 404 once expired or after a restart. Reply carries `X-QVAC-Stub: responses-volatile`.',
  deleteById: 'Remove a stored response from memory. Subsequent chains via `previous_response_id` that referenced this one will return `404 previous_response_not_found`.',
  listInputItems: 'Paginate over a stored response\'s normalized input items (the request that produced it). `limit` and `after` work as on the OpenAI cursor-paginated endpoints.'
}

// Tag every fastify-managed reply for these routes with the volatile-store
// stub header. Attached per-route (not as a plugin-wide `onSend` keyed on URL
// prefix), so future siblings like `/v1/responses_export` can't pick it up
// by accident. Hijacked replies (POST streaming via initSSE, POST blocking
// via writeBlockingResponse) bypass fastify and inject the header themselves
// when writing raw response headers.
async function markVolatile (_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header(VOLATILE_HEADER, RESPONSES_VOLATILE_STUB)
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/responses', {
    schema: {
      body: responsesBody,
      tags: ['Responses'],
      summary: 'Create a model response',
      description: descriptions.create
    },
    config: { unsupportedParams: [...RESPONSES_UNSUPPORTED_PARAMS], sseSentinel: false },
    onRequest: markVolatile,
    preHandler: [requireModel('chat'), logUnsupported]
  }, async (req, reply) => {
    const ctx = app.qvac

    let sdk
    try {
      sdk = toSdkResponsesArgs(req.body)
    } catch (err) {
      if (err instanceof InvalidResponsesConversationError) throw new HttpError(400, 'conversation_not_supported', err.message)
      if (err instanceof InvalidResponsesBackgroundError) throw new HttpError(400, 'background_not_supported', err.message)
      if (err instanceof UnsupportedToolTypeError) throw new HttpError(400, 'invalid_tool_type', err.message)
      if (err instanceof InvalidResponseFormatError) throw new HttpError(400, 'invalid_response_format', err.message)
      throw err
    }

    if (sdk.responseFormat && sdk.responseFormat.type !== 'text' && sdk.tools && sdk.tools.length > 0) {
      throw new HttpError(
        400,
        'invalid_response_format',
        'Structured output (json_object/json_schema) cannot be combined with "tools".'
      )
    }

    let history = sdk.history
    if (sdk.previousResponseId) {
      const prev = ctx.responsesStore.get(sdk.previousResponseId)
      if (!prev) {
        throw new HttpError(404, 'previous_response_not_found', `No response found for previous_response_id "${sdk.previousResponseId}".`)
      }
      const prefix = historyPrefixFromStoredResponse(prev, (id) => ctx.responsesStore.get(id))
      history = [...prefix, ...history]
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
      ctx: { logger: ctx.logger, responsesStore: ctx.responsesStore },
      sdkModelId: params.sdkModelId,
      history: params.history,
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.generationParams !== undefined ? { generationParams: params.generationParams } : {}),
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

    if (streaming) {
      const result = completion({
        modelId: params.sdkModelId,
        history: params.history,
        stream: true,
        ...(params.tools !== undefined ? { tools: params.tools } : {}),
        ...(params.generationParams !== undefined ? { generationParams: params.generationParams } : {}),
        ...(params.responseFormat !== undefined ? { responseFormat: params.responseFormat } : {})
      })
      req.bindCancel(result.requestId)
      initSSE(reply, { [VOLATILE_HEADER]: RESPONSES_VOLATILE_STUB })
      await writeStreamingResponse(reply.raw, writerParams, result)
    } else {
      const result = completion({
        modelId: params.sdkModelId,
        history: params.history,
        stream: false,
        ...(params.tools !== undefined ? { tools: params.tools } : {}),
        ...(params.generationParams !== undefined ? { generationParams: params.generationParams } : {}),
        ...(params.responseFormat !== undefined ? { responseFormat: params.responseFormat } : {})
      })
      req.bindCancel(result.requestId)
      reply.hijack()
      await writeBlockingResponse(reply.raw, writerParams, result)
    }
  })

  app.get('/v1/responses/:id', {
    schema: {
      params: responsesIdParams,
      tags: ['Responses'],
      summary: 'Retrieve a stored response',
      description: descriptions.getById
    },
    onRequest: markVolatile
  }, async (req, reply) => {
    const rec = app.qvac.responsesStore.get(req.params.id)
    if (!rec) throw new HttpError(404, 'response_not_found', `Response "${req.params.id}" not found or expired.`)
    reply.send(rec.responseObject)
  })

  app.delete('/v1/responses/:id', {
    schema: {
      params: responsesIdParams,
      tags: ['Responses'],
      summary: 'Delete a stored response',
      description: descriptions.deleteById
    },
    onRequest: markVolatile
  }, async (req) => {
    const ok = app.qvac.responsesStore.delete(req.params.id)
    if (!ok) throw new HttpError(404, 'response_not_found', `Response "${req.params.id}" not found or expired.`)
    return { id: req.params.id, object: 'response.deleted' as const, deleted: true }
  })

  app.get('/v1/responses/:id/input_items', {
    schema: {
      params: responsesIdParams,
      querystring: responsesListInputItemsQuery,
      tags: ['Responses'],
      summary: 'List input items for a stored response',
      description: descriptions.listInputItems
    },
    onRequest: markVolatile
  }, async (req, reply) => {
    const opts: { limit?: number; after?: string } = {}
    if (req.query.limit !== undefined) opts.limit = req.query.limit
    if (req.query.after !== undefined) opts.after = req.query.after
    const page = (opts.limit !== undefined || opts.after !== undefined)
      ? app.qvac.responsesStore.listInputItems(req.params.id, opts)
      : app.qvac.responsesStore.listInputItems(req.params.id)
    if (!page) {
      throw new HttpError(404, 'response_not_found', `Response "${req.params.id}" not found or expired.`)
    }
    reply.send(page)
  })
}
export default plugin
