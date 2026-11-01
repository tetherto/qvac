import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import { assessModelFit } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import type { ServeConfig } from '@/serve/core/config/types'
import { loadModelConstants } from '@/serve/core/config/constants'
import { resolveExplicitServeModel, resolveModelAlias } from '@/serve/core/config/models'
import { isModelSrcKey, resolveNestedModelSrcConstants } from '@/serve/core/config/nested-model-src'
import {
  MAX_FIT_MODELS,
  modelFitBody,
  modelFitResult
} from '@/serve/extensions/default/schemas/model-fit'

type FitCandidate = z.infer<typeof modelFitBody>['models'][number]

type ResolvedCandidate = Parameters<typeof assessModelFit>[0]['models'][number]
type ModelType = ResolvedCandidate['modelType']

const description = `
Ask whether models are likely to fit in this host's memory before loading them,
backed by the SDK's \`assessModelFit()\`. Nothing is downloaded or loaded: each
model's weightless registry description is fetched (tens of KB) and the engine's
own fitter runs against it, falling back to a floor computed from catalog facts.

Each entry in \`models\` names a \`serve.models\` alias or an SDK model constant.
An alias is assessed with the config it would load with; \`modelConfig\` is
merged over it key by key, nested objects included, so \`{"ctx_size": 32768}\`
asks about a longer context and leaves the rest of the alias's config as is. Model
sources cannot be given here: companion sources in \`modelConfig\` must name
constants, so a request never makes the server read a path or URL of its
choosing.

The answer is advisory. \`verdict\` is \`likely-fits\`, \`likely-too-large\` or
\`unknown\`, combined across every model under \`execution\`; \`unknown\` means
the evidence supports neither, not "no". \`models\` carries one verdict per
entry, in request order, and \`budget\` the memory it was judged against.
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
              invalid_execution: '`execution` is not `sequential` or `concurrent`',
              invalid_policy: '`policy` is not `interactive-v1`',
              invalid_model_src: 'A companion source in `modelConfig` is not an SDK model constant',
              invalid_request: 'The body carries an unknown field'
            },
            404: { model_not_found: 'An entry names neither an alias nor a model constant' },
            500: { model_fit_failed: 'The SDK assessment failed' }
          })
        },
        tags: ['System'],
        summary: 'Assess model fit',
        description
      }
    },
    async (req) => {
      const { models, execution, policy } = req.body
      const candidates = models.map((candidate) =>
        resolveCandidate(app.qvac.serveConfig, candidate)
      )
      app.qvac.logger.info(`  model fit models=${models.map((m) => m.model).join(',')}`)

      let result: Awaited<ReturnType<typeof assessModelFit>>
      try {
        result = await assessModelFit({
          models: candidates,
          ...(execution !== undefined && { execution }),
          ...(policy !== undefined && { policy })
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        app.qvac.logger.error(`  model fit failed: ${message}`)
        throw new HttpError(500, 'model_fit_failed', 'Failed to assess model fit.')
      }

      return {
        object: 'model_fit' as const,
        ...result,
        models: result.models.map((entry, i) => ({ model: models[i]!.model, ...entry }))
      }
    }
  )
}

function resolveCandidate(serveConfig: ServeConfig, candidate: FitCandidate): ResolvedCandidate {
  const requested = candidate.modelConfig ?? {}
  assertConstantSources(requested, 'modelConfig')
  const overrides = resolveNestedModelSrcConstants(requested)

  const alias = resolveModelAlias(serveConfig, candidate.model)
  if (alias) {
    return {
      modelSrc: alias.modelSrc,
      modelType: alias.sdkType as ModelType,
      modelConfig: mergeConfig(alias.config, overrides)
    }
  }

  const constant = loadModelConstants().get(candidate.model)
  if (constant) {
    const resolved = resolveExplicitServeModel(constant.engine || constant.addon, overrides)
    return {
      modelSrc: constant,
      modelType: resolved.sdkType as ModelType,
      modelConfig: resolved.config
    }
  }

  throw new HttpError(
    404,
    'model_not_found',
    `Model "${candidate.model}" is neither a serve.models alias nor an SDK model constant.`
  )
}

// Nested objects merge key by key, so `contextParams: { n_ctx }` keeps the
// alias's other context params. A model source is replaced whole.
export function mergeConfig(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key]
    merged[key] =
      !isModelSrcKey(key) && isPlainObject(current) && isPlainObject(value)
        ? mergeConfig(current, value)
        : value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertConstantSources(config: Record<string, unknown>, path: string): void {
  const constants = loadModelConstants()
  for (const [key, value] of Object.entries(config)) {
    const at = `${path}.${key}`
    if (isModelSrcKey(key)) {
      if (typeof value !== 'string' || !constants.has(value)) {
        throw new HttpError(
          400,
          'invalid_model_src',
          `${at} must name an SDK model constant; paths and URLs are only accepted from serve.models.`
        )
      }
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      assertConstantSources(value as Record<string, unknown>, at)
    }
  }
}

export default plugin
