import { completion, deleteCache } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'
import type { ResourceManager } from '../resource-manager.js'

interface PrefillParams {
  history?: { role: string; content: string }[]
  question?: { role: string; content: string }[]
  tools?: Parameters<typeof completion>[0]['tools']
  generationParams?: Parameters<typeof completion>[0]['generationParams']
  kvCache: string | boolean
  reload?: boolean
  dependency?: string
  stream?: boolean
  prefill?: boolean
}

export async function runPrefill(
  resources: ResourceManager,
  params: PrefillParams,
  expectation: Expectation
): Promise<TestResult> {
  const cleanup = () =>
    deleteCache(
      typeof params.kvCache === 'string' ? { kvCacheKey: params.kvCache } : { auto: true }
    )
  try {
    if (expectation.validation === 'throws-error') {
      await completion({ ...params, modelId: 'prefill-validation', history: [], stream: false })
        .final
      return { passed: false, output: 'Expected prefill validation to reject' }
    }
    await cleanup()
    const dependency = params.dependency ?? 'prefill-llm'
    let modelId = await resources.ensureLoaded(dependency)
    const run = (history: PrefillParams['history'], kvCache: string | boolean, prefill = false) =>
      completion({
        modelId,
        history: history ?? [],
        tools: params.tools,
        generationParams: params.generationParams,
        stream: params.stream ?? true,
        kvCache,
        prefill
      }).final
    const cold = await run(params.question, false)
    const prime = await run(params.history, params.kvCache, true)
    if (
      prime.contentText ||
      prime.thinkingText ||
      prime.toolCalls.length ||
      prime.stats?.generatedTokens !== 0 ||
      ((params.tools?.length ?? 0) > 0 && prime.stats?.toolDefinitionsDropped !== 0)
    ) {
      return { passed: false, output: `Invalid priming result: ${JSON.stringify(prime)}` }
    }
    if (params.reload) {
      await resources.evict(dependency)
      modelId = await resources.ensureLoaded(dependency)
    }
    const warm = await run(params.question, params.kvCache)
    const coldTokens = cold.stats?.promptTokens ?? NaN
    const warmTokens = warm.stats?.promptTokens ?? NaN
    const primedTokens = prime.stats?.cacheTokens ?? NaN
    if (!(primedTokens > 0 && warmTokens > 0 && coldTokens - warmTokens === primedTokens)) {
      return {
        passed: false,
        output: `cold=${coldTokens}, warm=${warmTokens}, primed=${primedTokens}`
      }
    }
    return ValidationHelpers.validate(warm.contentText, expectation)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (expectation.validation === 'throws-error') {
      return { passed: message.includes(expectation.errorContains), output: message }
    }
    return { passed: false, output: message }
  } finally {
    if (expectation.validation !== 'throws-error') await cleanup()
  }
}
