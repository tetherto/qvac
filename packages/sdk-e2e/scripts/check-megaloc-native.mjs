import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadModel, unloadModel, embedImage, close, ModelType } from '../../sdk/dist/src/index.js'

// Replace these placeholder URLs with the converted model URLs when available:
// node scripts/check-megaloc-native.mjs https://models.example.com/megaloc-f16.gguf https://models.example.com/megaloc-mixed.gguf

// The addon fixtures contain original PyTorch descriptors for deterministic RGB inputs.
const fixtures = new URL('../../classification-ggml/test/fixtures/', import.meta.url)
const referenceBytes = await readFile(new URL('megaloc-upscale-f32.bin', fixtures))
const baseline = Array.from({ length: 8448 }, (_, index) => referenceBytes.readFloatLE(index * 4))
const pixels = new Uint8Array(64 * 48 * 3)
for (let index = 0; index < pixels.length; index++)
  pixels[index] = (index * 37 + Math.floor(index / 19)) % 256

function checkDescriptor(embedding) {
  assert.equal(embedding.length, 8448)
  assert(embedding.every(Number.isFinite))
  const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0))
  assert(Math.abs(norm - 1) < 1e-4, `Descriptor norm ${norm}`)
}

const sources = process.argv.slice(2)
assert.equal(sources.length, 2, 'Pass the direct F16 and mixed GGUF URLs, in that order')
for (const source of sources) assert.equal(new URL(source).protocol, 'https:')

try {
  for (const [index, modelSrc] of sources.entries()) {
    const modelId = await loadModel({
      modelSrc,
      modelType: ModelType.ggmlImageEmbedding,
      modelConfig: { backend: 'CPU', threads: 4 }
    })
    try {
      const request = { modelId, image: pixels, width: 64, height: 48, channels: 3 }
      const { embedding, stats } = await embedImage(request)
      checkDescriptor(embedding)
      const dot = embedding.reduce((sum, value, i) => sum + value * baseline[i], 0)
      const baselineNorm = Math.sqrt(baseline.reduce((sum, value) => sum + value * value, 0))
      assert(
        dot / baselineNorm >= (index === 0 ? 0.9999 : 0.9995),
        'Original PyTorch descriptor parity'
      )
      assert.equal(stats.backendId, 0)
      assert(stats.weightBytes > 0)

      const tiny = await embedImage({
        modelId,
        image: new Uint8Array([0, 127, 255]),
        width: 1,
        height: 1,
        channels: 3
      })
      checkDescriptor(tiny.embedding)
      const encoded = await embedImage({
        modelId,
        image: await readFile(new URL('megaloc-input.png', fixtures))
      })
      checkDescriptor(encoded.embedding)
      await assert.rejects(embedImage({ modelId, image: new Uint8Array([0, 1, 2, 3]) }))
      const [again, concurrent] = await Promise.all([embedImage(request), embedImage(request)])
      for (const result of [again, concurrent]) {
        checkDescriptor(result.embedding)
        assert(
          Math.max(...result.embedding.map((value, i) => Math.abs(value - embedding[i]))) < 1e-6
        )
      }
      console.log(
        `${index === 0 ? 'F16' : 'Mixed'} MegaLoc SDK parity, RGB boundary, PNG, error recovery and concurrency passed`
      )
    } finally {
      await unloadModel({ modelId })
    }
  }
} finally {
  await close()
}
