// Embed text, an image, and audio with EmbeddingGemma 2 in one shared vector space.
import { close, embed, loadModel, unloadModel } from '@qvac/sdk'
import { resolve } from 'node:path'

// EmbeddingGemma 2 normalizes its embeddings, so their dot product is cosine similarity.
function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!
  }
  return dotProduct
}

const registryPath =
  'registry://huggingface/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/'
let modelId: string | undefined
try {
  const [imagePath, audioPath] = process.argv.slice(2)
  if (!imagePath || !audioPath) {
    throw new Error('Usage: npx tsx embed-multimodal.ts image.jpg audio.wav')
  }
  console.error('▸ Loading EmbeddingGemma 2 and its projector')
  modelId = await loadModel({
    modelType: 'llamacpp-embedding',
    modelSrc: registryPath + 'embeddinggemma-2-Q8_0.gguf',
    modelConfig: {
      projectionModelSrc: registryPath + 'mmproj-embeddinggemma-2-Q8_0.gguf',
      ctxSize: 2048,
      batchSize: 2048
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })
  const { embedding, stats } = await embed({
    modelId,
    inputs: [
      'task: search result | query: waterproof trail running shoes',
      ['title: none | text: ', { media: { type: 'filePath', value: resolve(imagePath) } }],
      [{ media: { type: 'filePath', value: resolve(audioPath) } }]
    ]
  })
  const [textEmbedding, imageEmbedding, audioEmbedding] = embedding
  if (!textEmbedding || !imageEmbedding || !audioEmbedding) {
    throw new Error('Expected text, image, and audio embeddings')
  }
  const labels = ['Text query', `Image: ${imagePath}`, `Audio: ${audioPath}`]
  for (const [index, values] of embedding.entries()) {
    console.log(labels[index])
    console.log('Embedding dimensions:', values.length)
    console.log('First 10 values:', values.slice(0, 10))
  }
  console.log('Text/image similarity:', cosineSimilarity(textEmbedding, imageEmbedding).toFixed(4))
  console.log('Text/audio similarity:', cosineSimilarity(textEmbedding, audioEmbedding).toFixed(4))
  console.log('Higher scores indicate a closer match to the text query.')
  if (stats) console.log('Performance stats:', stats)
} catch (error) {
  console.error('✖', error)
  process.exitCode = 1
} finally {
  if (modelId) {
    try {
      await unloadModel({ modelId })
    } catch (error) {
      console.error('✖ Failed to unload model:', error)
      process.exitCode = 1
    }
  }
  try {
    await close()
  } catch (error) {
    console.error('✖ Failed to close SDK connection:', error)
    process.exitCode = 1
  }
}
