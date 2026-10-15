import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireModel } from '@/serve/core/plugins/require-model'
import { systemOneBody, systemOneResult } from '@/serve/extensions/systemone/schemas'
import { systemOneState } from '@/serve/extensions/systemone/state'
import { toDecideParams, toSystemOneResult } from '@/serve/extensions/systemone/mapping'

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
      const { sdkModelId, alias } = req.qvacModel!
      const result = systemOneState(app.qvac).decide(toDecideParams(req.body, sdkModelId))
      req.bindCancel(result.requestId)
      app.qvac.logger.info(
        `  systemone model=${alias} questions=${Object.keys(req.body.questions).length}`
      )
      return toSystemOneResult(await result, alias)
    }
  )
}

export default plugin
