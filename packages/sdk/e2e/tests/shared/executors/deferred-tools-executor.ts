import { TOOL_SEARCH_NAME, completion, deleteCache, executeToolSearch } from '@qvac/sdk'
import type { ToolDialect } from '@qvac/sdk'
import type { TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  DEFERRED_TOOL_INVENTORY,
  deferredToolsTests,
  type DeferredToolDef,
  type DeferredToolsParams
} from '../../deferred-tools-tests.js'

interface ChatMessage {
  role: string
  content: string
}

interface ToolCallLike {
  name?: string
  arguments?: Record<string, unknown>
}

interface SearchEnvelope {
  tool_search: { loaded: string[]; already_loaded: string[] }
  tools: Array<{ name: string }>
}

const DETERMINISTIC = { temp: 0, seed: 42 }

// The assistant turn that issued the search, in the model's own call syntax,
// so the history reads the way a real search round leaves it.
function searchCallText(query: string, dialect: ToolDialect | undefined): string {
  if (dialect === 'qwen35') {
    return (
      `<tool_call>\n<function=${TOOL_SEARCH_NAME}>\n<parameter=query>\n${query}\n` +
      '</parameter>\n</function>\n</tool_call>'
    )
  }
  return `<tool_call>\n${JSON.stringify({ name: TOOL_SEARCH_NAME, arguments: { query } })}\n</tool_call>`
}

function withEmptySchemas(tools: DeferredToolDef[]): DeferredToolDef[] {
  return tools.map((tool) =>
    tool.deferLoading ? { ...tool, parameters: { type: 'object', properties: {} } } : tool
  )
}

function withoutDeferral(tools: DeferredToolDef[]): DeferredToolDef[] {
  return tools.map(({ deferLoading: _deferLoading, group: _group, ...tool }) => tool)
}

function describeCalls(calls: ToolCallLike[]): string {
  return calls
    .map((c) => `${c.name ?? '<unnamed>'}(${JSON.stringify(c.arguments ?? {})})`)
    .join(', ')
}

function checkExpectedCall(
  calls: ToolCallLike[],
  expected: DeferredToolsParams['expectedToolCall']
): TestResult {
  const match = calls.find((c) => c.name === expected.name)
  if (!match) {
    return {
      passed: false,
      output: `Expected a call to '${expected.name}'. Got: [${describeCalls(calls)}]`
    }
  }
  const args = match.arguments ?? {}
  const missing = (expected.argKeys ?? []).filter((key) => !(key in args))
  if (missing.length > 0) {
    return {
      passed: false,
      output: `Call to '${expected.name}' is missing argument(s) ${missing.join(', ')}. Got: ${JSON.stringify(args)}`
    }
  }
  return { passed: true, output: `Tool call: ${describeCalls([match])}` }
}

function errorResult(label: string, error: unknown): TestResult {
  const message = error instanceof Error ? error.message : String(error)
  return { passed: false, output: `${label} failed: ${message}` }
}

export class DeferredToolsExecutor extends AbstractModelExecutor<typeof deferredToolsTests> {
  pattern = /^deferred-tools-/

  private readonly byTestId: Record<string, (params: unknown) => Promise<TestResult>> = {
    'deferred-tools-prompt-cost': this.promptCost.bind(this),
    'deferred-tools-search-then-call': this.searchThenCall.bind(this),
    'deferred-tools-repeat-search': this.repeatSearch.bind(this),
    'deferred-tools-reopened-chat': this.reopenedChat.bind(this),
    'deferred-tools-kv-cache-isolation': this.kvCacheIsolation.bind(this)
  }

  protected handlers = Object.fromEntries(
    deferredToolsTests.map((test) => [
      test.testId,
      this.byTestId[test.testId] ?? this.loadThenCall.bind(this)
    ])
  ) as never

  private async run(
    modelId: string,
    history: ChatMessage[],
    p: DeferredToolsParams,
    options: { tools?: DeferredToolDef[]; kvCache?: string; predict?: number } = {}
  ) {
    const result = completion({
      modelId,
      history,
      tools: (options.tools ?? DEFERRED_TOOL_INVENTORY) as never,
      stream: false,
      generationParams: {
        ...DETERMINISTIC,
        ...(options.predict !== undefined && { predict: options.predict })
      },
      ...(options.kvCache && { kvCache: options.kvCache }),
      ...(p.toolDialect && { toolDialect: p.toolDialect })
    })
    const text = await result.text
    const toolCalls = ((await result.toolCalls) ?? []) as ToolCallLike[]
    const stats = (await result.stats) as { promptTokens?: number } | undefined
    const final = (await result.final) as { raw?: { fullText?: string } }
    return {
      text,
      rawText: final.raw?.fullText ?? text,
      toolCalls,
      promptTokens: stats?.promptTokens
    }
  }

