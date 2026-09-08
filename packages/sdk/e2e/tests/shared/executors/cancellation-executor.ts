import {
  batchCompletion,
  cancel,
  completion,
  type CompletionEvent,
  type CompletionRun,
  deleteCache,
  embed,
  InferenceCancelledError,
  ragDeleteWorkspace,
  ragIngest,
  RAG_ERROR_CODES,
  SDK_SERVER_ERROR_CODES,
  transcribe,
  translate
} from '@qvac/sdk'
import { type Expectation, type TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  cancelBeforeBeginCompletion,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  cancelByRequestIdEmbed,
  cancelByRequestIdRagIngest,
  cancelIsolatesConcurrentBatches,
  cancelQueuedNativeBatch,
  cancelMidStreamCompletion,
  cancelThenResumeKvCache,
  serializeConcurrentCompletion
} from '../../cancellation-tests.js'

export type CancelForm = 'broad' | 'requestId'
type StopReason = 'stop' | 'length' | 'cancelled' | 'error'

interface MidStreamParams {
  prompt: string
  cancelAfterTokens?: number
}

interface CancelBeforeBeginParams {
  prompt: string
}

interface CancelThenResumeKvCacheParams {
  cacheKey: string
  firstUserMessage: string
  secondUserMessage: string
  expectedAnswerContains: string
  cancelAfterTokens?: number
}

interface EmbedParams {
  passageCount: number
  passageFiller: string
  passageFillerRepeats: number
  registryBeginGraceMs: number
  cancelRetryMs: number
  cancelDeadlineMs: number
  settleTimeoutMs: number
}

interface TranslateLlmParams {
  text: string
  from: string
  to: string
  maxTokensAfterCancel: number
}

interface PolicyParams {
  prompt: string
}

interface RagIngestParams {
  workspaceBase: string
  documentFiller: string
  documentFillerRepeats: number
  chunkSize: number
  chunkOverlap: number
  registryBeginGraceMs: number
}

export interface TranscribeCancelParams {
  audioFileName: string
}

const INFERENCE_CANCELLED_CODE = SDK_SERVER_ERROR_CODES.INFERENCE_CANCELLED
const RAG_OPERATION_CANCELLED_CODE = RAG_ERROR_CODES.OPERATION_CANCELLED
const ADDON_CANCEL_MESSAGE = 'Job cancelled'
// Embed addon surfaces this when llama_decode is aborted mid-flight.
const EMBED_ABORTED_MESSAGE = 'Failed to get sequence embeddings'

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// True if the operation settled (either way) inside the window.
async function settledWithin(op: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const done = op.then(
    () => true,
    () => true
  )
  const settled = await Promise.race([done, timedOut])
  if (timer !== undefined) clearTimeout(timer)
  return settled
}

// No-op catch so an early rejection doesn't crash the consumer pre-await.
export function markHandled<P extends Promise<unknown>>(p: P): P {
  p.catch(() => {})
  return p
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

// Object wrapper so TS narrows error state across closure boundaries.
type ErrorSlot = { error: Error | null }
const errorSlot = (): ErrorSlot => ({ error: null })

function errorCode(err: Error): number | undefined {
  return 'code' in err && typeof err.code === 'number' ? err.code : undefined
}

export function isCancellationError(err: Error): boolean {
  if (err instanceof InferenceCancelledError) return true
  const code = errorCode(err)
  if (code === INFERENCE_CANCELLED_CODE || code === RAG_OPERATION_CANCELLED_CODE) {
    return true
  }
  if (err.name === 'INFERENCE_CANCELLED' || err.name === 'OPERATION_CANCELLED') {
    return true
  }
  return err.message === ADDON_CANCEL_MESSAGE || err.message === EMBED_ABORTED_MESSAGE
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err)
    return `${err.constructor.name}(code=${code ?? '-'}, name=${err.name}, message=${err.message})`
  }
  return `non-Error: ${String(err)}`
}

