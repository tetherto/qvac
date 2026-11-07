/**
 * Compare two images using the MegaLoc F16 model.
 * Pass a GGUF URL or local file after the two JPEG/PNG paths to use custom weights.
 */
import { readFile } from 'node:fs/promises'
import { loadModel, embedImage, unloadModel, close, ModelType, MEGALOC_F16 } from '@qvac/sdk'

let modelId: string | undefined
try {
  const [firstPath, secondPath, modelSrc = MEGALOC_F16] = process.argv.slice(2)
  if (!firstPath || !secondPath) {
    throw new Error('Usage: megaloc <first.jpg> <second.jpg> [GGUF URL or path]')
  }
  console.log('▸ Loading MegaLoc')
  modelId = await loadModel({ modelSrc, modelType: ModelType.ggmlImageEmbedding })
  const [first, second] = await Promise.all([
    embedImage({ modelId, image: await readFile(firstPath) }),
    embedImage({ modelId, image: await readFile(secondPath) })
  ])
  const similarity = first.embedding.reduce(
    (sum, value, index) => sum + value * second.embedding[index]!,
    0
  )
  console.log(
    JSON.stringify({ similarity, dimensions: first.embedding.length, stats: first.stats }, null, 2)
  )
} catch (error) {
  console.error('✖', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  try {
    if (modelId) await unloadModel({ modelId })
  } finally {
    await close()
  }
}
