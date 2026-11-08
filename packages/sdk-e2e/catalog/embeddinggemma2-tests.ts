import type { Step, TestDefinition } from '@qvac/test-suite'

export type VectorParams = { dimensions: number; tolerance: number }
export type RetrievalParams = VectorParams & {
  images: [string, string]
  documentPrefix: string
  queries: [string, string]
  pairs: Array<[number, number, number]>
}
export type AudioParams = VectorParams & { audio: string; min: number }
export type TextParityParams = VectorParams & { text: string; parts: string[]; min: number }
export type CorruptMediaParams = VectorParams & {
  audio: string
  image: string
  error: { messageContains: string }
}

const media = (value: string) => ({ media: { type: 'filePath', value } })
const loadModel: Step = { useModel: { deps: ['embeddinggemma2'], as: 'model' } }
const embed = (inputs: unknown, as: string): Step => ({
  call: { method: 'embed', params: { modelId: '$model', inputs }, as }
})
const unitVectors = (on: string): Step => ({
  assert: {
    on,
    named: 'unitVectors',
    with: { dimensions: '$params.dimensions', tolerance: '$params.tolerance' }
  }
})
const vectors = (from: string, as: string, length: number): Step[] => [
  { project: { from, path: 'embedding', as } },
  { assert: { on: `$${as}`, named: 'lengthIs', with: { length } } },
  unitVectors(`$${as}`),
  { assert: { on: `$${as}`, use: 'expectation' } }
]

function retrievalSteps({ pairs }: RetrievalParams): Step[] {
  return [
    loadModel,
    { asset: { kind: 'image', file: '$params.images[0]', form: 'path', as: 'elephant' } },
    { asset: { kind: 'image', file: '$params.images[1]', form: 'path', as: 'cat' } },
    embed(
      [
        ['$params.documentPrefix', media('$elephant')],
        ['$params.documentPrefix', media('$cat')],
        '$params.queries[0]',
        '$params.queries[1]'
      ],
      'response'
    ),
    ...vectors('$response', 'vectors', 4),
    ...[0, 1, 2, 3].map((i): Step => ({
      project: { from: '$response', path: `embedding[${i}]`, as: `v${i}` }
    })),
    ...pairs.map(([anchor, match, other]): Step => ({
      compare: {
        left: `$v${anchor}`,
        right: `$v${match}`,
        named: 'moreSimilarThan',
        with: { than: `$v${other}` }
      }
    }))
  ]
}

const audioSteps: Step[] = [
  loadModel,
  { asset: { kind: 'audio', file: '$params.audio', form: 'path', as: 'wav' } },
  embed([[media('$wav')]], 'first'),
  embed([[media('$wav')]], 'second'),
  ...vectors('$first', 'firstVectors', 1),
  ...vectors('$second', 'secondVectors', 1),
  { project: { from: '$first', path: 'embedding[0]', as: 'a' } },
  { project: { from: '$second', path: 'embedding[0]', as: 'b' } },
  { compare: { left: '$a', right: '$b', named: 'cosineAtLeast', with: { min: '$params.min' } } }
]
const textParitySteps: Step[] = [
  loadModel,
  { call: { method: 'embed', params: { modelId: '$model', text: '$params.text' }, as: 'single' } },
  embed(['$params.parts'], 'batch'),
  ...vectors('$batch', 'batchVectors', 1),
  { project: { from: '$single', path: 'embedding', as: 'singleVector' } },
  unitVectors('$singleVector'),
  { project: { from: '$batch', path: 'embedding[0]', as: 'batchVector' } },
  {
    compare: {
      left: '$singleVector',
      right: '$batchVector',
      named: 'cosineAtLeast',
      with: { min: '$params.min' }
    }
  }
]
const corruptMediaSteps: Step[] = [
  loadModel,
  { asset: { kind: 'audio', file: '$params.audio', form: 'path', as: 'corrupt' } },
  {
    callError: {
      method: 'embed',
      params: { modelId: '$model', inputs: [[media('$corrupt')]] },
      as: 'err'
    }
  },
  {
    assert: {
      on: '$err',
      named: 'errorMatches',
      with: { messageContains: '$params.error.messageContains' }
    }
  },
  { asset: { kind: 'image', file: '$params.image', form: 'path', as: 'elephant' } },
  embed([[media('$elephant')]], 'recovered'),
  ...vectors('$recovered', 'recoveredVectors', 1)
]

const query = 'task: search result | query: '
const vectorParams: VectorParams = { dimensions: 768, tolerance: 1e-3 }
const retrievalParams: RetrievalParams = {
  ...vectorParams,
  images: ['elephant.jpg', 'cat.jpg'],
  documentPrefix: 'title: none | text: ',
  queries: [query + 'an elephant', query + 'an orange cat'],
  pairs: [
    [0, 2, 3],
    [1, 3, 2]
  ]
}
const text = query + 'waterproof trail running shoes'
const audioParams: AudioParams = { ...vectorParams, audio: 'sample-hi.wav', min: 0.999 }
const parityParams: TextParityParams = {
  ...vectorParams,
  text,
  parts: [text.slice(0, 8), text.slice(8)],
  min: 0.99999
}
const corruptParams: CorruptMediaParams = {
  ...vectorParams,
  audio: 'corrupted-wav.wav',
  image: 'elephant.jpg',
  error: { messageContains: 'Unsupported or corrupt image' }
}

function definition(name: string, params: unknown, steps: Step[]): TestDefinition {
  return {
    testId: `embeddinggemma2-${name}`,
    params,
    expectation: { validation: 'type', expectedType: 'array' },
    steps,
    metadata: { category: 'embedding', dependency: 'embeddinggemma2', estimatedDurationMs: 60000 }
  }
}

// Compare on the same device; no checkpoint-specific vector values are assumed.
export const embeddingGemma2Tests: TestDefinition[] = [
  definition('image-retrieval', retrievalParams, retrievalSteps(retrievalParams)),
  definition('audio-deterministic', audioParams, audioSteps),
  definition('text-parity', parityParams, textParitySteps),
  definition('reject-corrupt-media', corruptParams, corruptMediaSteps)
]
