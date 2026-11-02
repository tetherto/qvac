import { rerank, cancel, InferenceCancelledError, RequestValidationFailedError } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  rerankTests,
  type RerankTestParams,
  type RerankInvalidParams
} from '../../../../catalog/rerank-tests.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Repacking documents into different passes moves a score by about 1e-4; the closest two
// documents in the fixture differ by about 2.5e-3, so a swap still fails.
const tolerance = 1e-3

// Enough long documents to keep the model busy while a second call waits behind it.
const holderDocuments = Array.from(
  { length: 512 },
  (_, i) =>
    `Passage ${i + 1}. ${'Billing statements list every card transaction by date. '.repeat(24)}`
)

function rankingFailure(scores: number[], { documents, relevant, irrelevant }: RerankTestParams) {
  if (scores.length !== documents.length) {
    return `expected ${documents.length} score(s), got ${scores.length}`
  }
  for (const better of relevant) {
    for (const worse of irrelevant) {
      if (!(scores[better]! > scores[worse]!)) {
        return `document ${better} should outscore document ${worse}: ${JSON.stringify(scores)}`
      }
    }
  }
  return null
}

function scoresDiffer(actual: number[], expected: number[]) {
  if (actual.length !== expected.length) {
    return `expected ${expected.length} score(s), got ${actual.length}`
  }
  const index = actual.findIndex((score, i) => !(Math.abs(score - expected[i]!) <= tolerance))
  return index === -1
    ? null
    : `score ${index} is ${actual[index]}, expected ${expected[index]}: ${JSON.stringify(actual)}`
}

function permute(documents: string[], order: number[]) {
  return order.map((index) => documents[index]!)
}

export class RerankExecutor extends AbstractModelExecutor<typeof rerankTests> {
  pattern = /^rerank-/
  protected handlers = {
    'rerank-ranks-relevant-first': this.ranking.bind(this),
    'rerank-follows-document-order': this.ranking.bind(this),
    'rerank-single-document': this.ranking.bind(this),
    'rerank-rejects-no-documents': this.invalid.bind(this),
    'rerank-rejects-empty-query': this.invalid.bind(this),
    'rerank-batch-matches-single': this.batchMatchesSingle.bind(this),
    'rerank-concurrent-queued': this.concurrentQueued.bind(this),
    'rerank-cancel-queued': this.cancelQueued.bind(this),
    'rerank-cancel-active': this.cancelActive.bind(this)
  }

  async ranking(params: RerankTestParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('rerank')
    const scores = await rerank({ modelId, query: params.query, documents: params.documents })
    const failure = rankingFailure(scores, params)
    if (failure) return { passed: false, output: failure }
    return ValidationHelpers.validate(scores, expectation)
  }

  async invalid(params: RerankInvalidParams, expectation: Expectation): Promise<TestResult> {
    try {
      await rerank({ modelId: 'rerank-invalid', query: params.query, documents: params.documents })
      return { passed: false, output: 'Invalid rerank input was accepted' }
    } catch (error) {
      if (!(error instanceof RequestValidationFailedError)) {
        return { passed: false, output: `Expected a validation error, got ${String(error)}` }
      }
      return ValidationHelpers.validate(error.message, expectation)
    }
  }

  async batchMatchesSingle(params: RerankTestParams): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('rerank')
    const { query, documents } = params
    const batch = await rerank({ modelId, query, documents })
    const single: number[] = []
    for (const document of documents) {
      single.push((await rerank({ modelId, query, documents: [document] }))[0]!)
    }
    const failure = scoresDiffer(batch, single) ?? rankingFailure(batch, params)
    return failure
      ? { passed: false, output: failure }
      : { passed: true, output: `${batch.length} batch scores match their documents alone` }
  }

  async concurrentQueued(params: RerankTestParams): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('rerank')
    const { query, documents } = params
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2]
    ]
    const reference: number[][] = []
    for (const order of orders) {
      reference.push(await rerank({ modelId, query, documents: permute(documents, order) }))
    }
    const results = await Promise.all(
      orders.map((order) => rerank({ modelId, query, documents: permute(documents, order) }))
    )
    for (const [i, result] of results.entries()) {
      const failure = scoresDiffer(result, reference[i]!)
      if (failure) return { passed: false, output: `call ${i}: ${failure}` }
    }
    return { passed: true, output: `${results.length} concurrent calls kept their own scores` }
  }

  async cancelQueued(params: RerankTestParams, _expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('rerank')
    const holder = rerank({ modelId, query: params.query, documents: holderDocuments })
    await sleep(50)
    const queued = rerank({ modelId, query: params.query, documents: params.documents })
    const queuedOutcome = queued.then(
      () => 'completed' as const,
      (error: unknown) => (error instanceof InferenceCancelledError ? 'cancelled' : error)
    )
    // A cancel that reaches the engine before the queued call registers still applies to it.
    await cancel({ requestId: queued.requestId })
    const outcome = await queuedOutcome
    const holderScores = await holder
    if (outcome === 'completed') {
      return {
        passed: false,
        output: 'The queued rerank completed: the running call finished before the cancel landed'
      }
    }
    if (outcome !== 'cancelled') {
      return { passed: false, output: `The queued rerank failed unexpectedly: ${String(outcome)}` }
    }
    if (holderScores.length !== holderDocuments.length) {
      return {
        passed: false,
        output: `The running rerank returned ${holderScores.length} score(s)`
      }
    }
    const failure = rankingFailure(
      await rerank({ modelId, query: params.query, documents: params.documents }),
      params
    )
    return failure
      ? { passed: false, output: `After the cancel: ${failure}` }
      : { passed: true, output: 'queued call cancelled; running and later calls unaffected' }
  }

  async cancelActive(params: RerankTestParams, _expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('rerank')
    const running = rerank({ modelId, query: params.query, documents: holderDocuments })
    const outcome = running.then(
      () => 'completed' as const,
      (error: unknown) => (error instanceof InferenceCancelledError ? 'cancelled' : error)
    )
    await sleep(50)
    await cancel({ requestId: running.requestId })
    const result = await outcome
    if (result === 'completed') {
      return { passed: false, output: 'The rerank completed: it finished before the cancel landed' }
    }
    if (result !== 'cancelled') {
      return { passed: false, output: `The rerank failed unexpectedly: ${String(result)}` }
    }
    const failure = rankingFailure(
      await rerank({ modelId, query: params.query, documents: params.documents }),
      params
    )
    return failure
      ? { passed: false, output: `After the cancel: ${failure}` }
      : { passed: true, output: 'running call cancelled; the model recovered' }
  }
}
