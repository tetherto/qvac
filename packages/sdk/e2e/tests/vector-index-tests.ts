// Vector index test definitions: embed() + createVectorIndex() without a RAG workspace.
import type { TestDefinition } from '@qvac/test-suite'
import type { VectorIndexStorage } from '@qvac/sdk'

export interface VectorIndexParams {
  documents: Record<string, string>
  query: string
  expectedId: string
  storage?: VectorIndexStorage
  removeId?: string
  snapshot?: boolean
}

const documents = {
  '1': 'Saturn moon Titan has lakes, clouds, and rain made of liquid methane.',
  '2': 'Solar panels convert sunlight into electricity using photovoltaic cells.',
  '3': 'Honeybees communicate the location of flowers through a waggle dance.'
}

function createVectorIndexTest(
  testId: string,
  params: VectorIndexParams,
  contains: string[],
  suites?: string[]
): TestDefinition {
  return {
    testId,
    params,
    expectation: { validation: 'contains-all', contains },
    ...(suites && { suites }),
    metadata: { category: 'vector-index', dependency: 'embeddings', estimatedDurationMs: 15000 }
  }
}

export const vectorIndexAddSearch = createVectorIndexTest(
  'vector-index-add-search',
  {
    documents,
    query: 'Which moon has methane rain and lakes?',
    expectedId: '1'
  },
  ['best:1', 'length:3'],
  ['smoke']
)

export const vectorIndexRemoveContains = createVectorIndexTest(
  'vector-index-remove-contains',
  {
    documents,
    query: 'Which moon has methane rain and lakes?',
    expectedId: '2',
    removeId: '1'
  },
  ['removed:true,false', 'present:false,true', 'length:2']
)

export const vectorIndexWriteLoad = createVectorIndexTest(
  'vector-index-write-load',
  {
    documents,
    query: 'How do bees tell each other where flowers are?',
    expectedId: '3',
    storage: 'turbovec-q2',
    snapshot: true
  },
  ['best:3', 'reloaded:3', 'reloaded-length:3', 'reloaded-storage:turbovec-q2']
)

export const vectorIndexTests = [
  vectorIndexAddSearch,
  vectorIndexRemoveContains,
  vectorIndexWriteLoad
]
