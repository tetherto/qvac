import { LLMChunkAdapter } from '@qvac/rag'
import { ragChunkParamsSchema, type RagChunkParams } from '@/schemas/index'

export async function chunk(params: RagChunkParams) {
  const { documents, chunkOpts } = ragChunkParamsSchema.parse(params)

  const chunker = new LLMChunkAdapter(chunkOpts)
  return await chunker.chunkText(documents, chunkOpts)
}
