import {
  cancel,
  getLoadedModelInfo,
  heartbeat,
  InferenceCancelledError,
  ModelLeasedError,
  openSession,
  SessionInvalidatedError,
  type CompletionEvent,
  type QvacSession
} from '@qvac/sdk'
import { type Expectation, type TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  sessionCancelIsScopedToOwnSession,
  sessionSharedModelSurvivesUnload,
  sessionCloseReleasesLeases,
  sessionCloseCancelsInFlightRequests,
  sessionDuplicateRequestIdsAcrossSessions,
  sessionCalledAfterCloseIsRefused,
  sessionModelCancelIsScoped,
  sessionDiffusionSharedModel,
  sessionConfigHashSeparatesModels,
  sessionReloadRefusedWhileLeased,
  sessionLastLeaseUnloadKeepsRuntime,
  sessionTests
} from '../../../../catalog/session-tests.js'

interface PromptParams {
  prompt: string
  cancelAfterTokens?: number
}

interface AnswerParams {
  prompt: string
  expectedAnswerContains: string
}

interface EmbedParams {
  text: string
}

interface DiffusionParams {
  prompt: string
  width: number
  height: number
  steps: number
  seed: number
}

interface ConfigHashParams extends AnswerParams {
  smallContextDependency: string
}

interface ReloadParams {
  dependency: string
  modelType: string
  reloadConfig: Record<string, unknown>
}

interface DependencyParams {
  dependency: string
}

