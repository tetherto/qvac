import { loadModel, embedImage, ModelType, type ImageEmbeddingConfig } from '../src/index'

const config: ImageEmbeddingConfig = { backend: 'CPU', threads: 4 }
void loadModel({
  modelType: ModelType.ggmlImageEmbedding,
  modelSrc: '/models/megaloc.gguf',
  modelConfig: config
})
void loadModel({
  modelSrc: { src: '/models/megaloc.gguf', engine: ModelType.ggmlImageEmbedding },
  modelConfig: config
})
const call = embedImage({
  modelId: 'm',
  image: new Uint8Array([1, 2, 3]),
  width: 1,
  height: 1,
  channels: 3
})
const requestId: string = call.requestId
void requestId
// @ts-expect-error MegaLoc weights must have an explicit source.
void loadModel({ modelType: ModelType.ggmlImageEmbedding })
const classifierConfig: ImageEmbeddingConfig = {
  // @ts-expect-error Image embedding config does not accept classification options.
  topK: 3
}
void classifierConfig
// @ts-expect-error The client accepts image bytes.
void embedImage({ modelId: 'm', image: 'AQID' })
