// Vector index test definitions: embed() + createVectorIndex() without a RAG workspace.
import type { Step, TestDefinition } from '@qvac/test-suite'
import type { VectorIndexStorage } from '@qvac/sdk'

/**
 * Embeds the documents and the query, then opens an index over them.
 *
 * The index is a handle API, so every operation names the id the worker gave
 * it. That is what the wire keys on as well, which is what lets a client
 * without a handle wrapper run the same body.
 */
const openIndexSteps = (storage?: string): Step[] => [
  { useModel: { deps: ['embeddings'], as: 'model' } },
  { call: { method: 'embed', params: { modelId: '$model', text: '$params.texts' }, as: 'docs' } },
  { project: { from: '$docs', path: 'embedding', as: 'vectors' } },
  // The index needs its width up front, and the width is whatever the
  // embedding model produced -- read off the first vector rather than written
  // into the catalog, where it would be a second place to update when the
  // model changes.
  { project: { from: '$vectors', path: '[0]', count: true, as: 'dim' } },
  { call: { method: 'embed', params: { modelId: '$model', text: '$params.query' }, as: 'q' } },
  { project: { from: '$q', path: 'embedding', as: 'queryVector' } },
  {
    call: {
      method: 'createVectorIndex',
      params: { dim: '$dim', ...(storage ? { storage } : {}) },
      as: 'index'
    }
  },
  { project: { from: '$index', path: 'indexId', as: 'indexId' } },
  {
    call: {
      method: 'vectorIndexAdd',
      params: { indexId: '$indexId', ids: '$params.ids', vectors: '$vectors' },
      as: 'added'
    }
  }
]

/** The nearest neighbour for the query, bound under `as`. */
const searchSteps = (indexId: string, as: string): Step[] => [
  {
    call: {
      method: 'vectorIndexSearch',
      params: { indexId, query: '$queryVector', k: 1 },
      as: `${as}Response`
    }
  },
  { project: { from: `$${as}Response`, path: 'results[0].id', as } }
]

/** Closes whatever index the body opened, on both paths. */
const disposeIndex: Step[] = [
  { call: { method: 'vectorIndexDispose', params: { indexId: '$indexId?' } } },
  { call: { method: 'vectorIndexDispose', params: { indexId: '$reloadedId?' } } }
]

export interface VectorIndexParams {
  documents: Record<string, string>
  /** The same documents as parallel lists, which is what a step can address. */
  ids?: string[]
  texts?: string[]
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
  suites?: string[],
  steps?: Step[]
): TestDefinition {
  return {
    testId,
    // `ids` and `texts` are the same documents as parallel lists: a step can
    // address a list, not the keys of a record.
    params: {
      ...params,
      ids: Object.keys(params.documents),
      texts: Object.values(params.documents)
    },
    expectation: { validation: 'contains-all', contains },
    ...(suites && { suites }),
    ...(steps && { steps, finally: disposeIndex }),
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
  ['smoke'],
  [
    ...openIndexSteps(),
    ...searchSteps('$indexId', 'best'),
    { assert: { on: '$best', named: 'valueIn', with: { values: ['$params.expectedId'] } } },
    { project: { from: '$added', path: 'length', as: 'length' } },
    { assert: { on: '$length', named: 'valueIn', with: { values: [3] } } }
  ]
)

export const vectorIndexRemoveContains = createVectorIndexTest(
  'vector-index-remove-contains',
  {
    documents,
    query: 'Which moon has methane rain and lakes?',
    expectedId: '2',
    removeId: '1'
  },
  ['removed:true,false', 'present:false,true', 'length:2'],
  undefined,
  [
    ...openIndexSteps(),
    ...searchSteps('$indexId', 'best'),
    // The id is asked for twice on purpose: the first remove reports true, the
    // second false, which is what makes the operation idempotent rather than
    // merely tolerant.
    {
      call: {
        method: 'vectorIndexRemove',
        params: { indexId: '$indexId', ids: ['$params.removeId', '$params.removeId'] },
        as: 'removal'
      }
    },
    { project: { from: '$removal', path: 'removed', join: ',', as: 'removed' } },
    { assert: { on: '$removed', named: 'valueIn', with: { values: ['true,false'] } } },
    {
      call: {
        method: 'vectorIndexContains',
        params: { indexId: '$indexId', ids: ['$params.removeId', '$params.expectedId'] },
        as: 'presence'
      }
    },
    { project: { from: '$presence', path: 'present', join: ',', as: 'present' } },
    { assert: { on: '$present', named: 'valueIn', with: { values: ['false,true'] } } },
    { project: { from: '$removal', path: 'length', as: 'length' } },
    { assert: { on: '$length', named: 'valueIn', with: { values: [2] } } },
    ...searchSteps('$indexId', 'afterRemove'),
    {
      assert: {
        on: '$afterRemove',
        named: 'valueIn',
        with: { values: ['$params.expectedId'] }
      }
    }
  ]
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
  ['best:3', 'reloaded:3', 'reloaded-length:3', 'reloaded-storage:turbovec-q2'],
  undefined,
  [
    ...openIndexSteps('$params.storage'),
    ...searchSteps('$indexId', 'best'),
    { assert: { on: '$best', named: 'valueIn', with: { values: ['$params.expectedId'] } } },
    // A fixed name, so repeated runs overwrite one file instead of
    // accumulating snapshots in the data directory.
    {
      call: {
        method: 'vectorIndexWrite',
        params: { indexId: '$indexId', path: 'vector-index-e2e/catalog.qvi' },
        as: 'written'
      }
    },
    { call: { method: 'vectorIndexDispose', params: { indexId: '$indexId' } } },
    {
      call: {
        method: 'loadVectorIndex',
        params: { path: 'vector-index-e2e/catalog.qvi' },
        as: 'reloaded'
      }
    },
    { project: { from: '$reloaded', path: 'indexId', as: 'reloadedId' } },
    ...searchSteps('$reloadedId', 'reloadedBest'),
    {
      assert: {
        on: '$reloadedBest',
        named: 'valueIn',
        with: { values: ['$params.expectedId'] }
      }
    },
    { project: { from: '$reloaded', path: 'length', as: 'reloadedLength' } },
    { assert: { on: '$reloadedLength', named: 'valueIn', with: { values: [3] } } },
    { project: { from: '$reloaded', path: 'storage', as: 'reloadedStorage' } },
    {
      assert: {
        on: '$reloadedStorage',
        named: 'valueIn',
        with: { values: ['$params.storage'] }
      }
    }
  ]
)

export const vectorIndexTests = [
  vectorIndexAddSearch,
  vectorIndexRemoveContains,
  vectorIndexWriteLoad
]
