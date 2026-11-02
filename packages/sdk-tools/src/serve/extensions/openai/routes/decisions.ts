import { HttpError } from '@/serve/lib/http-error'
import { decide } from '@qvac/sdk'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireModel } from '@/serve/core/plugins/require-model'
import { decisionsBody, decisionsResult } from '@/serve/extensions/openai/schemas/decisions'
import { openaiState } from '@/serve/extensions/openai/state'
import { toDecideParams, toDecisionsResult } from '@/serve/extensions/openai/adapters/decisions'

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/decisions',
    {
      schema: {
        body: decisionsBody,
        response: { 200: decisionsResult },
        tags: ['Decisions'],
        summary: 'Create a decision',
        description:
          'Answer ordered predicate, choice, and score questions using a local decision model. Text inputs only. Returns JSON without streaming.'
      },
      preValidation: (req, _reply, done) => {
        const raw = req.body as unknown as { input?: unknown } | null
        if (Array.isArray(raw?.input)) {
          for (const item of raw.input) {
            if (item === null || typeof item !== 'object') continue
            for (const parts of [item.content, item.output]) {
              if (Array.isArray(parts) && parts.some((part) => part?.type === 'input_image')) {
                throw new HttpError(
                  400,
                  'unsupported_input',
                  'Local decision models do not support image input.'
                )
              }
            }
          }
        }
        done()
      },
      preHandler: requireModel('decision')
    },
    async (req) => {
      const { sdkModelId, alias } = req.qvacModel!
      const run = (openaiState(app.qvac).decideOverride ?? decide)(
        toDecideParams(req.body, sdkModelId)
      )
      req.bindCancel(run.requestId)
      app.qvac.logger.info(`  decisions model=${alias} questions=${req.body.questions.length}`)
      return toDecisionsResult(await run, req.body, alias)
    }
  )
}

export default plugin
