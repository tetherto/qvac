import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { translate } from '@qvac/sdk'
import { randomBytes } from 'node:crypto'
import { initSSE, sendSSE, endSSE } from '@/serve/lib/sse'
import { requireModel } from '@/serve/core/plugins/require-model'
import {
  MAX_BATCH_INPUTS,
  translateBody,
  translationResult,
  type NmtModelType
} from '@/serve/extensions/default/schemas/translate'

/** `endpointCategory: 'translation'` admits exactly these two model types. */
function nmtModelType(sdkType: string): NmtModelType {
  return sdkType === 'nmt' ? 'nmt' : 'nmtcpp-translation'
}

type TranslationResult = z.infer<typeof translationResult>

interface TranslateCall {
  req: FastifyRequest
  modelId: string
  modelType: NmtModelType
  model: string
}

const description = `
Translate text with a configured NMT model, backed by the SDK's \`translate()\`.

\`model\` names a \`serve.models\` alias whose endpoint category is
\`translation\`. That alias's \`config\` carries the \`engine\` and the
\`from\` / \`to\` languages.

\`text\` is a single string, or an array of up to ${MAX_BATCH_INPUTS} for batch.
\`translations\` comes back in the order the inputs were given, one entry per
input. \`stats\` is returned for a single input; a batch does not report stats.

\`stream: true\` emits Server-Sent Events. A single input emits
\`translation.chunk\` events carrying \`delta\` as the text is decoded. An array
emits one \`translation.item\` per input, carrying \`index\` and the whole
\`text\`, and these arrive together once the batch finishes. Both end with one
\`translation.done\` event, then \`data: [DONE]\`.

A client disconnect cancels the request and its result is dropped.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/qvac/v1/translate',
    {
      schema: {
        body: translateBody,
        response: { 200: translationResult },
        tags: ['Translation'],
        summary: 'Translate text',
        description
      },
      preHandler: requireModel('translation')
    },
    async (req, reply) => {
      const { text, stream } = req.body
      const { sdkModelId, alias, entry } = req.qvacModel!

      const call: TranslateCall = {
        req,
        modelId: sdkModelId,
        modelType: nmtModelType(entry.sdkType),
        model: alias
      }
      const inputs = Array.isArray(text) ? text.length : 1
      app.qvac.logger.info(`  translate model=${alias} inputs=${inputs} stream=${stream === true}`)

      if (stream === true) {
        await streamTranslation(call, reply, text)
        return
      }
      return await translateText(call, text)
    }
  )
}

async function translateText(
  call: TranslateCall,
  text: string | string[]
): Promise<TranslationResult> {
  const result = translate({
    modelId: call.modelId,
    text,
    stream: false,
    modelType: call.modelType
  })
  call.req.bindCancel(result.requestId)

  const [translations, stats] = await Promise.all([result.translations, result.stats])
  return {
    object: 'translation',
    model: call.model,
    translations,
    ...(stats !== undefined ? { stats } : {})
  }
}

async function streamTranslation(
  call: TranslateCall,
  reply: FastifyReply,
  text: string | string[]
): Promise<void> {
  const { model } = call
  const batched = Array.isArray(text)
  const result = translate({
    modelId: call.modelId,
    text,
    stream: true,
    modelType: call.modelType
  })
  call.req.bindCancel(result.requestId)

  initSSE(reply)
  const raw = reply.raw
  const id = `translation-${randomBytes(6).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)

  let index = 0
  for await (const token of result.tokenStream) {
    sendSSE(
      raw,
      batched
        ? { object: 'translation.item', id, created, model, index: index++, text: token }
        : { object: 'translation.chunk', id, created, model, delta: token }
    )
  }

  const stats = await result.stats
  sendSSE(raw, {
    object: 'translation.done',
    id,
    created,
    model,
    ...(stats !== undefined ? { stats } : {})
  })
  endSSE(raw)
}

export default plugin
