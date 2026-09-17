import { completion, deleteCache } from '@qvac/sdk'
import { type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from '../abstract-model-executor.js'
import { kvCacheRestartTests } from '../../../kv-cache-restart-tests.js'
import { callWhenAddonIdle } from '../../utils/addon-idle.js'
import { findBareChildren, waitForBareChildren } from '../../../utils/bare-worker.js'

interface ChatMessage {
  role: string
  content: string
}

interface TurnResult {
  text: string
  promptTokens?: number
}

/**
 * A named cache's saved-message boundary has to outlive the worker process.
 *
 * The restart is staged by unloading every model: off-Bare the last unload
 * closes the worker, and the next call spawns a new one. Both halves are
 * asserted against the process table rather than assumed, because if the
 * worker ever stopped closing, the boundary would still be in memory and the
 * token comparison below would pass without testing anything.
 */
export class KvCacheRestartExecutor extends AbstractModelExecutor<typeof kvCacheRestartTests> {
  pattern = /^worker-restart-/

  protected handlers = {
    'worker-restart-kv-cache-boundary': this.workerRestart.bind(this)
  } as never

  async workerRestart(
    params: {
      cacheKey: string
      messages: string[]
      expectedAnswerContains: string
      generationParams?: Record<string, unknown>
    },
    _expectation: Expectation
  ): Promise<TestResult> {
    const generationParams = params.generationParams as never
    const history: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]

    const turn = (modelId: string, turnHistory: ChatMessage[], kvCache: string | false) =>
      callWhenAddonIdle(async (): Promise<TurnResult> => {
        const run = completion({
          modelId,
          history: turnHistory,
          stream: true,
          kvCache: kvCache as never,
          generationParams
        })
        let text = ''
        for await (const token of run.tokenStream) text += token
        const stats = (await run.stats) as { promptTokens?: number } | undefined
        return { text, promptTokens: stats?.promptTokens }
      })

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey })
      } catch {
        /* fresh start */
      }

      const [firstMessage, ...laterMessages] = params.messages
      if (firstMessage === undefined || laterMessages.length === 0) {
        return { passed: false, output: 'Needs at least two messages to stage a restart' }
      }

      let modelId = await this.resources.ensureLoaded('llm')
      history.push({ role: 'user', content: firstMessage })
      const committed = await turn(modelId, [...history], params.cacheKey)
      history.push({ role: 'assistant', content: committed.text })

      const before = findBareChildren(process.pid)
      if (before.length !== 1) {
        return {
          passed: false,
          output: `Expected exactly one Bare worker before the restart, found ${before.length} (${before.join(', ')})`
        }
      }

      await this.resources.evictAll()
      const during = await waitForBareChildren(process.pid, (pids) => pids.length === 0)
      if (during.length !== 0) {
        return {
          passed: false,
          output:
            `Unloading every model left the worker running (pid ${during.join(', ')}), so the ` +
            `cache state was never lost and this test cannot prove the boundary was restored`
        }
      }

      modelId = await this.resources.ensureLoaded('llm')
      const after = await waitForBareChildren(process.pid, (pids) => pids.length === 1)
      if (after.length !== 1 || after[0] === before[0]) {
        return {
          passed: false,
          output: `Expected one new Bare worker after the reload, had ${before[0]} and now have ${after.join(', ') || 'none'}`
        }
      }

      let warm: TurnResult | null = null
      let lastHistory: ChatMessage[] = []
      for (const content of laterMessages) {
        history.push({ role: 'user', content })
        lastHistory = [...history]
        warm = await turn(modelId, lastHistory, params.cacheKey)
        history.push({ role: 'assistant', content: warm.text })
      }
      if (warm === null) {
        return { passed: false, output: 'No turn ran after the restart' }
      }

      const cold = await turn(modelId, lastHistory, false)

      const expected = params.expectedAnswerContains
      if (!warm.text.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output: `The turn after the restart did not include ${JSON.stringify(expected)}. Got: ${JSON.stringify(warm.text.slice(0, 200))}`
        }
      }
      if (typeof warm.promptTokens !== 'number' || typeof cold.promptTokens !== 'number') {
        return {
          passed: false,
          output: `promptTokens missing from stats (warm=${warm.promptTokens}, cold=${cold.promptTokens})`
        }
      }
      const summary = `worker ${before[0]} -> ${after[0]}, promptTokens: cold=${cold.promptTokens}, warm=${warm.promptTokens}`
      if (warm.promptTokens * 2 >= cold.promptTokens) {
        return {
          passed: false,
          output: `The saved-message boundary did not survive the restart: the next turn re-sent the history. ${summary}`
        }
      }
      return { passed: true, output: `Boundary restored on a fresh worker. ${summary}` }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Worker-restart cache test failed: ${errorMsg}` }
    }
  }
}
