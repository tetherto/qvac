import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { translate } from '@qvac/sdk'
import { requireModel } from '../plugins/require-model.js'
import { HttpError } from '../lib/http-error.js'
import { initSSE, sendSSE, endSSE } from '../lib/sse.js'
import { textTranslationsBody } from '../schemas/text.js'

type TranslateFn = typeof translate

const NMT_MODEL_TYPE = 'nmtcpp-translation'

function randomId(): string {
  return Math.random().toString(36).slice(2, 12)
}

const descriptions = {
  translate: `
Translate text with a configured translation model. \`input\` is a single string
or an array of strings (batch). \`model\` names a \`serve.models\` alias whose
endpoint category is \`translation\`. Pass \`stream: true\` (single input only) for
Server-Sent Events; the stream ends with \`data: [DONE]\`.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/text/translations',
    {
      schema: {
        body: textTranslationsBody,
        tags: ['Translation'],
        summary: 'Translate text',
        description: descriptions.translate
      },
      preHandler: [requireModel('translation')]
    },
    async (req, reply) => {
      const { input, stream } = req.body
      const inputs = Array.isArray(input) ? input : [input]
      const { sdkModelId, alias } = req.qvacModel!

      if (stream && inputs.length > 1) {
        throw new HttpError(
          400,
          'unsupported_streaming',
          'Streaming is not supported for multiple inputs; send a single string or set stream:false.'
        )
      }

      const translateFn = app.qvac.translateOverride ?? translate

      app.qvac.logger.info(
        `  translate model=${alias} inputs=${inputs.length} stream=${Boolean(stream)}`
      )

      if (stream) {
        await runStreaming(req, reply, translateFn, sdkModelId, inputs[0]!, alias)
        return
      }
      return await runBlocking(req, translateFn, sdkModelId, inputs, alias)
    }
  )
}

async function runBlocking(
  req: FastifyRequest,
  translateFn: TranslateFn,
  modelId: string,
  inputs: string[],
  model: string
): Promise<{
  object: 'list'
  data: Array<{ object: 'translation'; index: number; text: string }>
  model: string
}> {
  const data = await Promise.all(
    inputs.map(async (text, index) => {
      const result = translateFn({ modelId, text, stream: false, modelType: NMT_MODEL_TYPE })
      req.bindCancel(result.requestId)
      return { object: 'translation' as const, index, text: await result.text }
    })
  )
  return { object: 'list', data, model }
}

async function runStreaming(
  req: FastifyRequest,
  reply: FastifyReply,
  translateFn: TranslateFn,
  modelId: string,
  input: string,
  model: string
): Promise<void> {
  const result = translateFn({ modelId, text: input, stream: true, modelType: NMT_MODEL_TYPE })
  req.bindCancel(result.requestId)

  initSSE(reply)
  const raw = reply.raw
  const id = `textxlt-${randomId()}`
  const created = Math.floor(Date.now() / 1000)

  for await (const token of result.tokenStream) {
    sendSSE(raw, { object: 'text_translation.chunk', id, created, model, delta: token })
  }
  endSSE(raw)
}

export default plugin
