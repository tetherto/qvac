import { cancel, completion, deleteCache } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { kvCacheTests } from '../../kv-cache-tests.js'
import { callWhenAddonIdle } from '../utils/addon-idle.js'

interface ChatMessage {
  role: string
  content: string
}

export class KvCacheExecutor extends AbstractModelExecutor<typeof kvCacheTests> {
  pattern = /^kv-cache-/

  protected handlers = Object.fromEntries(
    kvCacheTests.map((test) => {
      if (test.testId === 'kv-cache-delete-and-reuse')
        return [test.testId, this.deleteAndReuse.bind(this)]
      if (test.testId === 'kv-cache-session-switch')
        return [test.testId, this.sessionSwitch.bind(this)]
      if (test.testId === 'kv-cache-different-system-prompts')
        return [test.testId, this.differentSystemPrompts.bind(this)]
      if (test.testId === 'kv-cache-stats-verification')
        return [test.testId, this.statsVerification.bind(this)]
      if (test.testId === 'kv-cache-remove-thinking-compaction')
        return [test.testId, this.removeThinkingCompaction.bind(this)]
      if (test.testId === 'kv-cache-tools-sequential-save')
        return [test.testId, this.toolsSequentialSave.bind(this)]
      if (test.testId === 'kv-cache-cancel-then-new-prompt')
        return [test.testId, this.cancelThenNewPrompt.bind(this)]
      if (
        test.testId === 'kv-cache-concurrent-same-key' ||
        test.testId === 'kv-cache-concurrent-same-key-auto'
      )
        return [test.testId, this.concurrentSameKey.bind(this)]
      if (test.testId === 'kv-cache-auto-concurrency')
        return [test.testId, this.autoCacheConcurrency.bind(this)]
      if (
        test.testId.startsWith('kv-cache-delete-') ||
        test.testId === 'kv-cache-hypercore-deletion'
      ) {
        return [test.testId, this.deleteCacheOp.bind(this)]
      }
      return [test.testId, this.kvCompletion.bind(this)]
    })
  ) as never

  async deleteCacheOp(
    params: { deleteAll?: boolean; kvCacheKey?: string; modelIdToDelete?: string },
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      let result: { success: boolean }
      if (params.deleteAll) {
        result = await deleteCache({ all: true })
      } else if (params.kvCacheKey) {
        const opts: { kvCacheKey: string; modelId?: string } = { kvCacheKey: params.kvCacheKey }
        if (params.modelIdToDelete) opts.modelId = params.modelIdToDelete
        result = await deleteCache(opts)
      } else {
        return { passed: false, output: 'No delete params provided' }
      }
      return ValidationHelpers.validate(result.success ? 'success' : 'failed', expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Delete cache failed: ${errorMsg}` }
    }
  }

  // Retry on a policy-reject so a slot left by a previously wedged test does not poison this one.
  private runCompletion(
    modelId: string,
    params: {
      history: ChatMessage[]
      stream?: boolean
      kvCache?: string | boolean
      tools?: unknown[]
    }
  ): Promise<string> {
    return callWhenAddonIdle(async () => {
      const result = completion({
        modelId,
        history: params.history,
        stream: params.stream ?? false,
        kvCache: params.kvCache as never,
        ...(params.tools ? { tools: params.tools as never } : {})
      })

      if (params.stream) {
        let fullText = ''
        for await (const token of result.tokenStream) {
          fullText += token
        }
        return fullText
      }
      return result.text
    })
  }

  async kvCompletion(
    params: {
      history: ChatMessage[]
      stream?: boolean
      kvCache?: string | boolean
      tools?: unknown[]
    },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    try {
      const text = await this.runCompletion(modelId, params)
      return ValidationHelpers.validate(text, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `KV cache completion failed: ${errorMsg}` }
    }
  }

  // Fires several completions sharing one kvCache key at once on a parallel>1
  // model and proves the per-cache-path lock serializes them: their decode
  // intervals must never overlap (peak overlap 1), and all must still succeed.
  // Called directly (not via callWhenAddonIdle) so the requests race for real.
  async concurrentSameKey(
    params: {
      history: ChatMessage[]
      kvCache: string | boolean
      generationParams?: Record<string, unknown>
    },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm-batch')
    const CONCURRENCY = 2

    const fire = () => {
      const run = completion({
        modelId,
        history: params.history,
        stream: true,
        kvCache: params.kvCache as never,
        ...(params.generationParams ? { generationParams: params.generationParams as never } : {})
      })
      let start = 0
      return (async () => {
        let text = ''
        for await (const token of run.tokenStream) {
          if (start === 0) start = Date.now()
          text += token
        }
        return { start, end: Date.now(), text }
      })()
    }

    let intervals: Array<{ start: number; end: number; text: string }>
    try {
      intervals = await Promise.all(Array.from({ length: CONCURRENCY }, fire))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Concurrent same-key completion threw: ${msg}` }
    }

