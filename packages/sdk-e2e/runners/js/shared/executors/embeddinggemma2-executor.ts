import { embed } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import type { ResourceManager } from '../resource-manager.js'
import {
  embeddingGemma2Tests,
  type VectorParams,
  type RetrievalParams,
  type AudioParams,
  type TextParityParams,
  type CorruptMediaParams
} from '../../../../catalog/embeddinggemma2-tests.js'
import { unitVectors, cosineAtLeast, moreSimilarThan } from '../vector-checks.js'

// Mobile has no step interpreter. It reads the same parameters and checks as the declarative body.
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

  private validate(
    vectors: number[][],
    length: number,
    params: VectorParams,
    expectation: Expectation
  ) {
    if (vectors.length !== length)
      return { passed: false, output: `expected ${length} vectors, got ${vectors.length}` }
    const units = unitVectors(vectors, params)
    return units.passed ? ValidationHelpers.validate(vectors, expectation) : units
  }

  protected handlers = {
    'embeddinggemma2-image-retrieval': this.images.bind(this),
    'embeddinggemma2-audio-deterministic': this.audio.bind(this),
    'embeddinggemma2-text-parity': this.text.bind(this),
    'embeddinggemma2-reject-corrupt-media': this.corrupt.bind(this)
  }

  async images(params: RetrievalParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const { embedding: vectors } = await embed({
      modelId,
      inputs: [
        [params.documentPrefix, await this.media('images', params.images[0])],
        [params.documentPrefix, await this.media('images', params.images[1])],
        ...params.queries
      ]
    })
    const valid = this.validate(
      vectors,
      params.images.length + params.queries.length,
      params,
      expectation
    )
    if (!valid.passed) return valid
    for (const [anchor, match, other] of params.pairs) {
      const comparison = moreSimilarThan(vectors[anchor], vectors[match], { than: vectors[other] })
      if (!comparison.passed) return comparison
    }
    return valid
  }

  async audio(params: AudioParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const inputs = [[await this.media('audio', params.audio)]]
    const first = await embed({ modelId, inputs })
    const second = await embed({ modelId, inputs })
    for (const response of [first, second]) {
      const valid = this.validate(response.embedding, 1, params, expectation)
      if (!valid.passed) return valid
    }
    return cosineAtLeast(first.embedding[0], second.embedding[0], params)
  }

  async text(params: TextParityParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    const single = await embed({ modelId, text: params.text })
    const batch = await embed({ modelId, inputs: [params.parts] })
    const valid = this.validate(batch.embedding, 1, params, expectation)
    if (!valid.passed) return valid
    const units = unitVectors(single.embedding, params)
    if (!units.passed) return units
    return cosineAtLeast(single.embedding, batch.embedding[0], params)
  }

  async corrupt(params: CorruptMediaParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddinggemma2')
    try {
      await embed({ modelId, inputs: [[await this.media('audio', params.audio)]] })
      return { passed: false, output: 'Corrupt media was accepted' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes(params.error.messageContains.toLowerCase()))
        return { passed: false, output: message }
    }
    const recovered = await embed({ modelId, inputs: [[await this.media('images', params.image)]] })
    return this.validate(recovered.embedding, 1, params, expectation)
  }
}
