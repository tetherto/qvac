import {
  embed,
  embedBatch,
  type EmbedInput,
  type EmbedBatchParams,
  type EmbedParams,
  type EmbedClientInput,
  type EmbedClientParams,
  type LoadModelOptions
} from '@/index'

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

const mediaSingle: Promise<{ embedding: number[] }> = embed({ modelId: 'm', input: inputs[1]! })
const imageSingle: Promise<{ embedding: number[] }> = embed({
  modelId: 'm',
  input: { image: new Uint8Array([1, 2, 3]), width: 1, height: 1, channels: 3 }
})
void [mediaSingle, imageSingle]

const explicitBatch: Promise<{ embedding: number[][] }> = embedBatch({ modelId: 'm', inputs })
const imageBatch: Promise<{ embedding: number[][] }> = embedBatch({
  modelId: 'm',
  inputs: [{ image: new Uint8Array([1, 2, 3]) }]
})
const batchId: string = embedBatch({ modelId: 'm', inputs: ['query'] }).requestId
void [explicitBatch, imageBatch, batchId]
// @ts-expect-error Choose a single input or a legacy text input.
embed({ modelId: 'm', input: 'query', text: 'query' })
// @ts-expect-error Batches require an inputs array.
embedBatch({ modelId: 'm', input: 'query' })
// @ts-expect-error Image bytes use Uint8Array on the JavaScript client.
embed({ modelId: 'm', input: { image: 'AQID' } })

const typedImageBatch: EmbedBatchParams = { modelId: 'm', inputs: [{ image: new Uint8Array([1]) }] }
const typedImageResult: Promise<{ embedding: number[][] }> = embedBatch(typedImageBatch)
void typedImageResult

// @ts-expect-error The legacy inputs batch takes text or media parts. Images use embedBatch.
embed({ modelId: 'm', inputs: [{ image: new Uint8Array([1]) }] })
// @ts-expect-error EmbedInput keeps its text and media parts shape.
const imageAsLegacyInput: EmbedInput = { image: new Uint8Array([1]) }
void imageAsLegacyInput
// @ts-expect-error EmbedParams keeps the text and inputs shapes embed() accepted before embedBatch.
const singleAsLegacyParams: EmbedParams = { modelId: 'm', input: 'query' }
void singleAsLegacyParams
const clientInput: EmbedClientInput = { image: new Uint8Array([1]) }
const clientParams: EmbedClientParams = { modelId: 'm', input: clientInput }
void embed(clientParams)
