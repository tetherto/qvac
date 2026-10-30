import { embed, type EmbedInput, type EmbedParams, type LoadModelOptions } from '@/index'

const inputs: EmbedInput[] = [
  'task: search result | query: red square',
  ['title: none | text: ', { media: { type: 'base64', value: 'AQID' } }],
  [{ media: { type: 'filePath', value: '/audio.wav' } }]
]
const single: Promise<{ embedding: number[] }> = embed({ modelId: 'm', text: 'query' })
const batch: Promise<{ embedding: number[][] }> = embed({ modelId: 'm', inputs })
const legacyBatch: Promise<{ embedding: number[][] }> = embed({ modelId: 'm', text: ['query'] })
const id: string = embed({ modelId: 'm', inputs }).requestId
const params: EmbedParams = { modelId: 'm', inputs }
const general = embed(params)
const load: LoadModelOptions = {
  modelType: 'llamacpp-embedding',
  modelSrc: '/model.gguf',
  modelConfig: {
    projectionModelSrc: '/mmproj.gguf',
    ctxSize: 2048,
    batchSize: 2048,
    imageMaxTokens: 280,
    mmprojNoAudio: false
  }
}
void [single, batch, legacyBatch, id, general, load]
// @ts-expect-error Choose text or inputs.
embed({ modelId: 'm', text: 'query', inputs })
// @ts-expect-error Media must use an explicit source.
embed({ modelId: 'm', inputs: [[{ media: new Uint8Array(2) }]] })
