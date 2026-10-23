import type { Step, TestDefinition } from '@qvac/test-suite'

const tools = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
]
const history = [{ role: 'system', content: 'Follow the user instructions. Be brief.' }]
const question = [...history, { role: 'user', content: 'Reply with only the word APPLE.' }]
const generationParams = { temp: 0, top_k: 1, seed: 42, predict: 128, reasoning_budget: 0 }

function reuseCase(
  name: string,
  kvCache: string | true,
  withTools: boolean,
  options: { reload?: boolean; dependency?: string; history?: typeof history } = {}
): TestDefinition {
  const { reload = false, dependency = 'prefill-llm', history: primeHistory = history } = options
  const params = {
    history: primeHistory,
    question: [...primeHistory, question[question.length - 1]!],
    tools: withTools ? tools : [],
    generationParams,
    kvCache,
    reload,
    dependency,
    stream: withTools
  }
  const run = (as: string, prime: boolean, cache: string | boolean): Step => ({
    call: {
      method: 'completion',
      collect: 'text',
      as,
      params: {
        modelId: '$model',
        history: prime ? '$params.history' : '$params.question',
        tools: '$params.tools',
        generationParams: '$params.generationParams',
        stream: '$params.stream',
        kvCache: cache,
        prefill: prime
      }
    }
  })
  const steps: Step[] = [
    { useModel: { deps: [dependency], as: 'model' } },
    {
      call: {
        method: 'deleteCache',
        params: typeof kvCache === 'string' ? { kvCacheKey: kvCache } : { auto: true }
      }
    },
    run('cold', false, false),
    run('prime', true, kvCache),
    { project: { from: '$prime', path: 'text', as: 'empty' } },
    { assert: { on: '$empty', named: 'isEmptyText' } },
    { project: { from: '$prime', path: 'toolCalls', as: 'calls' } },
    { assert: { on: '$calls', named: 'lengthIs', with: { length: 0 } } },
    { project: { from: '$prime', path: 'stats.generatedTokens', as: 'generated' } },
    { assert: { on: '$generated', named: 'valueIn', with: { values: [0] } } },
    ...(withTools
      ? ([
          { project: { from: '$prime', path: 'stats.toolDefinitionsDropped', as: 'dropped' } },
          { assert: { on: '$dropped', named: 'valueIn', with: { values: [0] } } }
        ] as Step[])
      : []),
    ...(reload
      ? ([
          { call: { method: 'evictResource', params: { dep: dependency } } },
          { useModel: { deps: [dependency], as: 'model' } }
        ] as Step[])
      : []),
    run('warm', false, kvCache),
    { project: { from: '$warm', path: 'text', as: 'answer' } },
    { assert: { on: '$answer', use: 'expectation' } },
    { project: { from: '$cold', path: 'stats.promptTokens', as: 'coldTokens' } },
    { project: { from: '$warm', path: 'stats.promptTokens', as: 'warmTokens' } },
    {
      compare: {
        left: '$coldTokens',
        right: '$warmTokens',
        named: 'prefillReuse',
        with: { primedTokens: '$prime.stats.cacheTokens' }
      }
    }
  ]
  return {
    testId: `kv-cache-prefill-${name}`,
    params,
    steps,
    expectation: { validation: 'contains-all', contains: ['APPLE'] },
    finally: [
      {
        call: {
          method: 'deleteCache',
          params: typeof kvCache === 'string' ? { kvCacheKey: kvCache } : { auto: true }
        }
      }
    ],
    metadata: { category: 'kv-cache', dependency, estimatedDurationMs: 60000 }
  }
}

const invalidCases = [
  {
    name: 'cache-required',
    params: { prefill: true, kvCache: false },
    error: 'prefill requires kvCache'
  },
  {
    name: 'forced-tool',
    params: {
      prefill: true,
      kvCache: 'invalid-prime',
      tools,
      generationParams: { tool_choice: 'required' }
    },
    error: 'prefill cannot be combined'
  }
].map(({ name, params, error }): TestDefinition => ({
  testId: `kv-cache-prefill-${name}`,
  params,
  expectation: { validation: 'throws-error', errorContains: error },
  steps: [
    {
      callError: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: 'prefill-validation',
          history,
          stream: false,
          ...params
        },
        as: 'error'
      }
    },
    { project: { from: '$error', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: { category: 'kv-cache', dependency: 'none', estimatedDurationMs: 5000 }
}))

export const kvCachePrefillTests = [
  reuseCase('named', 'prefill-named', true),
  reuseCase('auto', true, true, { dependency: 'prefill-llm-parallel' }),
  reuseCase('reload', 'prefill-reload', true, { reload: true }),
  reuseCase('tools-only', true, true, { history: [] }),
  reuseCase('system-only', 'prefill-system-only', false),
  ...invalidCases
]
