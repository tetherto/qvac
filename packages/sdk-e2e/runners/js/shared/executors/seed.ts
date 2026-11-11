import { completion, deleteCache } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'
import type { ResourceManager } from '../resource-manager.js'

// Hand-written bodies for the seed tests on the React Native runner, which has
// no step bindings. Desktop runs the same definitions through their steps.

interface Message {
  role: string
  content: string
}

type GenerationParams = Parameters<typeof completion>[0]['generationParams']

interface SeedFromBaseParams {
  dependency: string
  baseKey: string
  chatKey: string
  coldKey: string
  history: Message[]
  question: Message[]
  generationParams?: GenerationParams
}

interface SeedRefusalParams {
  dependency: string
  history: Message[]
  kvCache: string | boolean
  seedFrom: string
  code: number
  generationParams?: GenerationParams
}

function errorCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: number }).code
    : undefined
}

export async function runSeedFromBase(
  resources: ResourceManager,
  params: SeedFromBaseParams,
  expectation: Expectation
): Promise<TestResult> {
  const keys = [params.baseKey, params.chatKey, params.coldKey]
  const cleanup = () => Promise.all(keys.map((kvCacheKey) => deleteCache({ kvCacheKey })))
  try {
    await cleanup()
    let modelId = await resources.ensureLoaded(params.dependency)
    const run = (
      history: Message[],
      cache: { kvCache: string; seedFrom?: string; prefill?: boolean }
    ) =>
      completion({
        modelId,
        history,
        stream: false,
        generationParams: params.generationParams,
        ...cache
      }).final
    const cold = await run(params.question, { kvCache: params.coldKey })
    const prime = await run(params.history, { kvCache: params.baseKey, prefill: true })
    // Reloading drops every slot, so the reuse has to come from the file `seedFrom` names.
    await resources.evict(params.dependency)
    modelId = await resources.ensureLoaded(params.dependency)
    const seeded = await run(params.question, { kvCache: params.chatKey, seedFrom: params.baseKey })
    const answer = ValidationHelpers.validate(seeded.contentText, expectation)
    if (!answer.passed) return answer
    const coldTokens = cold.stats?.promptTokens ?? NaN
    const warmTokens = seeded.stats?.promptTokens ?? NaN
    const primedTokens = prime.stats?.cacheTokens ?? NaN
    const reused = primedTokens > 0 && warmTokens > 0 && coldTokens - warmTokens === primedTokens
    return {
      passed: reused,
      output: `cold=${coldTokens}, warm=${warmTokens}, primed=${primedTokens}`
    }
  } catch (error) {
    return { passed: false, output: error instanceof Error ? error.message : String(error) }
  } finally {
    await cleanup()
  }
}

export async function runSeedRefusal(
  resources: ResourceManager,
  params: SeedRefusalParams
): Promise<TestResult> {
  const modelId = await resources.ensureLoaded(params.dependency)
  try {
    await completion({
      modelId,
      history: params.history,
      stream: false,
      generationParams: params.generationParams,
      kvCache: params.kvCache,
      seedFrom: params.seedFrom
    }).final
    return { passed: false, output: `expected error ${params.code}, the completion succeeded` }
  } catch (error) {
    const code = errorCode(error)
    const message = error instanceof Error ? error.message : String(error)
    if (code === params.code) return { passed: true, output: message }
    return { passed: false, output: `expected error ${params.code}, got ${code}: ${message}` }
  }
}
