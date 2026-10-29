import type { Step, TestDefinition } from '@qvac/test-suite'

export type RerankTestParams = {
  query: string
  documents: string[]
  relevant: number[]
  irrelevant: number[]
}
export type RerankInvalidParams = { query: string; documents: string[]; field: string }

const query = 'What is the capital of France?'
const paris = 'Paris is the capital and largest city of France.'
const seine = 'The capital of France is Paris, which sits on the Seine river.'
const plants = 'Photosynthesis converts sunlight into chemical energy in plants.'
const stocks = 'The stock market closed higher on Tuesday after strong earnings.'

// Raw scores differ between rerankers and backends, so the checks are about order: every relevant
// document must outscore every irrelevant one, at the position it was given.
function rankingSteps({ documents, relevant, irrelevant }: RerankTestParams): Step[] {
  return [
    { useModel: { deps: ['rerank'], as: 'model' } },
    {
      call: {
        method: 'rerank',
        params: { modelId: '$model', query: '$params.query', documents: '$params.documents' },
        as: 'response'
      }
    },
    { project: { from: '$response', path: 'scores', as: 'scores' } },
    { assert: { on: '$scores', named: 'lengthIs', with: { length: documents.length } } },
    ...documents.map((_, index): Step => ({
      project: { from: '$response', path: `scores[${index}]`, as: `score${index}` }
    })),
    ...relevant.flatMap((better) =>
      irrelevant.map((worse): Step => ({
        compare: { left: `$score${better}`, right: `$score${worse}`, named: 'greaterThan' }
      }))
    ),
    { assert: { on: '$scores', use: 'expectation' } }
  ]
}

function rerankTest(
  testId: string,
  params: RerankTestParams,
  suites?: TestDefinition['suites']
): TestDefinition {
  return {
    testId,
    params,
    expectation: { validation: 'type', expectedType: 'array' },
    ...(suites && { suites }),
    steps: rankingSteps(params),
    metadata: { category: 'rerank', dependency: 'rerank', estimatedDurationMs: 10000 }
  }
}

export const rerankRanksRelevantFirst = rerankTest(
  'rerank-ranks-relevant-first',
  { query, documents: [paris, plants, seine, stocks], relevant: [0, 2], irrelevant: [1, 3] },
  ['smoke']
)

export const rerankFollowsDocumentOrder = rerankTest('rerank-follows-document-order', {
  query,
  documents: [plants, paris, stocks, seine],
  relevant: [1, 3],
  irrelevant: [0, 2]
})

export const rerankSingleDocument = rerankTest('rerank-single-document', {
  query,
  documents: [paris],
  relevant: [],
  irrelevant: []
})

function rejectsInvalid(testId: string, params: RerankInvalidParams): TestDefinition {
  return {
    testId,
    params,
    expectation: { validation: 'throws-error', errorContains: params.field },
    // Both clients reject before the request reaches the worker, each with its own wording; the
    // field name is what they share.
    steps: [
      {
        callError: {
          method: 'rerank',
          params: {
            modelId: 'rerank-invalid',
            query: '$params.query',
            documents: '$params.documents'
          },
          as: 'err'
        }
      },
      { assert: { on: '$err', named: 'errorMatches', with: { messageContains: params.field } } }
    ],
    metadata: { category: 'rerank', dependency: 'none', estimatedDurationMs: 1000 }
  }
}

export const rerankRejectsNoDocuments = rejectsInvalid('rerank-rejects-no-documents', {
  query,
  documents: [],
  field: 'documents'
})

export const rerankRejectsEmptyQuery = rejectsInvalid('rerank-rejects-empty-query', {
  query: '',
  documents: [paris],
  field: 'query'
})

function executorTest(
  testId: string,
  estimatedDurationMs: number,
  suites?: TestDefinition['suites']
): TestDefinition {
  return {
    testId,
    params: {
      query,
      documents: [paris, plants, seine, stocks],
      relevant: [0, 2],
      irrelevant: [1, 3]
    },
    expectation: { validation: 'function', fn: () => true },
    ...(suites && { suites }),
    metadata: { category: 'rerank', dependency: 'rerank', estimatedDurationMs }
  }
}

// Each score in a batch must be the score its own document gets alone, so a swap between any two
// documents fails, and packing several documents into one pass cannot mix them.
export const rerankBatchMatchesSingle = executorTest('rerank-batch-matches-single', 10000)

// Concurrent calls on one model wait their turn, and each gets the scores of its own documents.
export const rerankConcurrentQueued = executorTest('rerank-concurrent-queued', 10000)

// The cancel tests stop a call while the model works, which the step vocabulary cannot express.
export const rerankCancelQueued = executorTest('rerank-cancel-queued', 15000, ['imperative'])

export const rerankCancelActive = executorTest('rerank-cancel-active', 15000, ['imperative'])

export const rerankTests = [
  rerankRanksRelevantFirst,
  rerankFollowsDocumentOrder,
  rerankSingleDocument,
  rerankRejectsNoDocuments,
  rerankRejectsEmptyQuery,
  rerankBatchMatchesSingle,
  rerankConcurrentQueued,
  rerankCancelQueued,
  rerankCancelActive
]
