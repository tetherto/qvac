import { embedImage } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { imageEmbeddingTests } from '../../../../catalog/image-embedding-tests.js'

function image(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 3)
  for (let index = 0; index < pixels.length; index++) {
    pixels[index] = (index * 37 + Math.floor(index / 19)) % 256
  }
  return { image: pixels, width, height, channels: 3 as const }
}

function checkDescriptor(embedding: number[]) {
  if (embedding.length !== 8448 || !embedding.every(Number.isFinite)) {
    throw new Error('Expected 8448 finite image embedding values')
  }
  const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0))
  if (Math.abs(norm - 1) >= 1e-4) {
    throw new Error(`Expected a unit image embedding, got norm ${norm}`)
  }
}

export class ImageEmbeddingExecutor extends AbstractModelExecutor<typeof imageEmbeddingTests> {
  pattern = /^image-embedding-/
  protected handlers = {
    'image-embedding-megaloc-mixed': this.mixed.bind(this)
  }

  async mixed(_params: unknown, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('image-embedding')
    const request = { modelId, ...image(64, 48) }
    const first = await embedImage(request)
    const second = await embedImage({ modelId, ...image(640, 480) })
    checkDescriptor(first.embedding)
    checkDescriptor(second.embedding)

    const tiny = await embedImage({ modelId, ...image(1, 1) })
    checkDescriptor(tiny.embedding)

    // Non-empty encoded bytes pass client validation and reach the native image decoder.
    let decodeError: unknown
    try {
      await embedImage({ modelId, image: new Uint8Array([0, 1, 2, 3]) })
    } catch (error) {
      decodeError = error
    }
    if (!(decodeError instanceof Error) || !/JPEG.*PNG/.test(decodeError.message)) {
      return {
        passed: false,
        output: `Expected a native image decode error, got ${String(decodeError)}`
      }
    }

    const recovered = await embedImage(request)
    checkDescriptor(recovered.embedding)
    if (
      recovered.embedding.some((value, index) => Math.abs(value - first.embedding[index]!) >= 1e-6)
    ) {
      return { passed: false, output: 'Image embedding changed after a native decode error' }
    }

    const similarity = first.embedding.reduce(
      (sum, value, index) => sum + value * second.embedding[index]!,
      0
    )
    return ValidationHelpers.validate(similarity, expectation)
  }
}
