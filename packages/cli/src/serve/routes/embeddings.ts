import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { embed } from '@qvac/sdk'
import { requireModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import { embeddingsBody, EMBEDDINGS_UNSUPPORTED_PARAMS } from '../schemas/embeddings.js'

const descriptions = {
  embed: `
Compute embeddings for a single string or an array of strings.

**Output**: \`data[]\` always wraps each input's vector under
\`{ object: 'embedding', index, embedding: number[] }\`, matching OpenAI.

**Ignored params** (warned, not rejected): \`encoding_format\` (we always
return float arrays), \`dimensions\` (no truncation/padding), \`user\`.

**Token accounting**: \`usage.prompt_tokens\` and \`total_tokens\` are
reported as 0 — the SDK \`embed()\` operation doesn't surface a token count.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/embeddings',
    {
      schema: {
        body: embeddingsBody,
        tags: ['Embeddings'],
        summary: 'Generate embeddings',
        description: descriptions.embed
      },
      config: { unsupportedParams: [...EMBEDDINGS_UNSUPPORTED_PARAMS] },
      preHandler: [requireModel('embedding'), logUnsupported]
    },
    async (req) => {
      const { input } = req.body
      const inputs = Array.isArray(input) ? input : [input]
      const { sdkModelId, alias } = req.qvacModel!

      app.qvac.logger.info(`  embed model=${alias} inputs=${inputs.length}`)

      // Route through the right `embed()` overload so result shape narrows.
      const op =
        inputs.length === 1
          ? embed({ modelId: sdkModelId, text: inputs[0]! })
          : embed({ modelId: sdkModelId, text: inputs })
      req.bindCancel(op.requestId)
      const { embedding } = await op

      const isBatch = Array.isArray(embedding[0])
      const vectors = isBatch ? (embedding as number[][]) : [embedding as number[]]
      const data = vectors.map((vec, index) => ({
        object: 'embedding' as const,
        index,
        embedding: vec
      }))

      app.qvac.logger.info(`  embed done vectors=${vectors.length} dim=${vectors[0]?.length ?? 0}`)

      return {
        object: 'list' as const,
        data,
        model: alias,
        usage: { prompt_tokens: 0, total_tokens: 0 }
      }
    }
  )
}

export default plugin