interface StreamObservation {
  totalEvents: number
  contentEvents: number
  accumulatedText: string
  lastEventType: CompletionEvent['type'] | null
  lastStopReason: StopReason | null
}

// Drains a completion stream; optional callback fires after each contentDelta.
async function observeStream(
  events: AsyncIterable<CompletionEvent>,
  onContentDelta?: (count: number, accumulated: string) => Promise<void> | void
): Promise<StreamObservation> {
  const obs: StreamObservation = {
    totalEvents: 0,
    contentEvents: 0,
    accumulatedText: '',
    lastEventType: null,
    lastStopReason: null
  }
  for await (const event of events) {
    obs.totalEvents++
    obs.lastEventType = event.type
    if (event.type === 'contentDelta') {
      obs.contentEvents++
      obs.accumulatedText += event.text
      if (onContentDelta) {
        await onContentDelta(obs.contentEvents, obs.accumulatedText)
      }
    } else if (event.type === 'completionDone') {
      obs.lastStopReason = (event.stopReason ?? null) as StopReason | null
    }
  }
  return obs
}

interface FinalOutcome {
  resolved: boolean
  error: unknown
}

async function captureFinal(p: Promise<unknown>): Promise<FinalOutcome> {
  try {
    await p
    return { resolved: true, error: null }
  } catch (err) {
    return { resolved: false, error: err }
  }
}

// Verifies the cancel error's partial.text and requestId match the wire.
function checkPartialMatch(
  err: InferenceCancelledError,
  expectedText: string,
  expectedRequestId: string,
  label: string
): TestResult | null {
  const partial = err.partial.text ?? ''
  if (partial !== expectedText) {
    return {
      passed: false,
      output:
        `${label}: partial.text (len=${partial.length}, ${JSON.stringify(partial.slice(0, 80))}) ` +
        `did not match accumulated contentDelta (len=${expectedText.length}, ${JSON.stringify(expectedText.slice(0, 80))})`
    }
  }
  if (err.requestId !== expectedRequestId) {
    return {
      passed: false,
      output: `${label}: requestId mismatch error=${err.requestId} run=${expectedRequestId}`
    }
  }
  return null
}

// Outcome must reject with InferenceCancelledError matching observed wire state.
function checkCancelledFinal(
  outcome: FinalOutcome,
  expectedText: string,
  expectedRequestId: string,
  label: string
): TestResult | null {
  if (outcome.resolved) {
    return {
      passed: false,
      output: `${label}: run.final resolved instead of rejecting with InferenceCancelledError`
    }
  }
  if (!(outcome.error instanceof InferenceCancelledError)) {
    return {
      passed: false,
      output: `${label}: rejected with ${describeError(outcome.error)}, expected InferenceCancelledError`
    }
  }
  return checkPartialMatch(outcome.error, expectedText, expectedRequestId, label)
}

type MidStreamSuccess = {
  ok: true
  obs: StreamObservation
  finalError: InferenceCancelledError
}
type MidStreamFailure = { ok: false; fail: TestResult }

// Streams a completion, cancels after N deltas, validates common invariants.
// Caller adds modality-specific follow-up checks.
async function streamAndCancelAtN(
  run: CompletionRun,
  cancelAfterTokens: number
): Promise<MidStreamSuccess | MidStreamFailure> {
  let cancelInvoked = false
  const cancelSlot = errorSlot()

  const obs = await observeStream(run.events, async (count) => {
    if (!cancelInvoked && count >= cancelAfterTokens) {
      cancelInvoked = true
      try {
        await cancel({ requestId: run.requestId })
      } catch (err) {
        cancelSlot.error = toError(err)
      }
    }
  })

  const finalOutcome = await captureFinal(run.final)

  if (cancelSlot.error) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `cancel({ requestId }) rejected mid-stream: ${cancelSlot.error.message}`
      }
    }
  }
  if (!cancelInvoked) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `Stream ended before ${cancelAfterTokens} contentDelta events arrived (saw ${obs.totalEvents})`
      }
    }
  }
  if (obs.lastStopReason !== 'cancelled') {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `Expected completionDone.stopReason === "cancelled", got ${JSON.stringify(obs.lastStopReason)}`
      }
    }
  }
  if (!(finalOutcome.error instanceof InferenceCancelledError)) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `run.final did not reject with InferenceCancelledError: ${describeError(finalOutcome.error)}`
      }
    }
  }

  return { ok: true, obs, finalError: finalOutcome.error }
}

