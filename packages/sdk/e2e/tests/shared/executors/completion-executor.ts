import { completion, ContextOverflowError, deleteCache } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { completionTests } from '../../completion-tests.js'

type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      json_schema: {
        name: string
        schema: Record<string, unknown>
        description?: string
        strict?: boolean
      }
    }

interface GenerationParams {
  temp?: number
  top_p?: number
  top_k?: number
  predict?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
  reasoning_budget?: number
  remove_thinking_from_context?: boolean
}

interface CompletionTestParams {
  history: ReadonlyArray<{ role: string; content: string }>
  stream?: boolean
  responseFormat?: ResponseFormat
  tools?: ReadonlyArray<Record<string, unknown>>
  stopSequences?: ReadonlyArray<string>
  generationParams?: GenerationParams
  /** Second-turn user message for the warm-cache overflow flow. */
  followUpContent?: string
}

type CompletionFnParams = Parameters<typeof completion>[0]

export class CompletionExecutor extends AbstractModelExecutor<typeof completionTests> {
  pattern = /^completion-/

  protected handlers = Object.fromEntries(
    completionTests.map((test) => {
      if (
        test.testId === 'completion-response-format-json-object' ||
        test.testId === 'completion-response-format-json-object-streaming'
      ) {
        return [test.testId, this.responseFormatJsonObject.bind(this)]
      }
      if (test.testId === 'completion-response-format-json-schema') {
        return [test.testId, this.responseFormatJsonSchema.bind(this)]
      }
      if (test.testId === 'completion-response-format-with-tools-rejected') {
        return [test.testId, this.responseFormatWithToolsRejected.bind(this)]
      }
      if (test.testId === 'completion-stats') {
        return [test.testId, this.statsVerification.bind(this)]
      }
      if (test.testId === 'completion-concurrent-requests') {
        return [test.testId, this.concurrentRequests.bind(this)]
      }
      if (test.testId === 'completion-concurrent-overlap') {
        return [test.testId, this.concurrentOverlap.bind(this)]
      }
      if (test.testId === 'completion-seed-reproducibility') {
        return [test.testId, this.seedReproducibility.bind(this)]
      }
      if (test.testId === 'completion-stop-reason-length') {
        return [test.testId, this.stopReasonLength.bind(this)]
      }
      if (test.testId === 'completion-context-boundary-stop') {
        return [test.testId, this.contextBoundaryStop.bind(this)]
      }
      if (test.testId === 'completion-context-overflow-prefill') {
        return [test.testId, this.contextOverflowPrefill.bind(this)]
      }
      if (test.testId === 'completion-context-overflow-warm-cache') {
        return [test.testId, this.contextOverflowWarmCache.bind(this)]
      }
      return [test.testId, this.generic.bind(this)]
    })
  ) as never

  private async runCompletion(params: CompletionTestParams): Promise<string> {
    const llmModelId = await this.resources.ensureLoaded('llm')
    const result = completion({
      modelId: llmModelId,
      ...params,
      stream: params.stream ?? false
    } as CompletionFnParams)

    if (params.stream) {
      let fullText = ''
      for await (const token of result.tokenStream) {
        fullText += token
      }
      return fullText
    }
    return result.text
  }

  async generic(params: CompletionTestParams, expectation: Expectation): Promise<TestResult> {
    const text = await this.runCompletion(params)
    return ValidationHelpers.validate(text, expectation)
  }

  // Issues several completions against the same model in the same tick and
  // asserts the registry's FIFO concurrency policy: same-model requests wait
  // for the native context and all resolve without policy rejections.
  async concurrentRequests(
    params: CompletionTestParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm')
    const CONCURRENCY = 3

    const settled = await Promise.allSettled(
      Array.from(
        { length: CONCURRENCY },
        () =>
          completion({
            modelId: llmModelId,
            ...params,
            stream: false
          } as CompletionFnParams).text
      )
    )

    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled'
    )
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')

