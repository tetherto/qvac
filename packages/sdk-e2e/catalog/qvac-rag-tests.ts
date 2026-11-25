// @qvac/rag end to end, with a real embeddings model.
//
// Every case runs on two drivers:
// - `bare`: the `rag-e2e-plugin` fixture runs @qvac/rag inside the SDK worker (Bare, native
//   TurboVec), reached with `invokePlugin`, embedding in-process on the loaded model.
// - `node`: the consumer runs @qvac/rag itself with an embeddings port over the SDK's `embed()`,
//   through the `ragLocal` step binding.
// Both run the same ops (`plugins/rag/ops.js`) and answer under `result`.
import type { Step, TestDefinition } from '@qvac/test-suite'

type Driver = 'bare' | 'node'

const NS = 'docs'

/** Four short documents on unrelated topics: a query about one has a clear top hit. */
const CORPUS = [
  {
    id: 'volcanoes',
    text: 'Volcanoes erupt when magma rises through the crust and lava flows down the slopes.',
    metadata: { title: 'Volcanoes' }
  },
  {
    id: 'cats',
    text: 'Cats are small domesticated felines that purr, hunt mice and sleep most of the day.'
  },
  {
    id: 'tax',
    text: 'Filing your income tax return requires reporting wages, deductions and credits to the revenue agency.'
  },
  {
    id: 'chess',
    text: 'Chess is a board game where each player moves sixteen pieces to checkmate the opposing king.'
  }
]

/** One document in three chunks, with a title and a page per chunk for citations. */
const MANUAL = {
  id: 'manual',
  metadata: { title: 'Field Manual' },
  chunks: [
    { content: 'Pitch the tent on flat ground away from the river.', metadataJson: '{"page":1}' },
    { content: 'Purify stream water by boiling it for one minute.', metadataJson: '{"page":2}' },
    { content: 'Store food in a sealed bag hung from a tree branch.', metadataJson: '{"page":3}' }
  ]
}

/** One @qvac/rag op on the test's driver, its answer bound to `as` (the whole call result). */
function op(driver: Driver, name: string, params: Record<string, unknown>, as?: string): Step {
  return driver === 'bare'
    ? {
        call: {
          method: 'invokePlugin',
          params: { modelId: '$rag', handler: name, params },
          ...(as && { as })
        }
      }
    : { call: { method: 'ragLocal', params: { op: name, params }, ...(as && { as }) } }
}

/** `op`, started without waiting, so a later `settle` can bound how long it takes. */
function startOp(driver: Driver, name: string, params: Record<string, unknown>, as: string): Step {
  const { call } = op(driver, name, params) as { call: { method: string; params: unknown } }
  return { start: { method: call.method, params: call.params, as } } as Step
}

/** Loads the models and opens a fresh store named `main` with the `docs` namespace. */
function setup(driver: Driver): Step[] {
  return [
    { useModel: { deps: ['embeddings'], as: 'embed' } },
    ...(driver === 'bare' ? [{ useModel: { deps: ['rag-e2e'], as: 'rag' } } as Step] : []),
    op(driver, 'open', { store: 'main', embedModelId: '$embed', fresh: true }),
    op(driver, 'createNamespace', { store: 'main', name: NS })
  ]
}

const ingestCorpus = (driver: Driver, as?: string): Step =>
  op(driver, 'ingest', { store: 'main', namespace: NS, documents: '$params.corpus' }, as)

const project = (
  from: string,
  path: string,
  as: string,
  extra: Record<string, unknown> = {}
): Step => ({
  project: { from, path, as, ...extra }
})

const named = (on: string, name: string, args?: Record<string, unknown>): Step => ({
  assert: { on, named: name, ...(args && { with: args }) }
})