  private baseHistory(p: DeferredToolsParams): ChatMessage[] {
    return [
      { role: 'system', content: p.systemPrompt },
      { role: 'user', content: p.userPrompt }
    ]
  }

  // History after one search round: the assistant's search call and its result.
  private withSearch(history: ChatMessage[], p: DeferredToolsParams, query: string): ChatMessage[] {
    const searched = [
      ...history,
      { role: 'assistant', content: searchCallText(query, p.toolDialect) }
    ]
    return [
      ...searched,
      {
        role: 'tool',
        content: executeToolSearch(DEFERRED_TOOL_INVENTORY as never, { query }, searched)
      }
    ]
  }

  private async resetCache(key: string): Promise<void> {
    try {
      await deleteCache({ kvCacheKey: key })
    } catch {
      /* fresh start */
    }
  }

  async promptCost(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const modelId = await this.resources.ensureLoaded(p.resourceKey ?? 'tools')
    const history = this.baseHistory(p)

    try {
      const deferred = await this.run(modelId, history, p, { predict: 1 })
      const emptySchemas = await this.run(modelId, history, p, {
        predict: 1,
        tools: withEmptySchemas(DEFERRED_TOOL_INVENTORY)
      })
      const eager = await this.run(modelId, history, p, {
        predict: 1,
        tools: withoutDeferral(DEFERRED_TOOL_INVENTORY)
      })

      const counts = [deferred.promptTokens, emptySchemas.promptTokens, eager.promptTokens]
      const summary = `promptTokens: deferred=${counts[0]}, deferred with empty schemas=${counts[1]}, eager=${counts[2]}`
      if (counts.some((n) => typeof n !== 'number')) {
        return { passed: false, output: `promptTokens missing from stats. ${summary}` }
      }
      if (deferred.promptTokens !== emptySchemas.promptTokens) {
        return {
          passed: false,
          output: `Deferred parameter schemas reached the prompt: emptying them changed the token count. ${summary}`
        }
      }
      if (!(deferred.promptTokens! < eager.promptTokens!)) {
        return {
          passed: false,
          output: `Deferring tools did not shrink the prompt. ${summary}`
        }
      }
      return { passed: true, output: summary }
    } catch (error) {
      return errorResult('Deferred tools prompt cost', error)
    }
  }

  async loadThenCall(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const modelId = await this.resources.ensureLoaded(p.resourceKey ?? 'tools')

    try {
      const history = this.withSearch(this.baseHistory(p), p, p.searchQuery!)
      const { toolCalls } = await this.run(modelId, history, p)
      return checkExpectedCall(toolCalls, p.expectedToolCall)
    } catch (error) {
      return errorResult('Deferred tools load then call', error)
    }
  }

  async searchThenCall(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const modelId = await this.resources.ensureLoaded(p.resourceKey ?? 'tools')

    try {
      const history = this.baseHistory(p)
      const first = await this.run(modelId, history, p)
      if (first.toolCalls.some((c) => c.name === p.expectedToolCall.name)) {
        return {
          passed: false,
          output: `'${p.expectedToolCall.name}' was callable before it was loaded. Got: [${describeCalls(first.toolCalls)}]`
        }
      }
      const search = first.toolCalls.find((c) => c.name === TOOL_SEARCH_NAME)
      if (!search) {
        return {
          passed: false,
          output: `Expected a ${TOOL_SEARCH_NAME} call on the first step. Got: [${describeCalls(first.toolCalls)}] text: ${first.text.slice(0, 200)}`
        }
      }

      const searched = [...history, { role: 'assistant', content: first.rawText }]
      const loaded = [
        ...searched,
        {
          role: 'tool',
          content: executeToolSearch(
            DEFERRED_TOOL_INVENTORY as never,
            search.arguments ?? {},
            searched
          )
        }
      ]
      const second = await this.run(modelId, loaded, p)
      const result = checkExpectedCall(second.toolCalls, p.expectedToolCall)
      return result.passed
        ? { passed: true, output: `Searched ${JSON.stringify(search.arguments)}; ${result.output}` }
        : result
    } catch (error) {
      return errorResult('Deferred tools search then call', error)
    }
  }

