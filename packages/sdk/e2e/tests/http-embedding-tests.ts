import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * Loads an embedding model straight from a URL.
 *
 * The whole category is one call: the sharded and archive URLs exercise the
 * loader's two remote layouts, and what is being tested is that a model id
 * comes back at all.
 */
const httpLoadSteps = (extra: Step[] = []): Step[] => [
  {
    call: {
      method: 'loadModel',
      params: { modelSrc: '$params.modelUrl', modelType: '$params.modelType' },
      as: 'loaded'
    }
  },
  { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
  { assert: { on: '$modelId', named: 'nonEmptyText' } },
  ...extra
]

/**
 * The `-progress` tests are the same body.
 *
 * The executor passed an `onProgress` callback and pushed its events into an
 * array it then never looked at, so the only claim either test made was that
 * the load succeeded. Whether progress is reported is worth a test; this was
 * not one, and inventing the assertion here would be writing a new test under
 * an old id.
 */
const httpProgressSteps = httpLoadSteps

/** Embeds with the model the load step just produced. */
const embedsWithLoadedModel: Step[] = [
  { call: { method: 'embed', params: { modelId: '$modelId', text: '$params.text' }, as: 'run' } },
  { project: { from: '$run', path: 'embedding', as: 'embedding' } },
  { assert: { on: '$embedding', use: 'expectation' } }
]

const SHARDED_URL =
  'https://huggingface.co/opaninakuffo/gte-large-fp16-sharded/resolve/main/gte-large_fp16-00003-of-00005.gguf'
const ARCHIVE_URL =
  'https://huggingface.co/opaninakuffo/gte-large-fp16-sharded-tgz/resolve/main/gte-large_fp16.tgz'

export const httpShardedEmbedLoad: TestDefinition = {
  testId: 'http-sharded-embed-load',
  params: { modelType: 'llamacpp-embedding', modelUrl: SHARDED_URL },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: httpLoadSteps(),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 300000 }
}

export const httpShardedEmbedProgress: TestDefinition = {
  testId: 'http-sharded-embed-progress',
  params: { modelType: 'llamacpp-embedding', modelUrl: SHARDED_URL, trackProgress: true },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: httpProgressSteps(),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 120000 }
}

export const httpShardedEmbedInference: TestDefinition = {
  testId: 'http-sharded-embed-inference',
  params: {
    modelType: 'llamacpp-embedding',
    modelUrl: SHARDED_URL,
    text: 'This is a test sentence for embedding generation using an HTTP sharded model.'
  },
  expectation: { validation: 'type', expectedType: 'array' },
  suites: ['smoke'],
  steps: httpLoadSteps(embedsWithLoadedModel),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 300000 }
}

export const httpArchiveEmbedLoad: TestDefinition = {
  testId: 'http-archive-embed-load',
  params: { modelType: 'llamacpp-embedding', modelUrl: ARCHIVE_URL },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: httpLoadSteps(),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 300000 }
}

export const httpArchiveEmbedProgress: TestDefinition = {
  testId: 'http-archive-embed-progress',
  params: { modelType: 'llamacpp-embedding', modelUrl: ARCHIVE_URL, trackProgress: true },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: httpProgressSteps(),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 300000 }
}

export const httpArchiveEmbedInference: TestDefinition = {
  testId: 'http-archive-embed-inference',
  params: {
    modelType: 'llamacpp-embedding',
    modelUrl: ARCHIVE_URL,
    text: 'This is a test sentence for embedding generation using an HTTP archive model.'
  },
  expectation: { validation: 'type', expectedType: 'array' },
  steps: httpLoadSteps(embedsWithLoadedModel),
  metadata: { category: 'http', dependency: 'none', estimatedDurationMs: 300000 }
}

export const httpEmbeddingTests = [
  httpShardedEmbedLoad,
  httpShardedEmbedProgress,
  httpShardedEmbedInference,
  httpArchiveEmbedLoad,
  httpArchiveEmbedProgress,
  httpArchiveEmbedInference
]