/** The rejection an op captured, checked by error name (its code key in @qvac/rag). */
function rejects(
  driver: Driver,
  opName: string,
  params: Record<string, unknown>,
  errorName: string
): Step[] {
  return [
    op(driver, opName, { ...params, capture: true }, 'captured'),
    project('$captured', 'result.error', 'error'),
    named('$error', 'fieldsMatch', { fields: ['name'], expected: { name: errorName } })
  ]
}

interface Case {
  id: string
  /** What the case shows, for the report. */
  about: string
  steps: (driver: Driver) => Step[]
  /** Defaults to both drivers. */
  drivers?: Driver[]
  /** The model-output check: a hit or field the definition's expectation applies to. */
  expectation?: TestDefinition['expectation']
  smoke?: Driver[]
  durationMs?: number
}

// Cases whose checks are all named assertions still need an expectation; nothing applies it.
const UNUSED: TestDefinition['expectation'] = { validation: 'type', expectedType: 'string' }

const CASES: Case[] = [
  // --- search -----------------------------------------------------------------------------
  {
    id: 'search-top-hit',
    about: 'a query is answered by the document it is about',
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    smoke: ['bare'],
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 4 },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 4 }),
      named('$hits', 'sortedDescendingBy', { field: 'score' }),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'search-k-beyond-corpus',
    about: 'k larger than the namespace returns every chunk once',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'search', { store: 'main', scope: { namespace: NS }, query: 'cats', k: 50 }, 'found'),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 4 })
    ]
  },
  {
    id: 'search-vector',
    about: 'a vector query finds what the text query finds',
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'search',
        {
          store: 'main',
          scope: { namespace: NS },
          vectorOf: 'lava eruption',
          embedModelId: '$embed',
          k: 2
        },
        'found'
      ),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'search-per-document',
    about: 'perDocument caps hits per document: one each instead of every manual chunk',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'ingest', { store: 'main', namespace: NS, documents: [MANUAL] }),
      op(d, 'search', { store: 'main', scope: { namespace: NS }, query: 'camping', k: 20 }, 'all'),
      project('$all', 'result.hits', 'allHits'),
      named('$allHits', 'lengthIs', { length: 7 }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'camping', k: 20, perDocument: 1 },
        'spread'
      ),
      project('$spread', 'result.hits', 'spreadHits'),
      named('$spreadHits', 'lengthIs', { length: 5 })
    ]
  },
  {
    id: 'search-min-score',
    about: 'minScore keeps only the strong match, and drops everything above any real score',
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 4, minScore: 0.8 },
        'strong'
      ),
      project('$strong', 'result.hits', 'strongHits'),
      named('$strongHits', 'lengthIs', { length: 1 }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 4, minScore: 0.999 },
        'none'
      ),
      project('$none', 'result.hits', 'noHits'),
      named('$noHits', 'lengthIs', { length: 0 }),
      project('$strong', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'search-citations',
    about: 'a hit carries its document title, chunk page, generation and chunk count',
    expectation: { validation: 'contains-all', contains: ['Purify'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'ingest', { store: 'main', namespace: NS, documents: [MANUAL] }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'boil drinking water', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0]', 'hit'),
      named('$hit', 'fieldsMatch', {
        fields: ['documentId', 'ordinal', 'generation', 'chunkCount'],
        expected: { documentId: 'manual', ordinal: 1, generation: 1, chunkCount: 3 }
      }),
      project('$hit', 'citation', 'citation'),
      named('$citation', 'fieldsMatch', {
        fields: ['title', 'page'],
        expected: { title: 'Field Manual', page: 2 }
      }),
      project('$hit', 'content', 'content'),
      { assert: { on: '$content', use: 'expectation' } }
    ]
  },
  {
    id: 'search-scope-documents',
    about: 'scope.documentIds keeps hits inside the listed documents',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'search',
        {
          store: 'main',
          scope: { namespace: NS, documentIds: ['cats', 'tax'] },
          query: 'lava eruption',
          k: 4
        },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 2 }),
      project('$found', 'result.hits[*].documentId', 'ids', { join: ',' }),
      named('$ids', 'containsAll', { terms: ['cats', 'tax'] })
    ]
  },
  {
    id: 'search-scoped-handle',
    about: 'a scoped handle searches only its documents',
    expectation: { validation: 'contains-all', contains: ['chess'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'scopedSearch',
        {
          store: 'main',
          scope: { namespace: NS, documentIds: ['chess'] },
          query: 'lava eruption',
          k: 4
        },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 1 }),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'search-empty-namespace',
    about: 'searching a namespace with no documents returns no hits',
    steps: (d) => [
      ...setup(d),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'anything', k: 3 },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 0 })
    ]
  },
  {
    id: 'search-unknown-namespace',
    about: 'searching a namespace that does not exist fails with NAMESPACE_NOT_FOUND',
    steps: (d) => [
      ...setup(d),
      ...rejects(
        d,
        'search',
        { store: 'main', scope: { namespace: 'missing' }, query: 'cats', k: 1 },
        'NAMESPACE_NOT_FOUND'
      )
    ]
  },
  {
    id: 'search-after-close',
    about: 'a closed instance refuses to search',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      ...rejects(
        d,
        'searchAfterClose',
        { store: 'main', scope: { namespace: NS }, query: 'cats', k: 1 },
        'NOT_READY'
      )
    ]
  },

  // --- ingest -----------------------------------------------------------------------------
  {
    id: 'ingest-text',
    about: 'text documents are chunked, embedded and committed at generation 1',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d, 'ingested'),
      project('$ingested', 'result', 'result'),
      named('$result', 'fieldsMatch', { fields: ['cancelled'], expected: { cancelled: false } }),
      project('$ingested', 'result.documents', 'documents'),
      named('$documents', 'lengthIs', { length: 4 }),
      project('$ingested', 'result.documents[0]', 'first'),
      named('$first', 'fieldsMatch', {
        fields: ['id', 'generation', 'chunkCount', 'status'],
        expected: { id: 'volcanoes', generation: 1, chunkCount: 1, status: 'created' }
      })
    ]
  },
  {
    id: 'ingest-pre-embedded',
    about: 'chunks embedded by the caller are searchable by text',
    expectation: { validation: 'contains-all', contains: ['manual'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'ingest',
        { store: 'main', namespace: NS, documents: [MANUAL], embedWith: '$embed' },
        'ingested'
      ),
      project('$ingested', 'result.documents[0]', 'doc'),
      named('$doc', 'fieldsMatch', {
        fields: ['id', 'chunkCount'],
        expected: { id: 'manual', chunkCount: 3 }
      }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'hang food from a tree', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'ingest-empty',
    about: 'an empty document list is refused as INVALID_INPUT',
    steps: (d) => [
      ...setup(d),
      ...rejects(d, 'ingest', { store: 'main', namespace: NS, documents: [] }, 'INVALID_INPUT')
    ]
  },
  {
    id: 'ingest-reingest',
    about: 'ingesting an id again replaces it at the next generation',
    expectation: { validation: 'contains-all', contains: ['cats'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'ingest',
        {
          store: 'main',
          namespace: NS,
          documents: [
            { id: 'cats', text: 'Lions roar across the savanna while the pride hunts zebra.' }
          ]
        },
        'again'
      ),
      project('$again', 'result.documents[0]', 'doc'),
      named('$doc', 'fieldsMatch', {
        fields: ['id', 'generation', 'status'],
        expected: { id: 'cats', generation: 2, status: 'replaced' }
      }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lion pride on the savanna', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0]', 'hit'),
      named('$hit', 'fieldsMatch', {
        fields: ['documentId', 'generation'],
        expected: { documentId: 'cats', generation: 2 }
      }),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'ingest-cancel',
    about: 'aborting after the first commit keeps that document and skips the rest',
    steps: (d) => [
      ...setup(d),
      op(
        d,
        'ingest',
        { store: 'main', namespace: NS, documents: '$params.corpus', abortAfterDocuments: 1 },
        'ingested'
      ),
      project('$ingested', 'result', 'result'),
      named('$result', 'fieldsMatch', { fields: ['cancelled'], expected: { cancelled: true } }),
      project('$ingested', 'result.documents', 'documents'),
      named('$documents', 'lengthIs', { length: 1 }),
      project('$ingested', 'result.skipped', 'skipped'),
      named('$skipped', 'lengthIs', { length: 3 }),
      op(d, 'listDocuments', { store: 'main', namespace: NS }, 'listed'),
      project('$listed', 'result.documents', 'stored'),
      named('$stored', 'lengthIs', { length: 1 })
    ]
  },
  {
    id: 'ingest-space-mismatch',
    about: 'text ingest into a namespace of another embedding space fails',
    steps: (d) => [
      ...setup(d),
      op(d, 'createNamespace', { store: 'main', name: 'small', dimensions: 384 }),
      ...rejects(
        d,
        'ingest',
        { store: 'main', namespace: 'small', documents: [{ id: 'x', text: 'hello' }] },
        'EMBEDDING_SPACE_MISMATCH'
      )
    ]
  },
  {
    id: 'ingest-dimension-mismatch',
    about:
      'a pre-embedded chunk of the wrong length, in the namespace space, is refused as EMBEDDING_DIMENSION_MISMATCH',
    steps: (d) => [
      ...setup(d),
      ...rejects(
        d,
        'ingest',
        {
          store: 'main',
          namespace: NS,
          inSpace: true,
          documents: [{ id: 'x', chunks: [{ content: 'hello', embedding: [0.1, 0.2, 0.3] }] }]
        },
        'EMBEDDING_DIMENSION_MISMATCH'
      )
    ]
  },
  {
    id: 'ingest-unknown-namespace',
    about: 'ingest into a namespace that does not exist fails with NAMESPACE_NOT_FOUND',
    steps: (d) => [
      ...setup(d),
      ...rejects(
        d,
        'ingest',
        { store: 'main', namespace: 'missing', documents: [{ id: 'x', text: 'hello' }] },
        'NAMESPACE_NOT_FOUND'
      )
    ]
  },

  // --- documents --------------------------------------------------------------------------
  {
    id: 'read-document-pages',
    about: 'readDocument pages through chunks in order',
    expectation: { validation: 'contains-all', contains: ['Store food'] },
    steps: (d) => [
      ...setup(d),
      op(d, 'ingest', { store: 'main', namespace: NS, documents: [MANUAL] }),
      op(
        d,
        'readDocument',
        { store: 'main', namespace: NS, documentId: 'manual', limit: 2 },
        'first'
      ),
      project('$first', 'result', 'page1'),
      named('$page1', 'fieldsMatch', {
        fields: ['generation', 'chunkCount', 'nextOrdinal'],
        expected: { generation: 1, chunkCount: 3, nextOrdinal: 2 }
      }),
      project('$first', 'result.chunks', 'chunks1'),
      named('$chunks1', 'lengthIs', { length: 2 }),
      op(
        d,
        'readDocument',
        { store: 'main', namespace: NS, documentId: 'manual', fromOrdinal: 2, generation: 1 },
        'second'
      ),
      project('$second', 'result', 'page2'),
      named('$page2', 'fieldsMatch', { fields: ['nextOrdinal'], expected: { nextOrdinal: null } }),
      project('$second', 'result.chunks[0].content', 'last'),
      { assert: { on: '$last', use: 'expectation' } }
    ]
  },
  {
    id: 'read-document-changed',
    about: 'reading an old generation after a re-ingest fails with DOCUMENT_CHANGED',
    steps: (d) => [
      ...setup(d),
      op(d, 'ingest', { store: 'main', namespace: NS, documents: [MANUAL] }),
      op(d, 'ingest', {
        store: 'main',
        namespace: NS,
        documents: [{ id: 'manual', text: 'Rewritten.' }]
      }),
      ...rejects(
        d,
        'readDocument',
        { store: 'main', namespace: NS, documentId: 'manual', generation: 1 },
        'DOCUMENT_CHANGED'
      )
    ]
  },
  {
    id: 'list-documents-pages',
    about: 'listDocuments pages in document id order',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'listDocuments', { store: 'main', namespace: NS, limit: 2 }, 'first'),
      project('$first', 'result.documents[*].documentId', 'ids1', { join: ',' }),
      named('$ids1', 'equalsJoined', { parts: ['cats', 'chess'], separator: ',' }),
      project('$first', 'result', 'page1'),
      named('$page1', 'fieldsMatch', { fields: ['next'], expected: { next: 'chess' } }),
      op(d, 'listDocuments', { store: 'main', namespace: NS, limit: 2, after: 'chess' }, 'second'),
      project('$second', 'result.documents[*].documentId', 'ids2', { join: ',' }),
      named('$ids2', 'equalsJoined', { parts: ['tax', 'volcanoes'], separator: ',' })
    ]
  },
  {
    id: 'delete-documents',
    about: 'a deleted document leaves search and the document list',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(
        d,
        'deleteDocuments',
        { store: 'main', namespace: NS, documentIds: ['volcanoes'] },
        'deleted'
      ),
      project('$deleted', 'result.deleted', 'ids'),
      named('$ids', 'lengthIs', { length: 1 }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 4 },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 3 }),
      op(d, 'listDocuments', { store: 'main', namespace: NS }, 'listed'),
      project('$listed', 'result.documents', 'stored'),
      named('$stored', 'lengthIs', { length: 3 })
    ]
  },

  // --- namespaces -------------------------------------------------------------------------
  {
    id: 'namespace-create-again',
    about: 'creating a namespace again in the same space returns it; another space is refused',
    steps: (d) => [
      ...setup(d),
      op(d, 'createNamespace', { store: 'main', name: NS }, 'again'),
      project('$again', 'result', 'info'),
      named('$info', 'fieldsMatch', { fields: ['name'], expected: { name: NS } }),
      ...rejects(
        d,
        'createNamespace',
        { store: 'main', name: NS, dimensions: 384 },
        'NAMESPACE_EXISTS'
      )
    ]
  },
  {
    id: 'namespace-list',
    about: 'listNamespaces reports each namespace with its counts',
    steps: (d) => [
      ...setup(d),
      op(d, 'createNamespace', { store: 'main', name: 'notes' }),
      ingestCorpus(d),
      op(d, 'ingest', { store: 'main', namespace: NS, documents: [MANUAL] }),
      op(d, 'listNamespaces', { store: 'main' }, 'listed'),
      project('$listed', 'result.namespaces', 'namespaces'),
      named('$namespaces', 'lengthIs', { length: 2 }),
      project('$listed', 'result.namespaces[0]', 'docs'),
      named('$docs', 'fieldsMatch', {
        fields: ['name', 'documentCount', 'chunkCount'],
        expected: { name: NS, documentCount: 5, chunkCount: 7 }
      }),
      project('$listed', 'result.namespaces[1]', 'notes'),
      named('$notes', 'fieldsMatch', {
        fields: ['name', 'documentCount', 'chunkCount'],
        expected: { name: 'notes', documentCount: 0, chunkCount: 0 }
      })
    ]
  },
  {
    id: 'namespace-drop',
    about: 'dropNamespace removes the namespace and its documents; a new one starts empty',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'dropNamespace', { store: 'main', name: NS }, 'dropped'),
      project('$dropped', 'result', 'result'),
      named('$result', 'fieldsMatch', {
        fields: ['name', 'documentCount', 'chunkCount'],
        expected: { name: NS, documentCount: 4, chunkCount: 4 }
      }),
      op(d, 'listNamespaces', { store: 'main' }, 'after'),
      project('$after', 'result.namespaces', 'namespaces'),
      named('$namespaces', 'lengthIs', { length: 0 }),
      op(d, 'createNamespace', { store: 'main', name: NS }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 4 },
        'found'
      ),
      project('$found', 'result.hits', 'hits'),
      named('$hits', 'lengthIs', { length: 0 })
    ]
  },
  {
    id: 'namespace-drop-unknown',
    about: 'dropping a namespace that does not exist fails with NAMESPACE_NOT_FOUND',
    steps: (d) => [
      ...setup(d),
      ...rejects(d, 'dropNamespace', { store: 'main', name: 'missing' }, 'NAMESPACE_NOT_FOUND')
    ]
  },

  // --- export and import ------------------------------------------------------------------
  {
    id: 'transfer-round-trip',
    about: 'an exported namespace imports into another store and answers the same query',
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'open', { store: 'copy', embedModelId: '$embed', fresh: true }),
      op(d, 'transfer', { from: 'main', to: 'copy', namespace: NS }, 'imported'),
      project('$imported', 'result', 'result'),
      named('$result', 'fieldsMatch', { fields: ['cancelled'], expected: { cancelled: false } }),
      project('$imported', 'result.documents', 'documents'),
      named('$documents', 'lengthIs', { length: 4 }),
      project('$imported', 'result.skipped', 'skipped'),
      named('$skipped', 'lengthIs', { length: 0 }),
      op(
        d,
        'search',
        { store: 'copy', scope: { namespace: NS }, query: 'lava eruption', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'transfer-subset',
    about: 'exporting chosen documents imports only those',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'open', { store: 'copy', embedModelId: '$embed', fresh: true }),
      op(
        d,
        'transfer',
        { from: 'main', to: 'copy', namespace: NS, documentIds: ['cats', 'chess'] },
        'imported'
      ),
      project('$imported', 'result.documents[*].id', 'ids', { join: ',' }),
      named('$ids', 'equalsJoined', { parts: ['cats', 'chess'], separator: ',' }),
      op(d, 'listDocuments', { store: 'copy', namespace: NS }, 'listed'),
      project('$listed', 'result.documents', 'stored'),
      named('$stored', 'lengthIs', { length: 2 })
    ]
  },
  {
    id: 'transfer-lineage-mismatch',
    about: 'importing into a non-empty namespace with another history fails',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'open', { store: 'copy', embedModelId: '$embed', fresh: true }),
      op(d, 'createNamespace', { store: 'copy', name: NS }),
      op(d, 'ingest', {
        store: 'copy',
        namespace: NS,
        documents: [{ id: 'other', text: 'Unrelated history.' }]
      }),
      ...rejects(
        d,
        'transfer',
        { from: 'main', to: 'copy', namespace: NS },
        'IMPORT_LINEAGE_MISMATCH'
      )
    ]
  },
  {
    id: 'transfer-abort',
    about: 'an import aborted before the stream starts is cancelled and writes nothing',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'open', { store: 'copy', embedModelId: '$embed', fresh: true }),
      ...rejects(
        d,
        'transfer',
        { from: 'main', to: 'copy', namespace: NS, abortAfterChunks: 0 },
        'OPERATION_CANCELLED'
      ),
      op(d, 'listNamespaces', { store: 'copy' }, 'listed'),
      project('$listed', 'result.namespaces', 'namespaces'),
      named('$namespaces', 'lengthIs', { length: 0 })
    ]
  },
  {
    id: 'import-invalid',
    about: 'a stream that is not an export fails with IMPORT_INVALID',
    steps: (d) => [
      ...setup(d),
      ...rejects(
        d,
        'importBytes',
        { store: 'main', namespace: 'imported', text: 'not a qvac rag export' },
        'IMPORT_INVALID'
      )
    ]
  },

  // --- lifecycle --------------------------------------------------------------------------
  {
    id: 'reopen-persists',
    about: 'a closed store reopens with its documents and answers the same query',
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      op(d, 'close', { store: 'main' }),
      op(d, 'open', { store: 'main', embedModelId: '$embed' }),
      op(d, 'listNamespaces', { store: 'main' }, 'listed'),
      project('$listed', 'result.namespaces[0]', 'docs'),
      named('$docs', 'fieldsMatch', { fields: ['documentCount'], expected: { documentCount: 4 } }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'index-snapshot',
    about:
      'on Bare, closing writes a snapshot of the TurboVec index a search loaded, and a reopen uses it',
    drivers: ['bare'],
    expectation: { validation: 'contains-all', contains: ['volcanoes'] },
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      // The index loads on first search; close snapshots only a loaded index.
      op(d, 'search', { store: 'main', scope: { namespace: NS }, query: 'cats', k: 1 }),
      op(d, 'close', { store: 'main' }),
      op(d, 'snapshotFiles', { store: 'main' }, 'snapshot'),
      project('$snapshot', 'result', 'files'),
      named('$files', 'fieldsMatch', {
        fields: ['sidecars', 'snapshots'],
        expected: { sidecars: 1, snapshots: 1 }
      }),
      op(d, 'open', { store: 'main', embedModelId: '$embed' }),
      op(
        d,
        'search',
        { store: 'main', scope: { namespace: NS }, query: 'lava eruption', k: 1 },
        'found'
      ),
      project('$found', 'result.hits[0].documentId', 'top'),
      { assert: { on: '$top', use: 'expectation' } }
    ]
  },
  {
    id: 'close-after-store-close',
    about:
      'with the Corestore closed first, a write fails typed, close() settles, and the SDK still shuts down',
    steps: (d) => [
      ...setup(d),
      ingestCorpus(d),
      // Load the index, then commit once more so close() has a snapshot and pruning to do.
      op(d, 'search', { store: 'main', scope: { namespace: NS }, query: 'cats', k: 1 }),
      op(d, 'ingest', {
        store: 'main',
        namespace: NS,
        documents: [{ id: 'late', text: 'A commit after the index loaded.' }]
      }),
      startOp(d, 'closeStoreFirst', { store: 'main', namespace: NS }, 'closing'),
      { settle: { of: '$closing', expect: 'resolve', withinMs: 15000, as: 'closed' } },
      project('$closed', 'result.writeError', 'writeError'),
      named('$writeError', 'fieldsMatch', {
        fields: ['name'],
        expected: { name: 'DB_OPERATION_FAILED' }
      }),
      project('$closed', 'result', 'outcome'),
      named('$outcome', 'fieldsMatch', { fields: ['close'], expected: { close: 'settled' } }),
      // Delete the store's files while this worker still runs, then stop the worker.
      op(d, 'reset', {}),
      { start: { method: 'close', as: 'shutdown' } },
      { settle: { of: '$shutdown', expect: 'resolve', withinMs: 30000 } },
      // A worker for the teardown's reset.
      ...(d === 'bare' ? [{ useModel: { deps: ['rag-e2e'], as: 'rag' } } as Step] : [])
    ]
  }
]

function define(c: Case, driver: Driver): TestDefinition {
  return {
    testId: `qvac-rag-${c.id}-${driver}`,
    params: { corpus: CORPUS, about: c.about },
    expectation: c.expectation ?? UNUSED,
    ...(c.smoke?.includes(driver) && { suites: ['smoke'] }),
    steps: c.steps(driver),
    finally: [op(driver, 'reset', {})],
    metadata: {
      category: 'qvac-rag',
      dependency: driver === 'bare' ? 'embeddings+rag-e2e' : 'embeddings',
      estimatedDurationMs: c.durationMs ?? 30000
    }
  }
}

export const qvacRagTests: TestDefinition[] = CASES.flatMap((c) =>
  (c.drivers ?? (['bare', 'node'] as Driver[])).map((driver) => define(c, driver))
)