  async repeatSearch(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const modelId = await this.resources.ensureLoaded(p.resourceKey ?? 'tools')

    try {
      const once = this.withSearch(this.baseHistory(p), p, p.searchQuery!)
      const twice = this.withSearch(once, p, p.searchQuery!)
      const repeat = JSON.parse(twice[twice.length - 1]!.content) as SearchEnvelope

      // Other tools matching the query may load fresh; only the loaded one must not repeat.
      const name = p.expectedToolCall.name
      if (repeat.tools.some((t) => t.name === name) || repeat.tool_search.loaded.includes(name)) {
        return {
          passed: false,
          output: `Second search appended '${name}' again: ${JSON.stringify(repeat.tool_search)}`
        }
      }
      if (!repeat.tool_search.already_loaded.includes(p.expectedToolCall.name)) {
        return {
          passed: false,
          output: `Second search did not report '${p.expectedToolCall.name}' as already loaded: ${JSON.stringify(repeat.tool_search)}`
        }
      }

      const { toolCalls } = await this.run(modelId, twice, p)
      return checkExpectedCall(toolCalls, p.expectedToolCall)
    } catch (error) {
      return errorResult('Deferred tools repeat search', error)
    }
  }

  async reopenedChat(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const resourceKey = p.resourceKey ?? 'tools'
    const cacheKey = 'deferred-tools-reopened-chat'
    const history = this.withSearch(this.baseHistory(p), p, p.searchQuery!)

    try {
      await this.resetCache(cacheKey)
      const before = await this.run(await this.resources.ensureLoaded(resourceKey), history, p, {
        kvCache: cacheKey
      })
      const beforeResult = checkExpectedCall(before.toolCalls, p.expectedToolCall)
      if (!beforeResult.passed) {
        return { ...beforeResult, output: `Before reload: ${beforeResult.output}` }
      }

      await this.resources.evict(resourceKey)
      const after = await this.run(await this.resources.ensureLoaded(resourceKey), history, p, {
        kvCache: cacheKey
      })
      const afterResult = checkExpectedCall(after.toolCalls, p.expectedToolCall)
      return afterResult.passed
        ? { passed: true, output: `Loaded tool still callable after reload. ${afterResult.output}` }
        : { ...afterResult, output: `After reload: ${afterResult.output}` }
    } catch (error) {
      return errorResult('Deferred tools reopened chat', error)
    } finally {
      await this.resetCache(cacheKey)
    }
  }

  async kvCacheIsolation(params: unknown): Promise<TestResult> {
    const p = params as DeferredToolsParams
    const modelId = await this.resources.ensureLoaded(p.resourceKey ?? 'tools')
    const loadedKey = 'deferred-tools-isolation-loaded'
    const freshKey = 'deferred-tools-isolation-fresh'

    try {
      await this.resetCache(loadedKey)
      await this.resetCache(freshKey)

      const loadedHistory = this.withSearch(this.baseHistory(p), p, p.searchQuery!)
      const freshHistory = this.baseHistory(p)
      const [loaded, fresh] = await Promise.all([
        this.run(modelId, loadedHistory, p, { kvCache: loadedKey }),
        this.run(modelId, freshHistory, p, { kvCache: freshKey })
      ])

      const loadedResult = checkExpectedCall(loaded.toolCalls, p.expectedToolCall)
      if (!loadedResult.passed) {
        return { ...loadedResult, output: `Chat with the tool loaded: ${loadedResult.output}` }
      }
      if (fresh.toolCalls.some((c) => c.name === p.expectedToolCall.name)) {
        return {
          passed: false,
          output: `'${p.expectedToolCall.name}' leaked into a chat that never loaded it. Got: [${describeCalls(fresh.toolCalls)}]`
        }
      }
      return {
        passed: true,
        output: `Loaded chat: ${describeCalls(loaded.toolCalls)}; fresh chat: [${describeCalls(fresh.toolCalls)}]`
      }
    } catch (error) {
      return errorResult('Deferred tools kvCache isolation', error)
    } finally {
      await this.resetCache(loadedKey)
      await this.resetCache(freshKey)
    }
  }
}