    if (fulfilled.length !== CONCURRENCY || rejected.length !== 0) {
      return {
        passed: false,
        output:
          `Expected FIFO shape: ${CONCURRENCY} fulfilled and 0 rejected; ` +
          `got ${fulfilled.length} fulfilled and ${rejected.length} rejected`
      }
    }

    // Every queued request must still produce a valid response once admitted.
    const failedResult = fulfilled
      .map((result) => ValidationHelpers.validate(result.value, expectation))
      .find((result) => !result.passed)
    if (failedResult) {
      return {
        passed: false,
        output: `Queued completion failed expectation: ${failedResult.output}`
      }
    }

    return {
      passed: true,
      output:
        `FIFO concurrency policy enforced: ${fulfilled.length} completed, ` +
        `${rejected.length} rejected (of ${CONCURRENCY} issued)`
    }
  }

  // Proves concurrent scheduling on a parallel>1 model. Gates on the engine signal
  // (avgConcurrentSeq > 1), which is authoritative for native sequence co-residency,
  // and reports the client content-token-window overlap as a supporting diagnostic
  // only: that client-side signal is transport-buffering sensitive, so gating on it
  // would make the test flaky even when the server genuinely decoded concurrently.
  async concurrentOverlap(
    params: CompletionTestParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm-batch')
    const CONCURRENCY = 4

    const intervals = await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const run = completion({
          modelId: llmModelId,
          ...params,
          stream: true
        } as CompletionFnParams)
        let start = 0
        let end = 0
        let text = ''
        for await (const token of run.tokenStream) {
          const now = Date.now()
          if (start === 0) start = now
          end = now
          text += token
        }
        const stats = (await run.stats) as { avgConcurrentSeq?: number } | undefined
        return { start, end, text, avgConcurrentSeq: stats?.avgConcurrentSeq }
      })
    )

    // Sweep line over the decode intervals: peak number live at once. Ties
    // resolve end-before-start, so touching intervals don't count as overlap.
    const events = intervals.flatMap(({ start, end }) => [
      { t: start, delta: 1 },
      { t: end, delta: -1 }
    ])
    events.sort((a, b) => a.t - b.t || a.delta - b.delta)
    let live = 0
    let peakOverlap = 0
    for (const event of events) {
      live += event.delta
      if (live > peakOverlap) peakOverlap = live
    }

    const empty = intervals.filter((i) => i.text.length === 0).length
    if (empty > 0) {
      return {
        passed: false,
        output: `${empty}/${CONCURRENCY} concurrent completions produced no output`
      }
    }

    const seqs = intervals.map((i) => i.avgConcurrentSeq)
    const maxSeq = seqs.reduce<number>((m, s) => (typeof s === 'number' && s > m ? s : m), 0)
    if (!seqs.some((s) => typeof s === 'number')) {
      return {
        passed: false,
        output: 'Engine did not report avgConcurrentSeq; cannot prove native concurrency'
      }
    }
    if (maxSeq <= 1) {
      return {
        passed: false,
        output:
          `Engine avgConcurrentSeq peaked at ${maxSeq} (<= 1): no multi-sequence ` +
          `co-residency was observed. Content-token interval peak was ${peakOverlap}/${CONCURRENCY}.`
      }
    }
    const failed = intervals
      .map((i) => ValidationHelpers.validate(i.text, expectation))
      .find((result) => !result.passed)
    if (failed) {
      return { passed: false, output: `Concurrent completion failed expectation: ${failed.output}` }
    }

    return {
      passed: true,
      output: `Concurrent decoding proven: engine avgConcurrentSeq peaked at ${maxSeq.toFixed(2)}, client interval peak ${peakOverlap}/${CONCURRENCY}`
    }
  }

  // Runs the same prompt twice with a fixed seed and asserts byte-identical
  // output, proving seeded sampling is reproducible.
  async seedReproducibility(params: CompletionTestParams): Promise<TestResult> {
    const first = await this.runCompletion(params)
    const second = await this.runCompletion(params)

    if (first.length === 0) {
      return { passed: false, output: 'First run returned an empty response' }
    }
    if (first !== second) {
      return {
        passed: false,
        output:
          `Same seed produced different output.\nRun 1: ${JSON.stringify(first.slice(0, 200))}\n` +
          `Run 2: ${JSON.stringify(second.slice(0, 200))}`
      }
    }
    return {
      passed: true,
      output: `Seeded output reproducible (${first.length} chars identical across 2 runs)`
    }
  }

  async statsVerification(
    params: CompletionTestParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const llmModelId = await this.resources.ensureLoaded('llm')
      const result = completion({
        modelId: llmModelId,
        ...params,
        stream: params.stream ?? false
      } as CompletionFnParams)

      const text = await result.text
      const textValidation = ValidationHelpers.validate(text, expectation)
      if (!textValidation.passed) return textValidation

      const stats = (await result.stats) as Record<string, unknown> | undefined
      if (!stats) {
        return {
          passed: false,
          output: `Completion OK but stats were undefined. Text: "${text.slice(0, 120)}"`
        }
      }
      const ttft = stats.timeToFirstToken
      const tps = stats.tokensPerSecond
      if (typeof ttft !== 'number' || typeof tps !== 'number') {
        return {
          passed: false,
          output: `Completion stats missing numeric timing fields. Got: ${JSON.stringify(stats)}`
        }
      }
      return {
        passed: true,
        output: `completion stats OK — timeToFirstToken=${ttft}, tokensPerSecond=${tps}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `completion stats failed: ${errorMsg}` }
    }
  }

  async stopReasonLength(params: CompletionTestParams): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm')
    const run = completion({
      modelId: llmModelId,
      ...params,
      stream: false
    } as CompletionFnParams)

    const final = await run.final
    if (final.stopReason !== 'length') {
      return {
        passed: false,
        output: `Expected stopReason "length", got ${JSON.stringify(final.stopReason)}`
      }
    }
    return {
      passed: true,
      output: `stopReason is "length" as expected`
    }
  }

  // The predict budget exceeds what fits after the prompt, so a "length"
  // stop under the budget proves the boundary, not prediction exhaustion.
  async contextBoundaryStop(params: CompletionTestParams): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm-small-ctx')
    const budget = params.generationParams?.predict ?? 0
    const run = completion({
      modelId: llmModelId,
      ...params,
      stream: false
    } as CompletionFnParams)

    const final = await run.final
    if (final.stopReason !== 'length') {
      return {
        passed: false,
        output: `Expected stopReason "length" at the context boundary, got ${JSON.stringify(final.stopReason)}`
      }
    }
    const generatedTokens = final.stats?.generatedTokens
    if (typeof generatedTokens !== 'number' || generatedTokens >= budget) {
      return {
        passed: false,
        output: `Expected generatedTokens below the ${budget} budget (boundary, not prediction cutoff), got ${generatedTokens}`
      }
    }
    if (final.raw.fullText.length === 0) {
      return {
        passed: false,
        output: 'Expected the tokens produced before the boundary to be returned, got empty output'
      }
    }
    return {
      passed: true,
      output: `Context boundary stop: "length" at ${generatedTokens} of ${budget} budget, ${final.raw.fullText.length} chars retained`
    }
  }

  // A prompt that cannot fit the window is refused before any decoding with
  // the typed ContextOverflowError carrying the parsed sizes.
  async contextOverflowPrefill(params: CompletionTestParams): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm-small-ctx')
    try {
      const run = completion({
        modelId: llmModelId,
        ...params,
        stream: false
      } as CompletionFnParams)
      await run.final
      return { passed: false, output: 'Expected ContextOverflowError for oversized prefill' }
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) {
        return { passed: false, output: `Expected ContextOverflowError, got: ${error}` }
      }
      if (typeof error.promptTokens !== 'number' || typeof error.ctxSize !== 'number') {
        return {
          passed: false,
          output: `Expected parsed sizes on the error, got promptTokens=${error.promptTokens} ctxSize=${error.ctxSize}`
        }
      }
      // The addon guards trigger on `>=`, so equality is emittable; below
      // the window means the parser extracted the wrong quantity.
      if (error.promptTokens < error.ctxSize) {
        return {
          passed: false,
          output: `Expected promptTokens of at least ctxSize, got promptTokens=${error.promptTokens} ctxSize=${error.ctxSize}`
        }
      }
      // The reported window must be the configured one, not a rescaled or
      // defaulted figure.
      if (error.ctxSize !== 512) {
        return {
          passed: false,
          output: `Expected ctxSize to equal the configured 512, got ${error.ctxSize}`
        }
      }
      return {
        passed: true,
        output: `ContextOverflowError with promptTokens=${error.promptTokens} ctxSize=${error.ctxSize}`
      }
    }
  }

  // The first turn must end commit-eligible and the error must carry the
  // warm signature (positive cachedTokens), not just the failing total.
  async contextOverflowWarmCache(params: CompletionTestParams): Promise<TestResult> {
    const llmModelId = await this.resources.ensureLoaded('llm-small-ctx')
    const kvCache = `ctx-overflow-warm-${Date.now()}`
    // Cleanup must run even when the flow throws unexpectedly — a leaked
    // named cache poisons retries and adjacent runs.
    let result: TestResult
    try {
      result = await this.runWarmOverflow(llmModelId, kvCache, params)
    } catch (error) {
      result = { passed: false, output: `Warm-cache flow threw: ${error}` }
    }
    try {
      await deleteCache({ kvCacheKey: kvCache, modelId: llmModelId })
    } catch (error) {
      const context = result.passed ? 'Test passed but cache' : `${result.output}; cache also`
      return { passed: false, output: `${context} failed to delete: ${error}` }
    }
    return result
  }

  private async runWarmOverflow(
    llmModelId: string,
    kvCache: string,
    params: CompletionTestParams
  ): Promise<TestResult> {
    const first = completion({
      modelId: llmModelId,
      history: params.history,
      stream: false,
      kvCache,
      generationParams: params.generationParams
    } as CompletionFnParams)
    const firstFinal = await first.final
    // The commit policy refuses a budget-exhausted or boundary-hit turn; a
    // rolled-back turn one would make turn two a cold full-history resend.
    if (firstFinal.stopReason !== undefined || firstFinal.raw.fullText.length === 0) {
      return {
        passed: false,
        output: `First turn is not commit-eligible: stopReason=${JSON.stringify(firstFinal.stopReason)} textLength=${firstFinal.raw.fullText.length}`
      }
    }
    const followUp = [
      ...params.history,
      { role: 'assistant', content: firstFinal.raw.fullText },
      { role: 'user', content: params.followUpContent ?? '' }
    ]
    try {
      const second = completion({
        modelId: llmModelId,
        history: followUp,
        stream: false,
        kvCache,
        generationParams: params.generationParams
      } as CompletionFnParams)
      await second.final
      return { passed: false, output: 'Expected ContextOverflowError on the warm-cache follow-up' }
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) {
        return { passed: false, output: `Expected ContextOverflowError, got: ${error}` }
      }
      if (error.ctxSize !== 512) {
        return { passed: false, output: `Expected ctxSize 512, got ${error.ctxSize}` }
      }
      if (typeof error.requiredTokens !== 'number' || error.requiredTokens < error.ctxSize) {
        return {
          passed: false,
          output: `Expected requiredTokens of at least the window, got requiredTokens=${error.requiredTokens} ctxSize=${error.ctxSize}`
        }
      }
      // The cached-plus-prompt guard names the cached half; its absence means
      // the request went in cold. A fresh prime holds only the system prompt
      // (well under 100 tokens), while the committed first turn is ~370, so
      // the floor proves the first-turn prefix survived, not merely a warm
      // state after a silent commit rollback.
      if (typeof error.cachedTokens !== 'number' || error.cachedTokens < 200) {
        return {
          passed: false,
          output: `Expected cachedTokens to include the committed first turn (>= 200), got cachedTokens=${error.cachedTokens}`
        }
      }
      return {
        passed: true,
        output: `Warm-cache overflow: requiredTokens=${error.requiredTokens} cachedTokens=${error.cachedTokens} ctxSize=${error.ctxSize}`
      }
    }
  }

  async responseFormatJsonObject(params: CompletionTestParams): Promise<TestResult> {
    try {
      const text = await this.runCompletion(params)
      return validateJsonObject(text)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `responseFormat json_object failed: ${errorMsg}`
      }
    }
  }

  async responseFormatJsonSchema(params: CompletionTestParams): Promise<TestResult> {
    try {
      const text = await this.runCompletion(params)
      return validatePersonSchema(text)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return {
        passed: false,
        output: `responseFormat json_schema failed: ${errorMsg}`
      }
    }
  }

  async responseFormatWithToolsRejected(
    params: CompletionTestParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const run = completion({
        modelId: 'schema-refinement-placeholder',
        ...params,
        stream: params.stream ?? false
      } as CompletionFnParams)
      await run.text
      return {
        passed: false,
        output: 'Expected zod refinement to reject responseFormat + tools combination'
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return ValidationHelpers.validate(errorMsg, expectation)
    }
  }
}

type JsonObject = Record<string, unknown>
type ParseObjectResult = { ok: true; obj: JsonObject } | { ok: false; failure: TestResult }

function parseJsonObject(text: string, label: string): ParseObjectResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      failure: {
        passed: false,
        output: `${label} output is not valid JSON: ${errorMsg}. Output: ${text.slice(0, 200)}`
      }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        passed: false,
        output: `${label}: expected a JSON object, got ${
          Array.isArray(parsed) ? 'array' : typeof parsed
        }: ${text.slice(0, 200)}`
      }
    }
  }
  return { ok: true, obj: parsed as JsonObject }
}

function validateJsonObject(text: string): TestResult {
  const parsed = parseJsonObject(text, 'json_object')
  if (!parsed.ok) return parsed.failure
  return {
    passed: true,
    output: `json_object OK — keys: ${Object.keys(parsed.obj).join(',') || '(none)'}`
  }
}

const PERSON_REQUIRED_KEYS: ReadonlyArray<'name' | 'age' | 'occupation'> = [
  'name',
  'age',
  'occupation'
]

function validatePersonSchema(text: string): TestResult {
  const parsed = parseJsonObject(text, 'json_schema')
  if (!parsed.ok) return parsed.failure
  const obj = parsed.obj

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return {
      passed: false,
      output: `name must be non-empty string, got: ${JSON.stringify(obj.name)}`
    }
  }
  if (typeof obj.age !== 'number' || !Number.isInteger(obj.age)) {
    return {
      passed: false,
      output: `age must be integer, got: ${JSON.stringify(obj.age)}`
    }
  }
  if (typeof obj.occupation !== 'string' || obj.occupation.length === 0) {
    return {
      passed: false,
      output: `occupation must be non-empty string, got: ${JSON.stringify(obj.occupation)}`
    }
  }

  const actualKeys = Object.keys(obj).sort()
  const expectedKeys = [...PERSON_REQUIRED_KEYS].sort()
  const sameKeys =
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i])
  if (!sameKeys) {
    return {
      passed: false,
      output:
        `additionalProperties:false violated. Expected exactly [${expectedKeys.join(',')}], ` +
        `got [${actualKeys.join(',')}]. Raw: ${text.slice(0, 200)}`
    }
  }

  return {
    passed: true,
    output: `json_schema OK — Person { name: ${obj.name}, age: ${obj.age}, occupation: ${obj.occupation} }`
  }
}
