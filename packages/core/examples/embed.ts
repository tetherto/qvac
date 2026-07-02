// Text embeddings on Bare, in-process.
//
// Run: bare examples/embed.ts
// Requires: npm install @qvac/core @qvac/embed-llamacpp

import { registerPlugin, loadModel, embed, unloadModel, EMBEDDINGGEMMA_300M_Q4_0 } from '@qvac/core'
import { embeddingsPlugin } from '@qvac/core/llamacpp-embedding/plugin'

registerPlugin(embeddingsPlugin)

try {
  const modelId = await loadModel({ modelSrc: EMBEDDINGGEMMA_300M_Q4_0 })
  console.log(`▸ Model loaded: ${modelId}`)

  const texts = ['Bare runs the engine in-process.', 'Embeddings turn text into vectors.']

  for (const text of texts) {
    const { embedding } = await embed({ modelId, text })
    console.log(`▸ "${text}" -> ${embedding.length} dims`)
  }

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