const SYSTEM_PROMPT = 'You are a helpful assistant. Answer briefly.'

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.constructor.name}(name=${err.name}, message=${err.message})`
  }
  return `non-Error: ${String(err)}`
}

async function closeQuietly(sessions: QvacSession[]): Promise<void> {
  for (const session of sessions) {
    try {
      await session.close()
    } catch {
      // Already closed by the test body, or ended with the runtime.
    }
  }
}

// Drains a completion stream, running `onContentDelta` after each content event.
async function observe(
  events: AsyncIterable<CompletionEvent>,
  onContentDelta?: (count: number) => Promise<void>
): Promise<{ text: string; contentEvents: number; stopReason: string | null }> {
  let text = ''
  let contentEvents = 0
  let stopReason: string | null = null
  for await (const event of events) {
    if (event.type === 'contentDelta') {
      contentEvents++
      text += event.text
      if (onContentDelta) await onContentDelta(contentEvents)
    } else if (event.type === 'completionDone') {
      stopReason = event.stopReason ?? null
    }
  }
  return { text, contentEvents, stopReason }
}

async function leaseCount(modelId: string): Promise<number | undefined> {
  const info = await getLoadedModelInfo({ modelId })
  return info.leaseCount
}

export class SessionExecutor extends AbstractModelExecutor<typeof sessionTests> {
  pattern = /^session-/

  protected handlers = {
    [sessionCancelIsScopedToOwnSession.testId]: this.cancelScoped.bind(this),
    [sessionSharedModelSurvivesUnload.testId]: this.sharedModelSurvivesUnload.bind(this),
    [sessionCloseReleasesLeases.testId]: this.closeReleasesLeases.bind(this),
    [sessionCloseCancelsInFlightRequests.testId]: this.closeCancelsInFlight.bind(this),
    [sessionDuplicateRequestIdsAcrossSessions.testId]: this.cancelBeforeBeginScoped.bind(this),
    [sessionCalledAfterCloseIsRefused.testId]: this.calledAfterClose.bind(this),
    [sessionModelCancelIsScoped.testId]: this.modelCancelScoped.bind(this),
    [sessionDiffusionSharedModel.testId]: this.diffusionSharedModel.bind(this),
    [sessionConfigHashSeparatesModels.testId]: this.configHashSeparatesModels.bind(this),
    [sessionReloadRefusedWhileLeased.testId]: this.reloadRefusedWhileLeased.bind(this),
    [sessionLastLeaseUnloadKeepsRuntime.testId]: this.lastLeaseUnloadKeepsRuntime.bind(this)
  } as never

  // Two sessions hold the same model as the owner does: three leases.
  private async openPair(dep: string): Promise<{
    a: QvacSession
    b: QvacSession
    modelId: string
  }> {
    const ownerModelId = await this.resources.ensureLoaded(dep)
    const params = await this.resources.loadParams(dep)
    const a = openSession({ name: 'e2e-a' })
    const b = openSession({ name: 'e2e-b' })
    const modelId = await a.loadModel(params as never)
    const again = await b.loadModel(params as never)
    if (modelId !== ownerModelId || again !== ownerModelId) {
      await closeQuietly([a, b])
      throw new Error(
        `sessions did not join the owner's model: owner=${ownerModelId} a=${modelId} b=${again}`
      )
    }
    return { a, b, modelId }
  }

  async cancelScoped(params: PromptParams, _expectation: Expectation): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3
    const history = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: params.prompt }
    ]
    try {
      const run = a.completion({
        modelId,
        history,
        stream: true,
        generationParams: { predict: 24 }
      })
      let foreignCancelled = false
      const observed = await observe(run.events, async (count) => {
        if (!foreignCancelled && count >= cancelAfterTokens) {
          foreignCancelled = true
          await b.cancel({ requestId: run.requestId })
        }
      })
      if (observed.stopReason === 'cancelled') {
        return {
          passed: false,
          output: "session B's cancel({ requestId }) stopped session A's completion"
        }
      }
      await run.final

      const second = a.completion({ modelId, history, stream: true })
      let ownCancelled = false
      const observedSecond = await observe(second.events, async (count) => {
        if (!ownCancelled && count >= cancelAfterTokens) {
          ownCancelled = true
          await a.cancel({ requestId: second.requestId })
        }
      })
      if (observedSecond.stopReason !== 'cancelled') {
        return {
          passed: false,
          output: `session A's own cancel did not stop its completion (stopReason=${observedSecond.stopReason})`
        }
      }
      try {
        await second.final
        return { passed: false, output: 'run.final resolved after a same-session cancel' }
      } catch (err) {
        if (!(err instanceof InferenceCancelledError)) {
          return {
            passed: false,
            output: `expected InferenceCancelledError, got ${describeError(err)}`
          }
        }
      }
      return {
        passed: true,
        output: `foreign cancel ignored after ${observed.contentEvents} deltas; own cancel honoured`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  async sharedModelSurvivesUnload(
    params: AnswerParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('llm')
    try {
      const before = await leaseCount(modelId)
      const released = await a.unloadModel({ modelId })
      const afterOne = await leaseCount(modelId)
      if (released.unloaded || afterOne !== (before ?? 0) - 1) {
        return {
          passed: false,
          output: `session A's unload: unloaded=${released.unloaded} leases ${before} -> ${afterOne}`
        }
      }

      const run = b.completion({
        modelId,
        history: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: params.prompt }
        ],
        stream: true
      })
      const text = await run.text
      if (!text.toUpperCase().includes(params.expectedAnswerContains)) {
        return {
          passed: false,
          output: `session B could not use the shared model after A unloaded: ${JSON.stringify(text)}`
        }
      }

      const releasedB = await b.unloadModel({ modelId })
      const afterTwo = await leaseCount(modelId)
      if (releasedB.unloaded || afterTwo !== (before ?? 0) - 2) {
        return {
          passed: false,
          output: `session B's unload: unloaded=${releasedB.unloaded} leases ${afterOne} -> ${afterTwo}`
        }
      }
      return {
        passed: true,
        output: `leases ${before} -> ${afterOne} -> ${afterTwo}; the owner's lease keeps the model loaded`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  async closeReleasesLeases(params: AnswerParams, _expectation: Expectation): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('llm')
    try {
      const before = await leaseCount(modelId)
      await a.close()
      const afterClose = await leaseCount(modelId)
      if (afterClose !== (before ?? 0) - 1) {
        return { passed: false, output: `closing A: leases ${before} -> ${afterClose}` }
      }

      const run = b.completion({
        modelId,
        history: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: params.prompt }
        ],
        stream: true
      })
      const text = await run.text
      if (!text.toUpperCase().includes(params.expectedAnswerContains)) {
        return {
          passed: false,
          output: `session B could not use the model after A closed: ${JSON.stringify(text)}`
        }
      }

      await b.close()
      const afterBoth = await leaseCount(modelId)
      if (afterBoth !== (before ?? 0) - 2) {
        return { passed: false, output: `closing B: leases ${afterClose} -> ${afterBoth}` }
      }
      return { passed: true, output: `leases ${before} -> ${afterClose} -> ${afterBoth}` }
    } finally {
      await closeQuietly([a, b])
    }
  }

  async closeCancelsInFlight(params: PromptParams, _expectation: Expectation): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3
    try {
      const run = a.completion({
        modelId,
        history: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: params.prompt }
        ],
        stream: true
      })
      let closed = false
      const observed = await observe(run.events, async (count) => {
        if (!closed && count >= cancelAfterTokens) {
          closed = true
          await a.close()
        }
      })
      if (observed.stopReason !== 'cancelled') {
        return {
          passed: false,
          output: `closing the session did not cancel its completion (stopReason=${observed.stopReason})`
        }
      }
      try {
        await run.final
        return { passed: false, output: 'run.final resolved after its session closed' }
      } catch (err) {
        if (!(err instanceof InferenceCancelledError)) {
          return {
            passed: false,
            output: `expected InferenceCancelledError, got ${describeError(err)}`
          }
        }
      }
      try {
        await a.heartbeat()
        return { passed: false, output: 'a closed session still accepted a call' }
      } catch (err) {
        if (!(err instanceof SessionInvalidatedError)) {
          return {
            passed: false,
            output: `expected SessionInvalidatedError, got ${describeError(err)}`
          }
        }
      }
      const leases = await leaseCount(modelId)
      return {
        passed: true,
        output: `close cancelled the run after ${observed.contentEvents} deltas; leases now ${leases}`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  async cancelBeforeBeginScoped(
    params: EmbedParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('embeddings')
    try {
      const foreign = a.embed({ modelId, text: params.text })
      await b.cancel({ requestId: foreign.requestId })
      const { embedding } = await foreign
      if (embedding.length === 0) {
        return { passed: false, output: 'embed returned no vector' }
      }

      const own = a.embed({ modelId, text: params.text })
      own.catch(() => {})
      await a.cancel({ requestId: own.requestId })
      try {
        await own
        return {
          passed: false,
          output: 'a same-session cancel-before-begin did not stop the embed'
        }
      } catch (err) {
        if (!(err instanceof InferenceCancelledError)) {
          return {
            passed: false,
            output: `expected InferenceCancelledError, got ${describeError(err)}`
          }
        }
      }
      return {
        passed: true,
        output: `foreign cancel-before-begin ignored (dim=${embedding.length}); own cancel honoured`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  async calledAfterClose(_params: unknown, _expectation: Expectation): Promise<TestResult> {
    const session = openSession({ name: 'e2e-closed' })
    await session.heartbeat()
    await session.close()
    try {
      await session.heartbeat()
      return { passed: false, output: 'a closed session still accepted a call' }
    } catch (err) {
      if (!(err instanceof SessionInvalidatedError)) {
        return {
          passed: false,
          output: `expected SessionInvalidatedError, got ${describeError(err)}`
        }
      }
    }
    try {
      await session.close()
      return { passed: false, output: 'a second close() did not fail' }
    } catch (err) {
      if (!(err instanceof SessionInvalidatedError)) {
        return {
          passed: false,
          output: `expected SessionInvalidatedError, got ${describeError(err)}`
        }
      }
    }
    return { passed: true, output: 'calls after close() fail locally with SessionInvalidatedError' }
  }

  // Two completions on one model run one after the other: the second waits for
  // the model's slot. A session's cancel({ modelId }) must stop only its own
  // run, running or queued; the owner's stops both.
  async modelCancelScoped(params: PromptParams, _expectation: Expectation): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3
    const history = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: params.prompt }
    ]
    const start = (session: QvacSession) =>
      session.completion({ modelId, history, stream: true, generationParams: { predict: 24 } })
    try {
      const runA = start(a)
      const runB = start(b)
      runB.final.catch(() => {})
      let cancelled = false
      const observedA = await observe(runA.events, async (count) => {
        if (!cancelled && count >= cancelAfterTokens) {
          cancelled = true
          await a.cancel({ modelId })
        }
      })
      if (observedA.stopReason !== 'cancelled') {
        return {
          passed: false,
          output: `session A's cancel({ modelId }) did not stop its own run (stopReason=${observedA.stopReason})`
        }
      }
      const observedB = await observe(runB.events)
      if (observedB.stopReason === 'cancelled' || observedB.contentEvents === 0) {
        return {
          passed: false,
          output: `session A's cancel({ modelId }) reached session B's queued run (stopReason=${observedB.stopReason}, deltas=${observedB.contentEvents})`
        }
      }
      await runB.final

      const runA2 = start(a)
      const runB2 = start(b)
      runA2.final.catch(() => {})
      runB2.final.catch(() => {})
      let ownerCancelled = false
      const observedA2 = await observe(runA2.events, async (count) => {
        if (!ownerCancelled && count >= cancelAfterTokens) {
          ownerCancelled = true
          await cancel({ modelId })
        }
      })
      if (observedA2.stopReason !== 'cancelled') {
        return {
          passed: false,
          output: `the owner's cancel({ modelId }) did not stop session A's run (stopReason=${observedA2.stopReason})`
        }
      }
      let queuedCancelled = false
      try {
        const observedB2 = await observe(runB2.events)
        queuedCancelled = observedB2.stopReason === 'cancelled'
      } catch (err) {
        queuedCancelled = err instanceof InferenceCancelledError
      }
      if (!queuedCancelled) {
        return {
          passed: false,
          output: "the owner's cancel({ modelId }) did not reach session B's queued run"
        }
      }
      return {
        passed: true,
        output: `session cancel stopped A only (B produced ${observedB.contentEvents} deltas); owner cancel stopped A and B`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  // Two sessions share one diffusion model, which runs one generation at a
  // time. B's cancel of A's request id is ignored, A's own cancel stops it,
  // and B still generates on the model afterwards; A's unload keeps the model.
  async diffusionSharedModel(
    params: DiffusionParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const { a, b, modelId } = await this.openPair('diffusion')
    try {
      const generation = { modelId, ...params }
      const runA = a.diffusion(generation)
      runA.outputs.catch(() => {})
      runA.stats.catch(() => {})

      let ticksA = 0
      const progressA = (async () => {
        try {
          for await (const _tick of runA.progressStream) {
            ticksA++
            if (ticksA === 1) await b.cancel({ requestId: runA.requestId })
            if (ticksA === 2) await a.cancel({ requestId: runA.requestId })
          }
        } catch {
          // The stream fails once the generation is cancelled.
        }
      })()
      try {
        await runA.outputs
        await progressA
        return {
          passed: false,
          output: `session A's diffusion finished after its own cancel (${ticksA} ticks)`
        }
      } catch (err) {
        await progressA
        if (!(err instanceof InferenceCancelledError)) {
          return {
            passed: false,
            output: `expected InferenceCancelledError, got ${describeError(err)}`
          }
        }
        if (ticksA < 2) {
          return {
            passed: false,
            output: `session B's cancel({ requestId }) stopped session A's diffusion after ${ticksA} tick(s)`
          }
        }
      }

      const outputsB = await b.diffusion(generation).outputs
      if (outputsB.length === 0 || outputsB[0]!.length === 0) {
        return { passed: false, output: "session B's diffusion produced no image after A's cancel" }
      }

      const before = await leaseCount(modelId)
      const released = await a.unloadModel({ modelId })
      const after = await leaseCount(modelId)
      if (released.unloaded || after !== (before ?? 0) - 1) {
        return {
          passed: false,
          output: `session A's unload: unloaded=${released.unloaded} leases ${before} -> ${after}`
        }
      }
      return {
        passed: true,
        output: `A cancelled after ${ticksA} progress tick(s); B produced ${outputsB.length} image(s); leases ${before} -> ${after}`
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  // The model id is a hash of the source and the load configuration, so a
  // session that wants the same weights with another configuration gets its
  // own model and never touches the owner's.
  async configHashSeparatesModels(
    params: ConfigHashParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const ownerModelId = await this.resources.ensureLoaded('llm')
    const smallContext = await this.resources.loadParams(params.smallContextDependency)
    const session = openSession({ name: 'e2e-small-ctx' })
    try {
      const sessionModelId = await session.loadModel(smallContext as never)
      if (sessionModelId === ownerModelId) {
        return {
          passed: false,
          output: `a different modelConfig produced the owner's modelId ${ownerModelId}`
        }
      }
      const ownerLeasesBefore = await leaseCount(ownerModelId)
      const sessionLeases = await leaseCount(sessionModelId)
      if (sessionLeases !== 1) {
        return {
          passed: false,
          output: `the session's model has ${sessionLeases} lease(s), expected 1`
        }
      }

      const run = session.completion({
        modelId: sessionModelId,
        history: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: params.prompt }
        ],
        stream: true
      })
      const text = await run.text
      if (!text.toUpperCase().includes(params.expectedAnswerContains)) {
        return {
          passed: false,
          output: `the session's model did not answer: ${JSON.stringify(text)}`
        }
      }

      const released = await session.unloadModel({ modelId: sessionModelId })
      const ownerLeasesAfter = await leaseCount(ownerModelId)
      if (!released.unloaded || ownerLeasesAfter !== ownerLeasesBefore) {
        return {
          passed: false,
          output: `unloading the session's model: unloaded=${released.unloaded}, owner leases ${ownerLeasesBefore} -> ${ownerLeasesAfter}`
        }
      }
      return {
        passed: true,
        output: `owner ${ownerModelId} and session ${sessionModelId} loaded side by side; the session's unload left the owner's model alone`
      }
    } finally {
      await closeQuietly([session])
    }
  }

  // A config reload mutates the one native model, so it is refused while
  // another session holds a lease and allowed again once that lease is gone.
  async reloadRefusedWhileLeased(
    params: ReloadParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const loadParams = await this.resources.loadParams(params.dependency)
    const a = openSession({ name: 'e2e-reload-a' })
    const b = openSession({ name: 'e2e-reload-b' })
    try {
      const modelId = await a.loadModel(loadParams as never)
      const reload = () =>
        a.loadModel({
          modelId,
          modelType: params.modelType,
          modelConfig: params.reloadConfig
        } as never)

      const alone = await reload()
      if (alone !== modelId) {
        return {
          passed: false,
          output: `a sole-lease reload returned ${alone}, expected ${modelId}`
        }
      }

      const shared = await b.loadModel(loadParams as never)
      if (shared !== modelId) {
        return { passed: false, output: `session B loaded ${shared} instead of joining ${modelId}` }
      }
      try {
        await reload()
        return { passed: false, output: 'a reload went through while session B held a lease' }
      } catch (err) {
        if (!(err instanceof ModelLeasedError)) {
          return { passed: false, output: `expected ModelLeasedError, got ${describeError(err)}` }
        }
      }

      await b.close()
      const again = await reload()
      if (again !== modelId) {
        return { passed: false, output: `the reload after B closed returned ${again}` }
      }
      return {
        passed: true,
        output:
          'reload allowed alone, refused with ModelLeasedError while shared, allowed again after B closed'
      }
    } finally {
      await closeQuietly([a, b])
    }
  }

  // Unloading the last lease of a model never shuts the runtime down: only
  // the owner closes it, and only when no session is open.
  async lastLeaseUnloadKeepsRuntime(
    params: DependencyParams,
    _expectation: Expectation
  ): Promise<TestResult> {
    const loadParams = await this.resources.loadParams(params.dependency)
    const loader = openSession({ name: 'e2e-loader' })
    const watcher = openSession({ name: 'e2e-watcher' })
    try {
      await watcher.heartbeat()
      const modelId = await loader.loadModel(loadParams as never)
      const leases = await leaseCount(modelId)
      if (leases !== 1) {
        return { passed: false, output: `the session's model has ${leases} lease(s), expected 1` }
      }
      const released = await loader.unloadModel({ modelId })
      if (!released.released || !released.unloaded) {
        return {
          passed: false,
          output: `the last lease's unload: released=${released.released} unloaded=${released.unloaded}`
        }
      }
      try {
        await watcher.heartbeat()
        await heartbeat()
      } catch (err) {
        return {
          passed: false,
          output: `the runtime went away after the last unload: ${describeError(err)}`
        }
      }
      return {
        passed: true,
        output: 'the model unloaded and the runtime stayed up for the other session'
      }
    } finally {
      await closeQuietly([loader, watcher])
    }
  }
}
