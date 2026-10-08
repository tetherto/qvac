import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireModel } from '@/serve/core/plugins/require-model'
import { systemOneBody, systemOneResult } from '@/serve/extensions/systemone/schemas'
import { systemOneState } from '@/serve/extensions/systemone/state'

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/systemone',
    {
      schema: {
        body: systemOneBody,
        response: { 200: systemOneResult },
        tags: ['Decision'],
        summary: 'Answer typed decision questions',
        description:
          'Evaluate one state with choice, score, or noul questions. An array state is one shared context. Returns JSON without a token stream.'
      },
      preHandler: requireModel('decision')
    },
    async (req) => {
      const { model: _model, ...input } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const result = systemOneState(app.qvac).decide({ ...input, modelId: sdkModelId })
      req.bindCancel(result.requestId)
      app.qvac.logger.info(
        `  systemone model=${alias} questions=${Object.keys(input.questions).length}`
      )
      return { ...(await result), model: alias }
    }
  )
}

export default plugin
