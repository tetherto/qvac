import type { ServerResponse } from 'node:http'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import { invokePlugin, invokePluginStream, MODEL_TYPES, SDK_SERVER_ERROR_CODES } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { endSSE, initSSE, sendSSE } from '@/serve/lib/sse'
import { resolveModelAlias } from '@/serve/core/config/models'
import { resolveAndCheckModel } from '@/serve/core/plugins/require-model'
import {
  pluginInvocation,
  pluginInvokeBody,
  pluginInvokeParams
} from '@/serve/extensions/default/schemas/plugins'

// Built-in plugins have their own endpoints, and some of their handlers take
// host paths (`finetune`), which no request body may name.
const BUILTIN_PLUGINS = new Set<string>([
  ...Object.keys(MODEL_TYPES),
  ...Object.values(MODEL_TYPES)
])

const description = `
Call a handler of a custom plugin, backed by the SDK's \`invokePlugin()\`, or
\`invokePluginStream()\` with \`stream: true\`. **Admin-only:** needs
\`--enable-admin\`, since it runs whatever the plugin does.

\`:name\` is the plugin's model type. \`model\` names a \`serve.models\` alias
whose \`type\` is \`:name\`; the plugin must be registered in the worker that
serve runs, such as a \`qvac/worker.entry.mjs\` from \`qvac bundle sdk\`.
Built-in plugins are refused: use their own endpoints.

\`params\` goes to the handler as-is and the plugin validates it. A reply
handler answers \`plugin.invocation\` with its \`result\`. With \`stream: true\`
a streaming handler answers SSE: a \`plugin.invocation.chunk\` per result, one
\`plugin.invocation.done\`, then \`data: [DONE]\`. A client disconnect stops the
stream but not the handler.

**Error codes:** \`400\` \`missing_model\`, \`missing_handler\`,
\`builtin_plugin\`, \`invalid_model_type\`, \`invalid_plugin_params\`,
\`handler_type_mismatch\`, \`invalid_request\`; \`403\` \`admin_disabled\`,
\`origin_not_allowed\`; \`404\` \`model_not_found\`, \`handler_not_found\`;
\`502\` \`plugin_response_invalid\`; \`503\` \`model_not_loaded\`,
\`model_not_ready\`, \`model_load_failed\`, \`model_load_timeout\`,
\`runtime_suspended\`.
`.trim()

export interface InvokeOptions {
  modelId: string
  handler: string
  params: unknown
}

export interface PluginOperations {
  invoke: (options: InvokeOptions) => Promise<unknown>
  invokeStream: (options: InvokeOptions) => AsyncGenerator<unknown>
}

const SDK_OPERATIONS: PluginOperations = {
  invoke: (options) => invokePlugin(options),
  invokeStream: (options) => invokePluginStream(options)
}

type PluginInvocation = z.infer<typeof pluginInvocation>