const sharedTests = [
  cancelMidStreamCompletion,
  cancelBeforeBeginCompletion,
  cancelThenResumeKvCache,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  serializeConcurrentCompletion,
  cancelByRequestIdEmbed,
  cancelByRequestIdRagIngest
]

export class CancellationExecutor extends AbstractModelExecutor<typeof sharedTests> {
  pattern = /^(cancel-|serialize-)/

  // `as never` lets subclasses extend handlers with test ids outside TDefs.
  protected handlers = this.buildSharedHandlers() as never

  protected buildSharedHandlers() {
    return {
      [cancelMidStreamCompletion.testId]: this.cancelMidStream.bind(this),
      [cancelBeforeBeginCompletion.testId]: this.cancelBeforeBegin.bind(this),
      [cancelThenResumeKvCache.testId]: this.cancelThenResumeKvCache.bind(this),
      [cancelBroadEmbeddings.testId]: this.embedBroad.bind(this),
      [cancelByRequestIdEmbed.testId]: this.embedTargeted.bind(this),
      [cancelBroadTranslateLlm.testId]: this.translateLlmBroad.bind(this),
      [serializeConcurrentCompletion.testId]: this.serializeConcurrent.bind(this),
      [cancelIsolatesConcurrentBatches.testId]: this.cancelIsolatesConcurrentBatches.bind(this),
      [cancelQueuedNativeBatch.testId]: this.cancelQueuedNativeBatch.bind(this),
      [cancelByRequestIdRagIngest.testId]: this.ragIngestTargeted.bind(this)
    }
  }

