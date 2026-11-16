// Vector index test definitions: embed() + createVectorIndex() without a RAG workspace.
import type { Step, TestDefinition } from '@qvac/test-suite'
import type { VectorIndexStorage } from './wire-types.js'

/** Embeds the documents and the query, then opens an index over them. */
const openIndexSteps = (storage?: string): Step[] => [
  { useModel: { deps: ['embeddings'], as: 'model' } },
  { call: { method: 'embed', params: { modelId: '$model', text: '$params.texts' }, as: 'docs' } },
  { project: { from: '$docs', path: 'embedding', as: 'vectors' } },
  // The index needs its width up front, and the width is whatever the embedding model produced --
  // read off the first vector rather than written into the catalog, where it would be a second
  // place to update when the model changes.
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
    // `ids` and `texts` are the same documents as parallel lists: a step can address a list, not
    // the keys of a record.
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
    // Three documents are below the 1,000-vector calibration threshold.
    { project: { from: '$added', path: 'calibrated', as: 'calibrated' } },
    { assert: { on: '$calibrated', named: 'valueIn', with: { values: [false] } } },
    {
      call: {
        method: 'vectorIndexSetStagedSearch',
        params: { indexId: '$indexId', enabled: true },
        as: 'staged'
      }
    },
    { project: { from: '$staged', path: 'stagedSearch', as: 'enabled' } },
    { assert: { on: '$enabled', named: 'valueIn', with: { values: [true] } } },
    {
      call: {
        method: 'vectorIndexSetStagedSearch',
        params: { indexId: '$indexId', enabled: false }
      }
    },
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
    // The id is asked for twice on purpose: the first remove reports true, the second false, which
    // is what makes the operation idempotent rather than merely tolerant.
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
    {
      call: { method: 'vectorIndexSetStagedSearch', params: { indexId: '$indexId', enabled: true } }
    },
    ...searchSteps('$indexId', 'best'),
    { assert: { on: '$best', named: 'valueIn', with: { values: ['$params.expectedId'] } } },
    // A fixed name, so repeated runs overwrite one file instead of accumulating snapshots in the
    // data directory.
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
    { project: { from: '$reloaded', path: 'stagedSearch', as: 'reloadedStaged' } },
    { assert: { on: '$reloadedStaged', named: 'valueIn', with: { values: [false] } } },
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

/** Params for the storage rejection case, which opens an empty index instead of embedding. */
export interface VectorIndexRejectionParams {
  dim: number
  storage: VectorIndexStorage
}

// Staged search is refused by storage type, so an empty index is enough and no model loads.
export const vectorIndexStagedSearchUnsupported: TestDefinition = {
  testId: 'vector-index-staged-search-unsupported',
  params: { dim: 8, storage: 'q8' } satisfies VectorIndexRejectionParams,
  expectation: { validation: 'throws-error', errorContains: 'InvalidArgument' },
  steps: [
    {
      call: {
        method: 'createVectorIndex',
        params: { dim: '$params.dim', storage: '$params.storage' },
        as: 'index'
      }
    },
    { project: { from: '$index', path: 'indexId', as: 'indexId' } },
    {
      callError: {
        method: 'vectorIndexSetStagedSearch',
        params: { indexId: '$indexId', enabled: true },
        as: 'error'
      }
    },
    { project: { from: '$error', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  finally: disposeIndex,
  metadata: { category: 'vector-index', dependency: 'none', estimatedDurationMs: 2000 }
}

/** Params for the IVF cases, which index fixed vectors instead of embeddings. */
export interface VectorIndexIvfParams {
  dim: number
  ids: string[]
  vectors: number[][]
  query: number[]
  expectedId: string
  nLists: number
  nProbe: number
  /** Per-search override, at least `nLists` so the search scans every entry. */
  searchNProbe: number
}

// Each orthogonal unit vector is its own nearest neighbour in every storage mode,
// so results depend on neither a model nor quantisation.
const unitVectors = Array.from({ length: 8 }, (_row, i) =>
  Array.from({ length: 8 }, (_column, j) => (i === j ? 1 : 0))
)
const ivfParams = {
  dim: 8,
  ids: unitVectors.map((_row, i) => String(i + 1)),
  vectors: unitVectors,
  query: unitVectors[2] ?? [],
  expectedId: '3',
  nLists: 4,
  nProbe: 1,
  searchNProbe: 4
} satisfies VectorIndexIvfParams

const openFixedIndexSteps: Step[] = [
  { call: { method: 'createVectorIndex', params: { dim: '$params.dim' }, as: 'index' } },
  { project: { from: '$index', path: 'indexId', as: 'indexId' } },
  {
    call: {
      method: 'vectorIndexAdd',
      params: { indexId: '$indexId', ids: '$params.ids', vectors: '$params.vectors' }
    }
  }
]

const setIvfStep: Step = {
  call: {
    method: 'vectorIndexSetIvf',
    params: { indexId: '$indexId', ivf: { nLists: '$params.nLists', nProbe: '$params.nProbe' } },
    as: 'ivfState'
  }
}

const ivfSearchSteps: Step[] = [
  {
    call: {
      method: 'vectorIndexSearch',
      params: { indexId: '$indexId', query: '$params.query', k: 1, nProbe: '$params.searchNProbe' },
      as: 'bestResponse'
    }
  },
  { project: { from: '$bestResponse', path: 'results[0].id', as: 'best' } },
  { assert: { on: '$best', named: 'valueIn', with: { values: ['$params.expectedId'] } } }
]

export const vectorIndexIvfSearch: TestDefinition = {
  testId: 'vector-index-ivf-search',
  params: ivfParams,
  expectation: { validation: 'contains-all', contains: ['best:3'] },
  steps: [
    ...openFixedIndexSteps,
    setIvfStep,
    { project: { from: '$ivfState', path: 'ivf.built', as: 'built' } },
    { assert: { on: '$built', named: 'valueIn', with: { values: [true] } } },
    ...ivfSearchSteps
  ],
  finally: disposeIndex,
  metadata: { category: 'vector-index', dependency: 'none', estimatedDurationMs: 2000 }
}

// Stale IVF lists after an add must fall back to a full scan instead of failing.
export const vectorIndexIvfStale: TestDefinition = {
  testId: 'vector-index-ivf-stale',
  params: ivfParams,
  expectation: { validation: 'contains-all', contains: ['built:false', 'best:3'] },
  steps: [
    ...openFixedIndexSteps,
    setIvfStep,
    {
      call: {
        method: 'vectorIndexAdd',
        params: { indexId: '$indexId', ids: ['9'], vectors: ['$params.query'] },
        as: 'added'
      }
    },
    { project: { from: '$added', path: 'ivf.built', as: 'built' } },
    { assert: { on: '$built', named: 'valueIn', with: { values: [false] } } },
    ...ivfSearchSteps
  ],
  finally: disposeIndex,
  metadata: { category: 'vector-index', dependency: 'none', estimatedDurationMs: 2000 }
}

export const vectorIndexIvfProbeWithoutIvf: TestDefinition = {
  testId: 'vector-index-ivf-probe-without-ivf',
  params: ivfParams,
  expectation: { validation: 'throws-error', errorContains: 'nProbe applies only to IVF search' },
  steps: [
    ...openFixedIndexSteps,
    {
      callError: {
        method: 'vectorIndexSearch',
        params: {
          indexId: '$indexId',
          query: '$params.query',
          k: 1,
          nProbe: '$params.searchNProbe'
        },
        as: 'error'
      }
    },
    { project: { from: '$error', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  finally: disposeIndex,
  metadata: { category: 'vector-index', dependency: 'none', estimatedDurationMs: 2000 }
}

export const vectorIndexTests = [
  vectorIndexAddSearch,
  vectorIndexRemoveContains,
  vectorIndexWriteLoad,
  vectorIndexStagedSearchUnsupported,
  vectorIndexIvfSearch,
  vectorIndexIvfStale,
  vectorIndexIvfProbeWithoutIvf
]
