import { embed, cancel, InferenceCancelledError } from '@qvac/sdk'
import type { TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import type { ResourceManager } from '../resource-manager.js'
import { embeddingGemma2Tests } from '../../../../catalog/embeddinggemma2-tests.js'

function cosine(a: number[], b: number[]): number {
  return (
    a.reduce((sum, x, i) => sum + x * b[i], 0) /
    Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) * b.reduce((sum, x) => sum + x * x, 0))
  )
}
function vectorsValid(vectors: number[][]): boolean {
  return vectors.every(
    (v) =>
      v.length === 768 &&
      v.every(Number.isFinite) &&
      Math.abs(v.reduce((sum, x) => sum + x * x, 0) - 1) < 1e-3
  )
}
const query = 'task: search result | query: '

export class EmbeddingGemma2Executor extends AbstractModelExecutor<typeof embeddingGemma2Tests> {
  pattern = /^embeddinggemma2-/

  constructor(
    resources: ResourceManager,
    private readonly resolveAsset: (
      kind: 'images' | 'audio',
      fileName: string
    ) => string | Promise<string>
  ) {
    super(resources)
  }

  private async media(kind: 'images' | 'audio', fileName: string) {
    return { media: { type: 'filePath' as const, value: await this.resolveAsset(kind, fileName) } }
  }
  protected handlers = {
    'embeddinggemma2-image-retrieval': this.images.bind(this),
    'embeddinggemma2-audio-deterministic': this.audio.bind(this),
    'embeddinggemma2-text-parity': this.text.bind(this),
    'embeddinggemma2-reject-corrupt-media': this.corrupt.bind(this),
    'embeddinggemma2-concurrent': this.concurrent.bind(this),
    'embeddinggemma2-cancel': this.cancelActive.bind(this)
  }

  async images(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const { embedding: vectors } = await embed({
      modelId,
      inputs: [
        ['title: none | text: ', await this.media('images', 'elephant.jpg')],
        ['title: none | text: ', await this.media('images', 'cat.jpg')],
        query + 'an elephant',
        query + 'an orange cat'
      ]
    })
    const passed =
      vectors.length === 4 &&
      vectorsValid(vectors) &&
      cosine(vectors[0], vectors[2]) > cosine(vectors[0], vectors[3]) &&
      cosine(vectors[1], vectors[3]) > cosine(vectors[1], vectors[2])
    return {
      passed,
      output:
        'Images must rank their matching animal text above the other animal and return unit 768-d vectors'
    }
  }

  async audio(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const inputs = [[await this.media('audio', 'sample-hi.wav')]]
    const first = await embed({ modelId, inputs })
    const second = await embed({ modelId, inputs })
    const passed =
      vectorsValid(first.embedding) &&
      vectorsValid(second.embedding) &&
      cosine(first.embedding[0], second.embedding[0]) > 0.999
    return { passed, output: 'Repeated WAV audio must produce matching unit vectors' }
  }

  async text(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const text = query + 'waterproof trail running shoes'
    const single = await embed({ modelId, text })
    const batch = await embed({ modelId, inputs: [[text.slice(0, 8), text.slice(8)]] })
    return {
      passed:
        batch.embedding.length === 1 &&
        vectorsValid(batch.embedding) &&
        cosine(single.embedding, batch.embedding[0]) > 0.99999,
      output: 'A text-only parts input must match legacy text and retain its batch result shape'
    }
  }

  async corrupt(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    try {
      await embed({ modelId, inputs: [[await this.media('audio', 'corrupted-wav.wav')]] })
      return { passed: false, output: 'Corrupt media was accepted' }
    } catch (error) {
      if (!/Unsupported or corrupt image|UnsupportedMedia/.test(String(error)))
        return { passed: false, output: String(error) }
    }
    const recovered = await embed({
      modelId,
      inputs: [[await this.media('images', 'elephant.jpg')]]
    })
    return {
      passed: vectorsValid(recovered.embedding),
      output: 'Corrupt media must fail and the next image request must succeed'
    }
  }

  async concurrent(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const inputs = [[await this.media('images', 'elephant.jpg')]]
    const reference = await embed({ modelId, inputs })
    const results = await Promise.allSettled([
      embed({ modelId, inputs }),
      embed({ modelId, inputs })
    ])
    const completed = results.filter((result) => result.status === 'fulfilled')
    const busy = results.filter(
      (result) =>
        result.status === 'rejected' && /already set or being processed/.test(String(result.reason))
    )
    const recovered = await embed({ modelId, inputs })
    return {
      passed:
        completed.length === 1 &&
        busy.length === 1 &&
        completed.every(
          (result) =>
            vectorsValid(result.value.embedding) &&
            cosine(result.value.embedding[0], reference.embedding[0]) > 0.999
        ) &&
        vectorsValid(recovered.embedding),
      output:
        'An overlapping call must reject as busy, leave the active result intact, and allow a subsequent call'
    }
  }
  async cancelActive(): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const input = [await this.media('audio', 'diarization-sample-16k.wav')]
    const call = embed({ modelId, inputs: Array.from({ length: 6 }, () => input) })
    const outcome = call.then(
      () => 'completed',
      (error: unknown) => error
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    await cancel({ requestId: call.requestId })
    const result = await outcome
    if (!(result instanceof InferenceCancelledError)) {
      return { passed: false, output: `Expected typed cancellation, got ${String(result)}` }
    }
    const recovered = await embed({
      modelId,
      inputs: [[await this.media('images', 'elephant.jpg')]]
    })
    return {
      passed: vectorsValid(recovered.embedding),
      output: 'Cancellation must retain its SDK type and allow the next image request'
    }
  }
}