    const empty = intervals.filter((i) => i.text.length === 0).length
    if (empty > 0) {
      return {
        passed: false,
        output: `${empty}/${CONCURRENCY} same-key completions produced no output`
      }
    }

    // Peak number of decode intervals live at once; ties resolve end-before-
    // start so back-to-back turns don't read as overlap.
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

    if (peakOverlap > 1) {
      return {
        passed: false,
        output:
          `Same-key cached completions overlapped (peak ${peakOverlap}); the ` +
          `per-cache-path lock did not serialize them`
      }
    }

    const failed = intervals
      .map((i) => ValidationHelpers.validate(i.text, expectation))
      .find((result) => !result.passed)
    if (failed) {
      return { passed: false, output: `Same-key completion failed expectation: ${failed.output}` }
    }

    return {
      passed: true,
      output: `Same-key cached completions serialized (peak overlap ${peakOverlap}) and both succeeded`
    }
  }

  // Auto-cache turns must decode concurrently at the engine level — both with
  // each other (cached-vs-cached) and alongside plain completions without
  // starving them. Gates on the engine's own avgConcurrentSeq metric.
  async autoCacheConcurrency(
    params: { generationParams?: Record<string, unknown> },
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm-batch')
    const TOPICS = ['oceans', 'mountains', 'deserts', 'forests']

    const fire = (content: string, useCache: boolean) => {
      const run = completion({
        modelId,
        history: [{ role: 'user', content }],
        stream: true,
        ...(useCache ? { kvCache: true } : {}),
        ...(params.generationParams ? { generationParams: params.generationParams as never } : {})
      } as never) as { tokenStream: AsyncIterable<string>; stats: Promise<unknown> }
      return (async () => {
        let text = ''
        let firstTokenAt = 0
        // Record lastTokenAt per token (the last DECODED token), not after the
        // stream closes: a cached stream closes only after its post-decode KV
        // commit/rename, so a stream-close timestamp would stretch the decode
        // window across the commit and falsely count commit-phase overlap as
        // decode overlap.
        let lastTokenAt = 0
        for await (const t of run.tokenStream) {
          const now = Date.now()
          if (firstTokenAt === 0) firstTokenAt = now
          lastTokenAt = now
          text += t
        }
        const stats = (await run.stats) as { avgConcurrentSeq?: number } | undefined
        return {
          text,
          avgConcurrentSeq: stats?.avgConcurrentSeq,
          useCache,
          firstTokenAt,
          lastTokenAt
        }
      })()
    }

    type Result = {
      text: string
      avgConcurrentSeq?: number
      useCache: boolean
      firstTokenAt: number
      lastTokenAt: number
    }
    const maxSeq = (group: Result[]) =>
      group.reduce<number>(
        (m, r) =>
          typeof r.avgConcurrentSeq === 'number' && r.avgConcurrentSeq > m ? r.avgConcurrentSeq : m,
        0
      )

    // Phase 1 — cached-vs-cached native concurrency. Fire only different-history
    // auto-cache turns (distinct cache paths, so distinct per-path locks). With
    // no plain requests in flight, a cached response's engine avgConcurrentSeq
    // can exceed 1 only by decoding alongside ANOTHER cached response — a direct
    // native proof that cached turns don't serialize, which client-side token
    // windows can't give (they stay open through post-decode commit/final).
    let cachedOnly: Result[]
    try {
      cachedOnly = await Promise.all(TOPICS.map((t) => fire(`Tell me about ${t} in detail.`, true)))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Cached-only auto turns threw: ${msg}` }
    }
    const cachedEmpty = cachedOnly.filter((r) => r.text.length === 0).length
    if (cachedEmpty > 0) {
      return {
        passed: false,
        output: `${cachedEmpty}/${cachedOnly.length} cached-only turns produced no output`
      }
    }
    const cachedOnlySeq = maxSeq(cachedOnly)
    if (cachedOnlySeq <= 1) {
      return {
        passed: false,
        output: `Different-history auto-cache turns serialized (engine avgConcurrentSeq ${cachedOnlySeq.toFixed(2)} <= 1 with no plain traffic)`
      }
    }

    // Phase 2 — mixed starvation. Interleave cached and plain so both kinds land
    // in the first `parallel` admission window; the plain turns must not starve
    // behind the cached ones.
    let results: Result[]
    try {
      results = await Promise.all(
        TOPICS.flatMap((topic) => [
          fire(`Tell me about ${topic} in detail.`, true),
          fire(`Name one fact about ${topic}.`, false)
        ])
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Mixed auto-cache + plain completions threw: ${msg}` }
    }
    const empty = results.filter((r) => r.text.length === 0).length
    if (empty > 0) {
      return {
        passed: false,
        output: `${empty}/${results.length} mixed completions produced no output`
      }
    }
    const auto = results.filter((r) => r.useCache)
    const plain = results.filter((r) => !r.useCache)
    const plainSeq = maxSeq(plain)
    if (plainSeq <= 1) {
      return {
        passed: false,
        output: `Plain completions starved behind auto-cache turns (engine avgConcurrentSeq ${plainSeq.toFixed(2)} <= 1)`
      }
    }

    // Per-request proof: a plain request produced tokens while an auto-cache
    // request was still decoding, not after it released a serializing lock.
    const overlaps = plain.some((p) =>
      auto.some((a) => p.firstTokenAt < a.lastTokenAt && a.firstTokenAt < p.lastTokenAt)
    )
    if (!overlaps) {
      return {
        passed: false,
        output: 'No plain completion produced tokens while an auto-cache turn was still decoding'
      }
    }

    return {
      passed: true,
      output: `Auto-cache turns decode concurrently with each other (cached-only avgConcurrentSeq ${cachedOnlySeq.toFixed(2)}) and don't starve plain completions (plain avgConcurrentSeq ${plainSeq.toFixed(2)}, token windows overlap)`
    }
  }

  async sessionSwitch(
    params: { sessions: Array<{ key: string; message: string }>; stream: boolean },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    try {
      const responses: string[] = []
      for (const session of params.sessions) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: 'system', content: 'You are a helpful math assistant. Be brief.' },
            { role: 'user', content: session.message }
          ],
          stream: params.stream,
          kvCache: session.key
        })
        responses.push(text)
      }

      const allResponded = responses.every((r) => r.length > 0)
      const result = `Session switching: ${responses.length} responses, all valid: ${allResponded}`
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Session switch failed: ${errorMsg}` }
    }
  }

  async differentSystemPrompts(
    params: { cacheKey: string; systemPrompts: string[]; userMessage: string; stream: boolean },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    try {
      const responses: string[] = []
      for (const systemPrompt of params.systemPrompts) {
        const text = await this.runCompletion(modelId, {
          history: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: params.userMessage }
          ],
          stream: params.stream,
          kvCache: params.cacheKey
        })
        responses.push(text)
      }

      const allResponded = responses.every((r) => r.length > 0)
      const result = `Different system prompts: ${responses.length} responses, all valid: ${allResponded}`
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `System prompt test failed: ${errorMsg}` }
    }
  }

  async deleteAndReuse(
    params: { cacheKey: string; history: ChatMessage[]; stream: boolean },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {
        /* ignore */
      }

      const text1 = await this.runCompletion(modelId, {
        history: params.history,
        stream: params.stream,
        kvCache: params.cacheKey
      })

      await deleteCache({ kvCacheKey: params.cacheKey })

      const text2 = await this.runCompletion(modelId, {
        history: params.history,
        stream: params.stream,
        kvCache: params.cacheKey
      })

      const result = `Delete and reuse: both calls successful (${text1.length} + ${text2.length} chars)`
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Delete and reuse failed: ${errorMsg}` }
    }
  }

  async statsVerification(
    params: { cacheKey: string; messages: string[]; stream: boolean },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {
        /* ignore */
      }

      const history: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant. Be brief.' }
      ]

      let firstCacheTokens = 0
      let secondCacheTokens = 0

      for (let i = 0; i < params.messages.length; i++) {
        history.push({ role: 'user', content: params.messages[i]! })

        const result = completion({
          modelId,
          history: [...history],
          stream: true,
          kvCache: params.cacheKey
        })

        let response = ''
        for await (const token of result.tokenStream) {
          response += token
        }

        const stats = await result.stats
        const cacheTokens = ((stats as Record<string, unknown>)?.cacheTokens as number) ?? 0

        if (i === 0) firstCacheTokens = cacheTokens
        else secondCacheTokens = cacheTokens

        history.push({ role: 'assistant', content: response })
      }

      const cacheUsed = secondCacheTokens > firstCacheTokens || secondCacheTokens > 0
      const result = `Cache tokens: first=${firstCacheTokens}, second=${secondCacheTokens}, used: ${cacheUsed}`
      if (!cacheUsed) {
        return { passed: false, output: `KV cache not used across turns. ${result}` }
      }
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Stats verification failed: ${errorMsg}` }
    }
  }

  // Proves `remove_thinking_from_context` is forwarded all the way to the
  // addon and actually compacts the reasoning block: runs the same two-turn
  // conversation twice against a reasoning model (Qwen3 — the "tools"
  // resource is the cross-platform Qwen3 build), once with the flag on and
  // once off, over independent cache keys. With compaction on, turn 1's
  // `<think>` block is dropped from the persisted cache, so turn 2 reloads a
  // smaller prefix and reports fewer `cacheTokens`. A passthrough regression
  // (flag dropped before the addon) collapses the two runs to equal token
  // counts and fails the assertion.
  async removeThinkingCompaction(
    params: {
      cacheKeyOn: string
      cacheKeyOff: string
      messages: string[]
      generationParams?: Record<string, unknown>
    },
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('tools')

    const runSession = async (cacheKey: string, removeThinking: boolean) => {
      try {
        await deleteCache({ kvCacheKey: cacheKey })
      } catch {
        /* fresh start */
      }

      const history: ChatMessage[] = []
      let lastCacheTokens = 0

      for (const message of params.messages) {
        history.push({ role: 'user', content: message })

        const result = completion({
          modelId,
          history: [...history],
          stream: false,
          kvCache: cacheKey,
          generationParams: {
            ...params.generationParams,
            remove_thinking_from_context: removeThinking
          }
        })

        const text = await result.text
        const stats = await result.stats
        lastCacheTokens = ((stats as Record<string, unknown>)?.cacheTokens as number) ?? 0

        history.push({ role: 'assistant', content: text })
      }

      return lastCacheTokens
    }

    try {
      const onTokens = await runSession(params.cacheKeyOn, true)
      const offTokens = await runSession(params.cacheKeyOff, false)

      const summary = `cacheTokens: remove_thinking on=${onTokens}, off=${offTokens}`
      if (!(onTokens < offTokens)) {
        return {
          passed: false,
          output: `Expected reasoning-block compaction to shrink the cached prefix going into turn 2. ${summary}`
        }
      }
      return ValidationHelpers.validate(summary, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `remove_thinking compaction test failed: ${errorMsg}` }
    }
  }

  async cancelThenNewPrompt(
    params: {
      cacheKey: string
      firstUserMessage: string
      secondUserMessage: string
      expectedAnswerContains: string
      cancelAfterTokens?: number
      generationParams?: Record<string, unknown>
    },
    _expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const cancelAfterTokens = params.cancelAfterTokens ?? 3

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {}

      const firstRun = completion({
        modelId,
        history: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: params.firstUserMessage }
        ],
        stream: true,
        kvCache: params.cacheKey
      })

      let receivedTokens = 0
      let cancelInvoked = false
      let cancelSucceeded = false
      let cancelError: Error | null = null

      try {
        for await (const _ of firstRun.tokenStream) {
          receivedTokens++
          if (!cancelInvoked && receivedTokens >= cancelAfterTokens) {
            cancelInvoked = true
            try {
              await cancel({ operation: 'inference', modelId })
              cancelSucceeded = true
            } catch (err) {
              cancelError = err instanceof Error ? err : new Error(String(err))
              break
            }
          }
        }
      } catch (streamErr) {
        if (!cancelInvoked) {
          const msg = streamErr instanceof Error ? streamErr.message : String(streamErr)
          return {
            passed: false,
            output:
              `First completion stream rejected before cancel could be issued ` +
              `(received ${receivedTokens} tokens): ${msg}`
          }
        }
      }

      if (cancelError !== null) {
        return {
          passed: false,
          output:
            `cancel() rejected mid-stream after ${receivedTokens} tokens, so the ` +
            `kv-cache regression scenario was never exercised: ${cancelError.message}`
        }
      }

      if (!cancelSucceeded) {
        return {
          passed: false,
          output: `First completion ended before cancel (received ${receivedTokens} tokens, expected >=${cancelAfterTokens})`
        }
      }

      // Wrap in callWhenAddonIdle: after cancel() the slot frees asynchronously,
      // so calling completion() directly can race with the cancelled job's cleanup.
      const secondText = await callWhenAddonIdle(async () => {
        const run = completion({
          modelId,
          history: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: params.secondUserMessage }
          ],
          stream: true,
          kvCache: params.cacheKey,
          ...(params.generationParams && { generationParams: params.generationParams })
        } as never)
        let text = ''
        for await (const token of run.tokenStream) {
          text += token
        }
        return text
      })

      const trimmed = secondText.trim()
      if (trimmed.length === 0) {
        return {
          passed: false,
          output:
            'Second completion on the same kvCache key returned an empty response ' +
            'after cancelling the previous streaming turn. Expected the new prompt ' +
            'to produce output independent of the cancelled turn.'
        }
      }
      const expected = params.expectedAnswerContains
      if (!trimmed.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output:
            `Second completion on the same kvCache key did not include the expected ` +
            `token ${JSON.stringify(expected)} after cancelling the previous ` +
            `streaming turn. Got ${secondText.length} chars: ` +
            `${JSON.stringify(secondText.slice(0, 200))}`
        }
      }

      return {
        passed: true,
        output:
          `Cancel-then-new-prompt OK: cancelled after ${receivedTokens} tokens, ` +
          `second turn produced ${secondText.length} chars containing ${JSON.stringify(expected)}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Cancel-then-new-prompt failed: ${errorMsg}` }
    }
  }

  async toolsSequentialSave(
    params: {
      cacheKey: string
      tools: unknown[]
      messages: string[]
      stream: boolean
      generationParams?: Record<string, unknown>
    },
    expectation: Expectation
  ): Promise<TestResult> {
    let toolsModelId = await this.resources.ensureLoaded('tools')
    const declaredTools = new Map(
      (
        params.tools as Array<{
          name: string
          parameters?: { required?: string[] }
        }>
      ).map((tool) => [tool.name, tool.parameters?.required ?? []])
    )

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {
        /* ignore ENOENT */
      }

      const history: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant with access to tools. Be brief.' }
      ]

      let firstCacheTokens = 0
      let secondCacheTokens = 0

      for (let i = 0; i < params.messages.length; i++) {
        history.push({ role: 'user', content: params.messages[i]! })

        const result = completion({
          modelId: toolsModelId,
          history: [...history],
          stream: true,
          kvCache: params.cacheKey,
          tools: params.tools as never,
          ...(params.generationParams && { generationParams: params.generationParams })
        })

        let response = ''
        for await (const token of result.tokenStream) {
          response += token
        }

        const toolCalls = result.toolCalls ? await result.toolCalls : []
        const declaredCall = toolCalls.find((call) => declaredTools.has(call.name))
        if (!declaredCall) {
          return {
            passed: false,
            output:
              `Tool completion ${i + 1} emitted no call matching a declared tool after ` +
              `${i === 0 ? 'cache creation' : 'model reload and cache reuse'}. ` +
              `Got: [${toolCalls.map((call) => call.name).join(', ')}]`
          }
        }

        const requiredArgs = declaredTools.get(declaredCall.name) ?? []
        const missingArgs = requiredArgs.filter((key) => !(key in declaredCall.arguments))
        if (missingArgs.length > 0) {
          return {
            passed: false,
            output:
              `Tool completion ${i + 1} call '${declaredCall.name}' is missing required ` +
              `arguments after ${i === 0 ? 'cache creation' : 'model reload and cache reuse'}: ` +
              `${missingArgs.join(', ')}`
          }
        }

        const stats = await result.stats
        const cacheTokens = ((stats as Record<string, unknown>)?.cacheTokens as number) ?? 0

        if (i === 0) {
          firstCacheTokens = cacheTokens
          history.push({ role: 'assistant', content: response })

          // Evict and reload the model to clear the in-memory KV cache.
          // Without this, the addon keeps the session in RAM and the second
          // call would see increased cacheTokens even if the disk save failed.
          await this.resources.evict('tools')
          toolsModelId = await this.resources.ensureLoaded('tools')
        } else {
          secondCacheTokens = cacheTokens
          history.push({ role: 'assistant', content: response })
        }
      }

      // After model reload, the only source of cached tokens is the on-disk
      // file. If the save was silently rejected (missing path) or not awaited,
      // secondCacheTokens will be ≤ firstCacheTokens (system-prompt-only).
      if (secondCacheTokens <= firstCacheTokens) {
        return {
          passed: false,
          output: `KV-cache not persisted to disk between tool-calling completions: second call cache tokens (${secondCacheTokens}) must exceed first call (${firstCacheTokens}). The cache save was likely silently rejected by the addon (missing cache path or unawaited response).`
        }
      }
      const result = `Tools sequential save: first=${firstCacheTokens}, second=${secondCacheTokens}, cache persisted to disk: true`
      return ValidationHelpers.validate(result, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Tools sequential save failed: ${errorMsg}` }
    }
  }
}