export function pluginRoutes(ops: PluginOperations = SDK_OPERATIONS): FastifyPluginAsyncZod {
  // lunte-disable-next-line require-await
  return async (app) => {
    app.post(
      '/qvac/v1/plugins/:name/invoke',
      {
        config: { admin: true },
        schema: {
          params: pluginInvokeParams,
          body: pluginInvokeBody,
          response: {
            200: pluginInvocation,
            ...errorResponses({
              400: {
                missing_model: '`model` is missing',
                missing_handler: '`handler` is missing',
                builtin_plugin: '`:name` is a built-in model type',
                invalid_model_type: "The `model` alias's `type` is not `:name`",
                invalid_plugin_params: 'The plugin rejected `params`',
                handler_type_mismatch: '`stream` does not match whether the handler streams',
                invalid_request: 'The body carries an unknown field'
              },
              403: {
                admin_disabled: 'The server was started without `--enable-admin`',
                origin_not_allowed: 'A browser request from an origin outside the CORS allowlist'
              },
              404: {
                model_not_found: 'No `serve.models` alias is called `model`',
                handler_not_found: 'The plugin has no handler called `handler`'
              },
              502: { plugin_response_invalid: "The handler's result failed the plugin's schema" },
              503: {
                model_not_loaded: 'The model is not loaded and lazy loading is disabled',
                model_not_ready: 'The model is still loading',
                model_load_failed: 'The model failed to load',
                model_load_timeout: 'The model did not load in time',
                runtime_suspended: 'The runtime is not active; resume it first'
              }
            })
          },
          tags: ['Plugins'],
          summary: 'Invoke a custom plugin handler',
          description
        },
        preHandler: async function (req, reply) {
          const { name } = req.params
          const model = req.body.model.trim()
          if (BUILTIN_PLUGINS.has(name)) {
            throw new HttpError(
              400,
              'builtin_plugin',
              `"${name}" is a built-in plugin. Use its own endpoint.`
            )
          }
          if (!model) throw new HttpError(400, 'missing_model', '"model" is required.')
          const entry =
            resolveModelAlias(req.server.qvac.serveConfig, model) ??
            req.server.qvac.registry.getEntry(model)
          if (!entry) {
            throw new HttpError(
              404,
              'model_not_found',
              `Model "${model}" is not available. Check serve.models config.`
            )
          }
          if (entry.sdkType !== name) {
            throw new HttpError(
              400,
              'invalid_model_type',
              `Model "${model}" is not served by plugin "${name}".`
            )
          }
          req.qvacModel = await resolveAndCheckModel(req, reply, model, entry.endpointCategory)
        }
      },
      async (req, reply): Promise<PluginInvocation | undefined> => {
        const { handler, params = {}, stream } = req.body
        const { sdkModelId, alias } = req.qvacModel!
        const options = { modelId: sdkModelId, handler, params }

        app.qvac.logger.info(
          `  plugin ${req.params.name} model=${alias} handler=${handler}${stream ? ' stream' : ''}`
        )

        if (!stream) {
          const result = await ops.invoke(options).catch((err: unknown) => {
            throw toHttpError(err)
          })
          return { object: 'plugin.invocation', model: alias, handler, result }
        }

        const chunks = ops.invokeStream(options)
        // Read the first chunk before the headers go out, so a bad handler or
        // params still answers with its own status.
        const first = await chunks.next().catch((err: unknown) => {
          throw toHttpError(err)
        })

        initSSE(reply)
        const raw = reply.raw
        const base = { model: alias, handler }
        let next = first
        let index = 0
        while (!next.done) {
          sendSSE(raw, {
            object: 'plugin.invocation.chunk',
            ...base,
            index: index++,
            result: next.value
          })
          // Hold the next chunk until a slow client catches up.
          if (raw.writableNeedDrain) await writable(raw)
          if (raw.destroyed) return release(chunks)
          const step = await readOrClose(raw, chunks.next())
          if (step === CLOSED) return release(chunks)
          next = step
        }
        sendSSE(raw, { object: 'plugin.invocation.done', ...base })
        endSSE(raw)
        return undefined
      }
    )
  }
}

const CLOSED = Symbol('closed')

// A pending `next()` holds the generator, so its `return()` lands after the
// handler's next chunk; nothing waits for it.
function release(chunks: AsyncGenerator<unknown>): undefined {
  chunks.return(undefined).catch(() => {})
  return undefined
}

// The close listener goes with each read, so a long stream does not pile them up.
function readOrClose(
  raw: ServerResponse,
  read: Promise<IteratorResult<unknown>>
): Promise<IteratorResult<unknown> | typeof CLOSED> {
  return new Promise((resolve, reject) => {
    function onClose(): void {
      resolve(CLOSED)
    }
    raw.once('close', onClose)
    read.then(
      (result) => {
        raw.off('close', onClose)
        resolve(result)
      },
      (err: unknown) => {
        raw.off('close', onClose)
        reject(toHttpError(err))
      }
    )
  })
}

function writable(raw: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    function done(): void {
      raw.off('drain', done)
      raw.off('close', done)
      resolve()
    }
    raw.once('drain', done)
    raw.once('close', done)
  })
}

// Matched by code: the SDK does not export the plugin error classes.
export function toHttpError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND:
      return new HttpError(404, 'handler_not_found', message)
    case SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED:
      return new HttpError(400, 'invalid_plugin_params', message)
    case SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_TYPE_MISMATCH:
      return new HttpError(400, 'handler_type_mismatch', message)
    case SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED:
      return new HttpError(502, 'plugin_response_invalid', message)
    default:
      return err
  }
}

export default pluginRoutes()
