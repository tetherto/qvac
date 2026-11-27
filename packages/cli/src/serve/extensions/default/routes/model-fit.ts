import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import {
  assessNamedModels,
  FitInputError,
  isInvalidModelConfig,
  type ModelFitResponse
} from '@/serve/core/fit'
import {
  MAX_FIT_MODELS,
  modelFitBody,
  modelFitResult
} from '@/serve/extensions/default/schemas/model-fit'

const description = `
Ask whether models fit in this host's memory when loaded together, before loading
them, backed by the SDK's \`assessModelFit()\`. Nothing is downloaded or loaded:
each model's weightless registry description is fetched (tens of KB) and the
engine's own fitter runs against it. The memory each load takes is summed per
device and compared against what is free.

Each entry in \`models\` names a \`serve.models\` alias or an SDK model constant.
An alias is assessed with the config it would load with; \`modelConfig\` is
merged over it key by key, nested objects included, so \`{"ctxSize": 32768}\`
asks about a longer context and leaves the rest of the alias's config as is. Model
sources cannot be given here: companion sources in \`modelConfig\` must name
constants, so a request never makes the server read a path or URL of its
choosing.

The answer is advisory. \`verdict\` is \`fits\`, \`does-not-fit\` or \`unknown\`
for every model loaded together. \`unknown\` means the load would start but
cannot be sized: an engine with no fitter, a load the fitter cannot project, a
model with no registry description that is not on disk, or a device that
reported no free memory. A \`modelConfig\` the engine's schema refuses is a 400.
Any other load that \`loadModel\` would refuse fails the request.
\`pools\` gives each memory pool the verdict was judged on: the host's memory,
and each GPU with its own memory, with what the set takes from it and what it
has free. \`models\` carries each entry's engine fit result in request order:
its own \`status\`, one row per device it uses, and its \`stats\`: the context
size and GPU layers for a llama.cpp load with a verdict, empty otherwise.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/models/fit',
    {
      schema: {
        body: modelFitBody,
        response: {
          200: modelFitResult,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_models: '`models` is missing or empty, or an entry is malformed',
              too_many_models: `\`models\` carries more than ${MAX_FIT_MODELS} entries`,
              invalid_model_src: 'A companion source in `modelConfig` is not an SDK model constant',
              invalid_model_config: "An entry's config is one the engine's schema refuses",
              invalid_request: 'The body carries an unknown field'
            },
            404: { model_not_found: 'An entry names neither an alias nor a model constant' },
            500: {
              model_fit_failed:
                'The SDK assessment failed, or an entry is another load `loadModel` would refuse'
            }
          })
        },
        tags: ['System'],
        summary: 'Assess model fit',
        description
      }
    },
    async (req) => {
      const { models } = req.body
      app.qvac.logger.info(`  model fit models=${models.map((m) => m.model).join(',')}`)

      let result: ModelFitResponse
      try {
        result = await assessNamedModels(app.qvac.serveConfig, models)
      } catch (err) {
        if (!(err instanceof FitInputError)) {
          const message = err instanceof Error ? err.message : String(err)
          app.qvac.logger.error(`  model fit failed: ${message}`)
        }
        throw toHttpError(err)
      }
      return result
    }
  )
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof FitInputError) {
    return new HttpError(err.code === 'model_not_found' ? 404 : 400, err.code, err.message)
  }
  if (isInvalidModelConfig(err)) {
    return new HttpError(400, 'invalid_model_config', (err as Error).message)
  }
  return new HttpError(500, 'model_fit_failed', 'Failed to assess model fit.')
}

export default plugin