  async cancelMidStream(params: MidStreamParams, _expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3

    const run = completion({
      modelId,
      history: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: params.prompt }
      ],
      stream: true
    })

    const result = await streamAndCancelAtN(run, cancelAfterTokens)
    if (!result.ok) return result.fail

    if (result.obs.lastEventType !== 'completionDone') {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${result.obs.lastEventType} after ${result.obs.totalEvents} events`
      }
    }

    const partialFail = checkPartialMatch(
      result.finalError,
      result.obs.accumulatedText,
      run.requestId,
      'cancelMidStream'
    )
    if (partialFail) return partialFail

    return {
      passed: true,
      output:
        `Mid-stream cancel OK: events=${result.obs.totalEvents}, stopReason=cancelled, ` +
        `partial.text length=${result.obs.accumulatedText.length}`
    }
  }

  async cancelBeforeBegin(
    params: CancelBeforeBeginParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    const run = completion({
      modelId,
      history: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: params.prompt }
      ],
      stream: true
    })

    // Sync cancel after completion() — registry replays it retroactively
    // whether it arrives before or after server-side begin().
    const cancelSlot = errorSlot()
    const cancelTask = cancel({ requestId: run.requestId }).catch((err) => {
      cancelSlot.error = toError(err)
    })

    const obs = await observeStream(run.events)
    await cancelTask

    if (cancelSlot.error) {
      return {
        passed: false,
        output: `cancel({ requestId }) rejected for an unknown id: ${cancelSlot.error.message}`
      }
    }
    if (obs.lastEventType !== 'completionDone') {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${obs.lastEventType} (events=${obs.totalEvents}, content=${obs.contentEvents})`
      }
    }
    if (obs.lastStopReason !== 'cancelled') {
      return {
        passed: false,
        output:
          `Expected stopReason "cancelled" (cancel-before-begin replayed retroactively), ` +
          `got ${JSON.stringify(obs.lastStopReason)} (events=${obs.totalEvents}, content=${obs.contentEvents})`
      }
    }

    const finalFail = checkCancelledFinal(
      await captureFinal(run.final),
      obs.accumulatedText,
      run.requestId,
      'cancelBeforeBegin'
    )
    if (finalFail) return finalFail

    return {
      passed: true,
      output:
        `Cancel-before-begin OK: events=${obs.totalEvents}, content=${obs.contentEvents}, ` +
        `partial.text length=${obs.accumulatedText.length}`
    }
  }

  async cancelThenResumeKvCache(
    params: CancelThenResumeKvCacheParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {
        // First run owns this cache key — missing-file errors are fine.
      }

      const firstRun = completion({
        modelId,
        history: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: params.firstUserMessage }
        ],
        stream: true,
        kvCache: params.cacheKey
      })

      // First turn must cancel cleanly so kv-cache rollback runs
      // before the second turn reuses the same cache key.
      const firstResult = await streamAndCancelAtN(firstRun, cancelAfterTokens)
      if (!firstResult.ok) return firstResult.fail

      const secondRun = completion({
        modelId,
        history: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: params.secondUserMessage }
        ],
        stream: true,
        kvCache: params.cacheKey
      })

      let secondText = ''
      for await (const token of secondRun.tokenStream) {
        secondText += token
      }

      const trimmed = secondText.trim()
      if (trimmed.length === 0) {
        return {
          passed: false,
          output:
            'Second completion returned an empty response after cancelling the previous ' +
            'streaming turn — rollback likely left stale state in the KvCacheSession.'
        }
      }

      const expected = params.expectedAnswerContains
      if (!trimmed.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output:
            `Second completion did not include expected token ${JSON.stringify(expected)}. ` +
            `Got ${secondText.length} chars: ${JSON.stringify(secondText.slice(0, 200))}`
        }
      }

      return {
        passed: true,
        output:
          `Cancel-then-resume KV-cache OK: cancelled after ${firstResult.obs.contentEvents} tokens, ` +
          `second turn produced ${secondText.length} chars containing ${JSON.stringify(expected)}`
      }
    } catch (error) {
      return {
        passed: false,
        output: `Cancel-then-resume KV-cache failed: ${describeError(error)}`
      }
    }
  }

  async embedBroad(params: EmbedParams, _expectation: Expectation): Promise<TestResult> {
    return this.embedRun(params, 'broad')
  }

  async embedTargeted(params: EmbedParams, _expectation: Expectation): Promise<TestResult> {
    return this.embedRun(params, 'requestId')
  }

  // Only the requestId path has a cancel-before-begin tripwire: a broad cancel
  // that beats the request's registration matches nothing. Re-issue until the
  // op settles rather than betting on one grace window.
  private async embedRun(params: EmbedParams, cancelForm: CancelForm): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddings')
    const op = markHandled(embed({ modelId, text: this.buildPassages(params) }))

    let settled = false
    void op.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    const issueCancel = () =>
      cancelForm === 'broad'
        ? cancel({ operation: 'embeddings', modelId })
        : cancel({ requestId: op.requestId })

    const deadline = Date.now() + params.cancelDeadlineMs
    const cancelSlot = errorSlot()
    let attempts = 0

    await sleep(params.registryBeginGraceMs)
    while (!settled) {
      attempts++
      try {
        await issueCancel()
        cancelSlot.error = null
      } catch (err) {
        cancelSlot.error = toError(err)
      }
      if (settled || Date.now() >= deadline) break
      await sleep(params.cancelRetryMs)
    }

    // A cancel the engine refused, as opposed to one it accepted and ignored.
    if (!settled && cancelSlot.error) {
      return {
        passed: false,
        output: `cancel(${cancelForm}) still rejected after ${attempts} attempt(s) over ${params.cancelDeadlineMs}ms: ${describeError(cancelSlot.error)}`
      }
    }

    // An ignored cancel leaves the batch running for minutes. Bound it here so
    // the failure names the cause instead of surfacing as a test timeout.
    if (!(await settledWithin(op, params.settleTimeoutMs))) {
      return {
        passed: false,
        output: `${attempts} cancel(${cancelForm}) call(s) accepted, but embed was still running ${params.settleTimeoutMs}ms later — the cancel reached the engine and had no effect`
      }
    }

    return this.assertCancelled(op, 'embed', cancelForm)
  }

  private buildPassages(params: EmbedParams): string[] {
    return Array.from(
      { length: params.passageCount },
      (_, i) => `Passage ${i + 1}. ${params.passageFiller.repeat(params.passageFillerRepeats)}`
    )
  }

  private async assertCancelled(
    op: Promise<unknown>,
    label: string,
    cancelForm: CancelForm
  ): Promise<TestResult> {
    try {
      await op
      return {
        passed: false,
        output: `${label} resolved after cancel(${cancelForm}) — addon was not interrupted`
      }
    } catch (err) {
      if (!(err instanceof Error)) {
        return {
          passed: false,
          output: `${label} rejected with ${describeError(err)}`
        }
      }
      if (!isCancellationError(err)) {
        return {
          passed: false,
          output: `${label} rejected with ${describeError(err)}, expected a cancellation error`
        }
      }
      return {
        passed: true,
        output: `${label} cancel(${cancelForm}) OK: ${describeError(err)}`
      }
    }
  }

  async translateLlmBroad(
    params: TranslateLlmParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const result = translate({
      modelId,
      text: params.text,
      from: params.from,
      to: params.to,
      modelType: 'llamacpp-completion',
      stream: true
    })

    let received = 0
    let receivedAfterCancelAck = 0
    let cancelInvoked = false
    const cancelSlot = errorSlot()

    try {
      for await (const _token of result.tokenStream) {
        received++
        if (!cancelInvoked) {
          cancelInvoked = true
          // First token proves the addon is decoding. Await the cancel
          // acknowledgement so only later tokens count as post-cancel output.
          await cancel({ modelId, kind: 'translate' }).catch((err: unknown) => {
            cancelSlot.error = toError(err)
          })
        } else {
          receivedAfterCancelAck++
        }
      }
    } catch (err) {
      return {
        passed: false,
        output: `translate(llm) stream threw mid-iteration: ${describeError(err)}`
      }
    }

    if (cancelSlot.error) {
      return {
        passed: false,
        output: `cancel({ modelId, kind }) rejected: ${cancelSlot.error.message}`
      }
    }
    if (!cancelInvoked) {
      return {
        passed: false,
        output: 'translate(llm) stream ended before any token — cancel never fired'
      }
    }
    if (receivedAfterCancelAck > params.maxTokensAfterCancel) {
      return {
        passed: false,
        output: `translate(llm) yielded ${receivedAfterCancelAck} tokens after cancel acknowledgement (allowed ≤ ${params.maxTokensAfterCancel})`
      }
    }
    return {
      passed: true,
      output:
        `translate(llm) broad cancel OK: ${receivedAfterCancelAck} post-ack tokens ` +
        `(${received} total, allowed post-ack ≤ ${params.maxTokensAfterCancel})`
    }
  }

  async serializeConcurrent(params: PolicyParams, _expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const history = [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: params.prompt }
    ]

    // Fire two completions at the same model in the same tick. The default
    // completion policy serializes same-model requests FIFO instead of
    // rejecting the second, so BOTH must succeed — the second simply waits
    // for the first to release the native llama.cpp context, then runs.
    const run1 = completion({ modelId, history, stream: true })
    const run2 = completion({ modelId, history, stream: true })

    const [obs1, obs2] = await Promise.all([observeStream(run1.events), observeStream(run2.events)])
    const [final1, final2] = await Promise.all([captureFinal(run1.final), captureFinal(run2.final)])

    const checks: Array<[string, StreamObservation, FinalOutcome]> = [
      ['run1', obs1, final1],
      ['run2', obs2, final2]
    ]
    for (const [label, obs, final] of checks) {
      if (!final.resolved) {
        return {
          passed: false,
          output:
            `${label}.final rejected with ${describeError(final.error)} — both same-model ` +
            'completions must serialize and succeed, not reject'
        }
      }
      if (obs.lastStopReason === 'cancelled' || obs.lastStopReason === 'error') {
        return {
          passed: false,
          output: `${label} ended with stopReason=${JSON.stringify(obs.lastStopReason)}, expected a successful completion`
        }
      }
      if (obs.contentEvents === 0) {
        return {
          passed: false,
          output: `${label} produced no content — the serialized completion did not actually run`
        }
      }
    }

    return {
      passed: true,
      output:
        `Serialize-concurrent OK: both same-model completions succeeded ` +
        `(run1 ${obs1.contentEvents} deltas, run2 ${obs2.contentEvents} deltas)`
    }
  }

  // Fires two concurrent batchCompletions on a parallel>1 model, cancels one by
  // requestId, and asserts the peer batch still decodes to completion — pinning
  // that batch cancel is per-group (addon cancelJob), not whole-model.
  async cancelIsolatesConcurrentBatches(
    params: { doomedPredict: number; survivorPredict: number },
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm-batch')
    const mkBatch = (tag: string, predict: number, ask: string) =>
      batchCompletion({
        modelId,
        prompts: [
          {
            id: `${tag}-a`,
            history: [{ role: 'user', content: ask }],
            generationParams: { temp: 0, seed: 1, predict }
          },
          {
            id: `${tag}-b`,
            history: [{ role: 'user', content: ask }],
            generationParams: { temp: 0, seed: 2, predict }
          }
        ]
      })

    // Both batches generate long. The survivor MUST still be decoding when the
    // cancel lands: a short survivor could finish first, and then a whole-model
    // cancel would kill only the still-live doomed batch while the already-complete
    // survivor still passed — a false isolation pass.
    const doomed = mkBatch(
      'doomed',
      params.doomedPredict,
      'Write a very long detailed story about an otter and a river.'
    )
    const survivor = mkBatch(
      'survivor',
      params.survivorPredict,
      'Write a very long detailed story about a fox and a mountain.'
    )

    // Track survivor tokens over the WHOLE stream (never closed early) so we can
    // prove the survivor keeps decoding AFTER the doomed batch is cancelled.
    const survivorTokens: Record<string, number> = { 'survivor-a': 0, 'survivor-b': 0 }
    const tok = (id: string) => survivorTokens[id] ?? 0
    // Capture a tracker rejection so a survivor stream that errors mid-wait is
    // surfaced immediately by waitUntil, not hidden until the final Promise.all
    // (or as an unhandled rejection). The `.catch` also keeps it observed.
    let trackerError: unknown = null
    const survivorTracking = ['survivor-a', 'survivor-b'].map((id) =>
      (async () => {
        for await (const ev of survivor.byId(id).events) {
          if (ev.type === 'contentDelta') survivorTokens[id] = tok(id) + 1
        }
      })().catch((err: unknown) => {
        trackerError ??= err
      })
    )
    const waitUntil = async (pred: () => boolean, label: string) => {
      const deadline = Date.now() + 30000
      while (!pred()) {
        if (trackerError) throw trackerError
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    // Admission barrier: every sequence in both batches is actively decoding. ids
    // resolve before native sequence-slot admission, so a first token — not just an
    // id — proves the sequence is admitted and live. doomed streams are consumed
    // here; survivor progress is observed through its background token counters.
    const firstToken = async (run: typeof doomed, id: string) => {
      for await (const ev of run.byId(id).events) {
        if (ev.type === 'contentDelta') return
      }
    }
    await Promise.all([firstToken(doomed, 'doomed-a'), firstToken(doomed, 'doomed-b')])
    await waitUntil(() => tok('survivor-a') > 0 && tok('survivor-b') > 0, 'survivor admission')

    await cancel({ requestId: doomed.requestId })

    // Snapshot AFTER the cancel acknowledgement, then require further progress.
    // Snapshotting before cancel() could count tokens already in flight when the
    // cancel landed; taking it after the ack proves the survivor kept decoding
    // past the acknowledgement — i.e. the cancel hit only the doomed group (addon
    // cancelJob), not the whole model. A survivor that had already finished could
    // never advance here.
    const survivorAfterAck = { a: tok('survivor-a'), b: tok('survivor-b') }
    await waitUntil(
      () => tok('survivor-a') > survivorAfterAck.a && tok('survivor-b') > survivorAfterAck.b,
      'survivor progress after the cancel acknowledgement'
    )

    const doomedOutcome = await captureFinal(doomed.results)
    if (doomedOutcome.resolved) {
      return {
        passed: false,
        output: 'doomed batch resolved, but its cancel should have rejected it'
      }
    }
    if (!(doomedOutcome.error instanceof InferenceCancelledError)) {
      return {
        passed: false,
        output: `doomed batch rejected with ${describeError(doomedOutcome.error)}, expected InferenceCancelledError`
      }
    }

    let results: Awaited<ReturnType<typeof batchCompletion>['results']>
    try {
      results = await survivor.results
      await Promise.all(survivorTracking)
      if (trackerError) throw trackerError
    } catch (err) {
      return {
        passed: false,
        output: `peer batch rejected with ${describeError(err)} — cancelling one batch must not stop a concurrent peer`
      }
    }
    if (
      !Array.isArray(results) ||
      results.length !== 2 ||
      results.some((r) => r.final.contentText.length === 0)
    ) {
      return {
        passed: false,
        output: `peer batch resolved but produced no content: ${JSON.stringify(results)}`
      }
    }

    return {
      passed: true,
      output:
        'Per-group batch cancel: doomed batch cancelled; concurrent peer batch kept decoding after the cancel and completed'
    }
  }

  // Cancels one batch while more native sequences are queued than the model's
  // parallel width. The SDK request signal, not an addon error string, must own
  // the terminal outcome.
  async cancelQueuedNativeBatch(
    params: { promptCount: number; parallel: number; predict: number },
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm-batch')
    const ids = Array.from({ length: params.promptCount }, (_, index) => `queued-${index}`)
    const run = batchCompletion({
      modelId,
      prompts: ids.map((id, index) => ({
        id,
        history: [
          {
            role: 'user',
            content: `Write a long detailed story about topic ${index} using many sentences.`
          }
        ],
        generationParams: { temp: 0, seed: index + 1, predict: params.predict }
      }))
    })
    const results = markHandled(run.results)
    const tokenCounts = new Map(ids.map((id) => [id, 0]))
    let trackerError: unknown = null
    const trackers = ids.map((id) =>
      (async () => {
        for await (const event of run.byId(id).events) {
          if (event.type === 'contentDelta') {
            tokenCounts.set(id, (tokenCounts.get(id) ?? 0) + 1)
          }
        }
      })().catch((error: unknown) => {
        trackerError ??= error
      })
    )

    const deadline = Date.now() + 30000
    while (![...tokenCounts.values()].some((count) => count > 0)) {
      if (trackerError) break
      if (Date.now() > deadline) break
      await sleep(25)
    }
    const zeroTokenIds = ids.filter((id) => tokenCounts.get(id) === 0)

    let cancelError: unknown = null
    try {
      await cancel({ requestId: run.requestId })
    } catch (error) {
      cancelError = error
    }
    const outcome = await captureFinal(results)
    await Promise.all(trackers)

    if (cancelError) {
      return {
        passed: false,
        output: `queued batch cancel rejected: ${describeError(cancelError)}`
      }
    }
    if (trackerError) {
      return {
        passed: false,
        output: `queued batch stream failed: ${describeError(trackerError)}`
      }
    }
    const minimumQueued = params.promptCount - params.parallel
    if (minimumQueued < 1 || zeroTokenIds.length < minimumQueued) {
      return {
        passed: false,
        output:
          `only ${zeroTokenIds.length}/${ids.length} sequences awaited their first token; ` +
          `expected at least ${minimumQueued} queued behind parallel=${params.parallel}`
      }
    }
    if (!(outcome.error instanceof InferenceCancelledError)) {
      return {
        passed: false,
        output: `queued batch ended with ${describeError(outcome.error)}, expected InferenceCancelledError`
      }
    }

    return {
      passed: true,
      output:
        `Queued native batch cancellation surfaced InferenceCancelledError with ` +
        `${zeroTokenIds.length}/${ids.length} sequences still awaiting their first token`
    }
  }

  async ragIngestTargeted(params: RagIngestParams, _expectation: Expectation): Promise<TestResult> {
    const embeddingModelId = await this.resources.ensureLoaded('embeddings')
    const workspace = `${params.workspaceBase}-${embeddingModelId.substring(0, 8)}`

    await this.safeDeleteWorkspace(workspace)

    const document = params.documentFiller.repeat(params.documentFillerRepeats)
    const op = markHandled(
      ragIngest({
        modelId: embeddingModelId,
        workspace,
        documents: [document],
        chunk: true,
        chunkOpts: {
          chunkSize: params.chunkSize,
          chunkOverlap: params.chunkOverlap,
          chunkStrategy: 'character'
        }
      })
    )

    try {
      // Unary op without observable progress — sleep covers registry begin.
      await sleep(params.registryBeginGraceMs)
      try {
        await cancel({ requestId: op.requestId })
      } catch (err) {
        return {
          passed: false,
          output: `cancel({ requestId }) for ragIngest rejected: ${describeError(err)}`
        }
      }
      return await this.assertCancelled(op, 'ragIngest', 'requestId')
    } finally {
      await this.safeDeleteWorkspace(workspace)
    }
  }

  private async safeDeleteWorkspace(workspace: string): Promise<void> {
    try {
      await ragDeleteWorkspace({ workspace })
    } catch {
      // workspace may not exist yet or be mid-flight; either case is harmless
    }
  }

  // Fire cancel synchronously after transcribe() so it races begin() at
  // the registry. Two valid cancellation outcomes are accepted:
  //   - rejection with a cancellation error (addon aborted mid-decode);
  //   - empty result (server's iterate loop broke on signal.aborted
  //     before yielding any segment).
  // Non-empty result means cancel was too late.
  protected async transcribeWithCancel(audioPath: string): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('whisper')
    const op = markHandled(transcribe({ modelId, audioChunk: audioPath }))
    const startMs = Date.now()

    const cancelSlot = errorSlot()
    const cancelTask = cancel({ requestId: op.requestId }).catch((err) => {
      cancelSlot.error = toError(err)
    })

    try {
      const text = await op
      await cancelTask
      const elapsedMs = Date.now() - startMs
      if (cancelSlot.error) {
        return {
          passed: false,
          output: `cancel({ requestId }) for transcribe rejected: ${cancelSlot.error.message}`
        }
      }
      if (text.length === 0) {
        return {
          passed: true,
          output: `transcribe cancel({ requestId }) OK: empty result after cancel (elapsed=${elapsedMs}ms)`
        }
      }
      return {
        passed: false,
        output: `transcribe resolved with ${text.length} chars after cancel({ requestId }) (elapsed=${elapsedMs}ms) — cancel was too late to interrupt the operation`
      }
    } catch (err) {
      await cancelTask
      const elapsedMs = Date.now() - startMs
      if (cancelSlot.error) {
        return {
          passed: false,
          output: `cancel({ requestId }) for transcribe rejected: ${cancelSlot.error.message}`
        }
      }
      if (err instanceof Error && isCancellationError(err)) {
        return {
          passed: true,
          output: `transcribe cancel({ requestId }) OK: ${describeError(err)} (elapsed=${elapsedMs}ms)`
        }
      }
      return {
        passed: false,
        output: `transcribe rejected with non-cancellation error: ${describeError(err)}`
      }
    }
  }
}
