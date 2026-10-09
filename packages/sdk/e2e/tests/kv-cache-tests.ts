import type { Step, TestDefinition } from '@qvac/test-suite'

/** Deleting a cache: by key, by key and model, or the whole cache root. */
const deleteCacheSteps = (): Step[] => [
  {
    call: {
      method: 'deleteCache',
      params: {
        all: '$params.deleteAll?',
        kvCacheKey: '$params.kvCacheKey?',
        modelId: '$params.modelIdToDelete?'
      },
      as: 'result'
    }
  },
  { project: { from: '$result', path: 'success', as: 'success' } },
  { assert: { on: '$success', named: 'isTrue' } }
]

/** One completion that reuses a named cache. */
const kvCompletionSteps = (): Step[] => [
  { useModel: { deps: ['llm'], as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        stream: '$params.stream?',
        kvCache: '$params.kvCache?',
        tools: '$params.tools?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

/**
 * One tool-calling turn over the named cache, leaving its text, its tool call and its cached-token
 * count bound. The tool set, the generation params and the expected call come from the test's
 * params unless the turn names its own.
 */
const toolTurn = (
  history: unknown,
  as: string,
  turn: {
    tools?: string
    generationParams?: string
    declared?: string[]
    expectedTool?: string
    requiredArgs?: string
  } = {}
): Step[] => {
  const expectedTool = turn.expectedTool ?? '$params.declaredTool'
  return [
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history,
          stream: '$params.stream',
          kvCache: '$params.cacheKey',
          tools: turn.tools ?? '$params.tools',
          generationParams: turn.generationParams ?? '$params.generationParams'
        },
        as: `${as}Turn`
      }
    },
    { project: { from: `$${as}Turn`, path: 'text', as: `${as}Text` } },
    { project: { from: `$${as}Turn`, path: 'toolCalls', as: `${as}Calls` } },
    {
      assert: {
        on: `$${as}Calls`,
        named: 'toolCallShape',
        with: {
          declared: turn.declared ?? [expectedTool],
          name: expectedTool,
          argKeys: turn.requiredArgs ?? '$params.requiredArgs'
        }
      }
    },
    { project: { from: `$${as}Turn`, path: 'stats.cacheTokens', as: `${as}CacheTokens` } }
  ]
}

/**
 * The two cancellation tests below stay on their executor for the same reason `finetune-pause-
 * resume` does: they cancel after a given number of tokens has arrived, which means deciding inside
 * the stream.
 */
const KV_CACHE_MULTI_RUN = new Set([
  'kv-cache-cancel-then-new-prompt',
  'kv-cache-cancel-keeps-committed-cache',
  'kv-cache-concurrent-same-key',
  'kv-cache-concurrent-same-key-auto',
  'kv-cache-auto-concurrency'
])

export const kvCacheDeleteAll: TestDefinition = {
  testId: 'kv-cache-delete-all',
  params: { deleteAll: true },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'none', estimatedDurationMs: 10000 }
}

export const kvCacheDeleteByKey: TestDefinition = {
  testId: 'kv-cache-delete-by-key',
  params: { kvCacheKey: 'test-session-cache' },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'none', estimatedDurationMs: 5000 }
}

export const kvCacheDeleteByModel: TestDefinition = {
  testId: 'kv-cache-delete-by-model',
  params: { kvCacheKey: 'test-session', modelIdToDelete: 'specific-model-id' },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'none', estimatedDurationMs: 5000 }
}

export const kvCacheHypercoreDeletion: TestDefinition = {
  testId: 'kv-cache-hypercore-deletion',
  params: { kvCacheKey: 'test-hypercore-delete' },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'none', estimatedDurationMs: 5000 }
}

function buildKvConversation(
  turns: number,
  filler: string
): Array<{ role: string; content: string }> {
  const history: Array<{ role: string; content: string }> = []
  for (let i = 1; i <= turns; i++) {
    history.push({ role: 'user', content: `Turn ${i}: ${filler}` })
    history.push({ role: 'assistant', content: `Acknowledged turn ${i}. ${filler}` })
  }
  return history
}

export const kvCacheSlidingWindow: TestDefinition = {
  testId: 'kv-cache-sliding-window',
  params: {
    history: [
      ...buildKvConversation(
        15,
        'Testing KV cache sliding window. The quick brown fox jumps over the lazy dog.'
      ),
      { role: 'user', content: 'What is 2+2? Answer with just the number.' }
    ],
    stream: false,
    kvCache: 'test-sliding-window-session'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 30000 }
}

export const kvCacheBooleanEnabled: TestDefinition = {
  testId: 'kv-cache-boolean-enabled',
  params: {
    history: [
      ...buildKvConversation(12, 'Testing kvCache with boolean true. The quick brown fox jumps.'),
      { role: 'user', content: 'What is 3+3? Answer with just the number.' }
    ],
    stream: false,
    kvCache: true
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 25000 }
}

export const kvCacheSequentialCalls: TestDefinition = {
  testId: 'kv-cache-sequential-calls',
  params: {
    history: [
      ...buildKvConversation(
        10,
        'Testing cache reuse across multiple completion calls. Lorem ipsum dolor sit amet.'
      ),
      { role: 'user', content: 'What is 5+5? Answer with just the number.' }
    ],
    stream: false,
    kvCache: 'sequential-test-session'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 20000 }
}

export const kvCacheStreamingSlidingWindow: TestDefinition = {
  testId: 'kv-cache-streaming-sliding-window',
  params: {
    history: [
      ...buildKvConversation(15, 'Verifying kvCache works with stream: true. The lazy dog sleeps.'),
      { role: 'user', content: 'What is 7+7? Answer with just the number.' }
    ],
    stream: true,
    kvCache: 'streaming-sliding-window-session'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 35000 }
}

export const kvCacheLongSingleMessage: TestDefinition = {
  testId: 'kv-cache-long-single-message',
  params: {
    history: [
      {
        role: 'user',
        content:
          'This is a test of the KV cache sliding window with a very long single message. '.repeat(
            40
          ) + 'After all this text, what is 4+4? Answer with just the number.'
      }
    ],
    stream: false,
    kvCache: 'long-single-message-session'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 25000 }
}

/** Three turns over two cache keys, returning to the first. */
export const kvCacheSessionSwitch: TestDefinition = {
  testId: 'kv-cache-session-switch',
  params: {
    sessions: [
      { key: 'session-switch-a', message: 'What is 1+1?' },
      { key: 'session-switch-b', message: 'What is 2+2?' },
      { key: 'session-switch-a', message: 'What is 3+3?' }
    ],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      repeat: {
        over: '$params.sessions',
        as: 'session',
        collectInto: 'texts',
        steps: [
          {
            call: {
              method: 'completion',
              collect: 'text',
              params: {
                modelId: '$model',
                history: [
                  { role: 'system', content: 'You are a helpful math assistant. Be brief.' },
                  { role: 'user', content: '$session.message' }
                ],
                stream: '$params.stream',
                kvCache: '$session.key'
              },
              as: 'run'
            }
          },
          { project: { from: '$run', path: 'text', as: 'text' } },
          { assert: { on: '$text', named: 'nonEmptyText' } }
        ]
      }
    },
    { assert: { on: '$texts', named: 'lengthIs', with: { length: 3 } } }
  ],
  finally: [
    { call: { method: 'deleteCache', params: { kvCacheKey: 'session-switch-a' } } },
    { call: { method: 'deleteCache', params: { kvCacheKey: 'session-switch-b' } } }
  ],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 45000 }
}

/** The same cache key, reused under two different system prompts. */
export const kvCacheDifferentSystemPrompts: TestDefinition = {
  testId: 'kv-cache-different-system-prompts',
  params: {
    cacheKey: 'system-prompt-test-session',
    systemPrompts: ['You are a helpful math tutor.', 'You are a creative storyteller.'],
    userMessage: 'Hello!',
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      repeat: {
        over: '$params.systemPrompts',
        as: 'systemPrompt',
        collectInto: 'texts',
        steps: [
          {
            call: {
              method: 'completion',
              collect: 'text',
              params: {
                modelId: '$model',
                history: [
                  { role: 'system', content: '$systemPrompt' },
                  { role: 'user', content: '$params.userMessage' }
                ],
                stream: '$params.stream',
                kvCache: '$params.cacheKey'
              },
              as: 'run'
            }
          },
          { project: { from: '$run', path: 'text', as: 'text' } },
          { assert: { on: '$text', named: 'nonEmptyText' } }
        ]
      }
    },
    { assert: { on: '$texts', named: 'lengthIs', with: { length: 2 } } }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 30000 }
}

export const kvCacheWithTools: TestDefinition = {
  testId: 'kv-cache-with-tools',
  params: {
    history: [
      { role: 'system', content: 'You are a helpful assistant with access to tools.' },
      { role: 'user', content: 'What is 10 + 20?' }
    ],
    stream: false,
    kvCache: 'tools-cache-session',
    tools: [
      {
        type: 'function',
        name: 'calculator',
        description: 'Performs basic math operations',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['operation', 'a', 'b']
        }
      }
    ]
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 30000 }
}

/** A cache deleted mid-flight, then used again under the same name. */
export const kvCacheDeleteAndReuse: TestDefinition = {
  testId: 'kv-cache-delete-and-reuse',
  params: {
    cacheKey: 'delete-reuse-test-session',
    history: [{ role: 'user', content: 'What is 5+5? Answer with just the number.' }],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: '$params.history',
          stream: '$params.stream',
          kvCache: '$params.cacheKey'
        },
        as: 'firstRun'
      }
    },
    { project: { from: '$firstRun', path: 'text', as: 'firstText' } },
    { assert: { on: '$firstText', named: 'nonEmptyText' } },
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } },
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: '$params.history',
          stream: '$params.stream',
          kvCache: '$params.cacheKey'
        },
        as: 'secondRun'
      }
    },
    { project: { from: '$secondRun', path: 'text', as: 'secondText' } },
    { assert: { on: '$secondText', named: 'nonEmptyText' } }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 35000 }
}

/**
 * Two turns over one cache, and the second one has to say it reused it.
 *
 * `cacheTokens` is the evidence. Both turns are written out rather than
 * looped, because the second turn's history contains the first turn's answer
 * -- which is the whole reason there is a prefix to reuse.
 */
export const kvCacheStatsVerification: TestDefinition = {
  testId: 'kv-cache-stats-verification',
  params: {
    cacheKey: 'stats-verification-session',
    messages: ['First message to warm up cache.', 'Second message should show cache tokens.'],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } },
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [
            { role: 'system', content: 'You are a helpful assistant. Be brief.' },
            { role: 'user', content: '$params.messages[0]' }
          ],
          stream: true,
          kvCache: '$params.cacheKey'
        },
        as: 'firstTurn'
      }
    },
    { project: { from: '$firstTurn', path: 'text', as: 'firstText' } },
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [
            { role: 'system', content: 'You are a helpful assistant. Be brief.' },
            { role: 'user', content: '$params.messages[0]' },
            { role: 'assistant', content: '$firstText' },
            { role: 'user', content: '$params.messages[1]' }
          ],
          stream: true,
          kvCache: '$params.cacheKey'
        },
        as: 'secondTurn'
      }
    },
    { project: { from: '$secondTurn', path: 'stats.cacheTokens', as: 'cacheTokens' } },
    { assert: { on: '$cacheTokens', named: 'atLeast', with: { value: 1 } } }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 90000 }
}

export const kvCacheNoSystemPrompt: TestDefinition = {
  testId: 'kv-cache-no-system-prompt',
  params: {
    history: [{ role: 'user', content: 'What is 6+6? Answer with just the number.' }],
    stream: false,
    kvCache: 'no-system-prompt-session'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 20000 }
}

/** Two tool-calling turns with a model reload in between. */
export const kvCacheToolsSequentialSave: TestDefinition = {
  testId: 'kv-cache-tools-sequential-save',
  params: {
    cacheKey: 'tools-sequential-save-session',
    tools: [
      {
        type: 'function',
        name: 'calculator',
        description: 'Performs basic math operations',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['operation', 'a', 'b']
        }
      }
    ],
    messages: ['What is 10 + 20?', 'Now what is 5 + 5?'],
    stream: true,
    generationParams: { temp: 0, top_k: 1, seed: 42 },
    declaredTool: 'calculator',
    requiredArgs: ['operation', 'a', 'b']
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } },
    { useModel: { deps: ['tools'], as: 'model' } },
    ...toolTurn([{ role: 'user', content: '$params.messages[0]' }], 'first'),
    // Evict and reload to clear the in-memory cache. Without this the addon keeps the session in
    // RAM and the second turn would report more cached tokens even if the disk save never happened.
    { call: { method: 'evictResource', params: { dep: 'tools' } } },
    { useModel: { deps: ['tools'], as: 'model' } },
    ...toolTurn(
      [
        { role: 'user', content: '$params.messages[0]' },
        { role: 'assistant', content: '$firstText' },
        { role: 'user', content: '$params.messages[1]' }
      ],
      'second'
    ),
    {
      compare: {
        left: '$secondCacheTokens',
        right: '$firstCacheTokens',
        named: 'greaterThan'
      }
    }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  metadata: { category: 'kv-cache', dependency: 'tools', estimatedDurationMs: 90000 }
}

const CALCULATOR_TOOL = {
  type: 'function',
  name: 'calculator',
  description: 'Performs basic math operations',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
      a: { type: 'number' },
      b: { type: 'number' }
    },
    required: ['operation', 'a', 'b']
  }
}

const WEATHER_TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Returns the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city']
  }
}

/**
 * A tool set that changes between turns on one named key. The turn after the change reuses the
 * same cache file up to where the prompts differ, and the turn after that is warm again under the
 * new set.
 */
export const kvCacheToolSetChange: TestDefinition = {
  testId: 'kv-cache-tool-set-change',
  params: {
    cacheKey: 'tool-set-change-session',
    tools: [CALCULATOR_TOOL],
    changedTools: [CALCULATOR_TOOL, WEATHER_TOOL],
    messages: ['What is 10 + 20?', 'What is the weather in Paris?', 'Now what is 5 + 5?'],
    stream: true,
    generationParams: { temp: 0, top_k: 1, seed: 42 },
    declaredTool: 'calculator',
    requiredArgs: ['operation', 'a', 'b'],
    addedTool: 'get_weather',
    addedToolArgs: ['city']
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } },
    { useModel: { deps: ['tools'], as: 'model' } },
    ...toolTurn([{ role: 'user', content: '$params.messages[0]' }], 'first'),
    ...toolTurn(
      [
        { role: 'user', content: '$params.messages[0]' },
        { role: 'assistant', content: '$firstText' },
        { role: 'user', content: '$params.messages[1]' }
      ],
      'second',
      {
        tools: '$params.changedTools',
        declared: ['$params.declaredTool', '$params.addedTool'],
        expectedTool: '$params.addedTool',
        requiredArgs: '$params.addedToolArgs'
      }
    ),
    // The same file served the changed set: a fresh one would report no cached tokens.
    { assert: { on: '$secondCacheTokens', named: 'atLeast', with: { value: 1 } } },
    ...toolTurn(
      [
        { role: 'user', content: '$params.messages[0]' },
        { role: 'assistant', content: '$firstText' },
        { role: 'user', content: '$params.messages[1]' },
        { role: 'assistant', content: '$secondText' },
        { role: 'user', content: '$params.messages[2]' }
      ],
      'third',
      { tools: '$params.changedTools', declared: ['$params.declaredTool', '$params.addedTool'] }
    ),
    { compare: { left: '$thirdCacheTokens', right: '$secondCacheTokens', named: 'greaterThan' } }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  metadata: { category: 'kv-cache', dependency: 'tools', estimatedDurationMs: 120000 }
}

/**
 * `tool_choice: 'required'` on a warm turn forces a call: the grammar is armed from the tool block
 * every turn carries, so a prompt that would otherwise be answered in prose calls the tool.
 */
export const kvCacheWarmToolChoiceRequired: TestDefinition = {
  testId: 'kv-cache-warm-tool-choice-required',
  params: {
    cacheKey: 'warm-tool-choice-required-session',
    tools: [CALCULATOR_TOOL],
    messages: ['What is 10 + 20?', 'Say hello.'],
    stream: true,
    generationParams: { temp: 0, top_k: 1, seed: 42 },
    requiredGenerationParams: { temp: 0, top_k: 1, seed: 42, tool_choice: 'required' },
    declaredTool: 'calculator',
    requiredArgs: ['operation', 'a', 'b']
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } },
    { useModel: { deps: ['tools'], as: 'model' } },
    ...toolTurn([{ role: 'user', content: '$params.messages[0]' }], 'first'),
    ...toolTurn(
      [
        { role: 'user', content: '$params.messages[0]' },
        { role: 'assistant', content: '$firstText' },
        { role: 'user', content: '$params.messages[1]' }
      ],
      'second',
      { generationParams: '$params.requiredGenerationParams' }
    ),
    { assert: { on: '$secondCacheTokens', named: 'atLeast', with: { value: 1 } } }
  ],
  finally: [{ call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKey' } } }],
  metadata: { category: 'kv-cache', dependency: 'tools', estimatedDurationMs: 90000 }
}

export const kvCacheCancelThenNewPrompt: TestDefinition = {
  testId: 'kv-cache-cancel-then-new-prompt',
  params: {
    cacheKey: 'qvac-17780-cancel-regression',
    firstUserMessage: 'Tell me a long story about dragons.',
    secondUserMessage: 'What is 2+2? Answer with just the number.',
    expectedAnswerContains: '4',
    cancelAfterTokens: 3,
    generationParams: { temp: 0, top_k: 1, seed: 42 }
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'kv-cache',
    dependency: 'llm',
    estimatedDurationMs: 30000
  }
}

// Two completions sharing one kvCache key are fired at once on a parallel:4
// model. They must serialize — the per-cache-path lock in the KV-cache session
// makes the second wait for the first to commit, so their decode intervals
// never overlap even though the model is otherwise concurrent (proven by
// completion-concurrent-overlap on the same resource). Both must still succeed.
// No declarative body here or below: overlap is measured from per-token timestamps, which steps
// cannot capture.
export const kvCacheConcurrentSameKey: TestDefinition = {
  testId: 'kv-cache-concurrent-same-key',
  params: {
    history: [
      { role: 'system', content: 'You are a helpful assistant. Be brief.' },
      { role: 'user', content: 'Count from one to twenty using words.' }
    ],
    kvCache: 'concurrent-same-key-session',
    generationParams: { temp: 0, seed: 42, predict: 64 }
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm-batch', estimatedDurationMs: 30000 }
}

// Same serialization guarantee for the automatic (history-derived) cache path:
// two kvCache:true completions with identical history resolve to one cache file
// and must serialize on the per-cache-path lock — which, for the auto path, is
// acquired outside the global cache-state lock so the auto-rename commit can't
// deadlock against it. Both must succeed; their decode intervals must not overlap.
export const kvCacheConcurrentSameKeyAuto: TestDefinition = {
  testId: 'kv-cache-concurrent-same-key-auto',
  params: {
    history: [
      { role: 'system', content: 'You are a helpful assistant. Be brief.' },
      { role: 'user', content: 'Count from one to twenty using words.' }
    ],
    kvCache: true,
    generationParams: { temp: 0, seed: 42, predict: 64 }
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm-batch', estimatedDurationMs: 30000 }
}

// Different-history auto turns decode concurrently — with each other and with
// plain completions. The regression guard for auto-cache serialization and slot
// starvation: a cached-only phase proves native cached-vs-cached concurrency,
// then a mixed phase proves plain completions aren't starved behind cached ones.
// No declarative body: concurrency is measured from per-token windows across the streams.
export const kvCacheAutoConcurrency: TestDefinition = {
  testId: 'kv-cache-auto-concurrency',
  params: { generationParams: { temp: 0, seed: 42, predict: 48 } },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm-batch', estimatedDurationMs: 60000 }
}

// A cancelled follow-up turn must not cost the session its committed cache.
// The addon keeps what a cancel after prefill decoded, the engine keeps the
// file, and the next turn reconciles its full history against it, so it stays
// warm. Proven by prompt tokens: the warm turn decodes only its own message,
// while the same history without a cache decodes all of it.
export const kvCacheCancelKeepsCommittedCache: TestDefinition = {
  testId: 'kv-cache-cancel-keeps-committed-cache',
  params: {
    cacheKey: 'cancel-keeps-committed-session',
    // One turn per message. `predict` has to cover the longest of them: a
    // budget-stopped turn is not committed, so it would not leave a cache for
    // the cancel to preserve.
    messages: [
      'List ten animals, one per line.',
      'Now tell me a long story about wizards.',
      'What is the capital of France? Answer with just the city name.'
    ],
    cancelTurn: 2,
    // A token no other turn in this conversation can produce, so the assertion
    // fails if anything but the last turn's answer is measured.
    expectedAnswerContains: 'Paris',
    cancelAfterTokens: 3,
    generationParams: { temp: 0, top_k: 1, seed: 42, predict: 256 }
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 60000 }
}

export const kvCacheTests = [
  kvCacheCancelKeepsCommittedCache,
  kvCacheConcurrentSameKey,
  kvCacheConcurrentSameKeyAuto,
  kvCacheAutoConcurrency,
  kvCacheDeleteAll,
  kvCacheDeleteByKey,
  kvCacheDeleteByModel,
  kvCacheHypercoreDeletion,
  kvCacheSlidingWindow,
  kvCacheBooleanEnabled,
  kvCacheSequentialCalls,
  kvCacheStreamingSlidingWindow,
  kvCacheLongSingleMessage,
  kvCacheSessionSwitch,
  kvCacheDifferentSystemPrompts,
  kvCacheWithTools,
  kvCacheDeleteAndReuse,
  kvCacheStatsVerification,
  kvCacheNoSystemPrompt,
  kvCacheToolsSequentialSave,
  kvCacheToolSetChange,
  kvCacheWarmToolChoiceRequired,
  kvCacheCancelThenNewPrompt
]

/**
 * Attach a body on the same conditions the executor dispatched on: a delete operation, or a
 * completion that names a cache.
 */
for (const test of kvCacheTests) {
  if (test.steps || KV_CACHE_MULTI_RUN.has(test.testId)) continue
  const isDelete =
    test.testId.startsWith('kv-cache-delete-') || test.testId === 'kv-cache-hypercore-deletion'
  test.steps = isDelete ? deleteCacheSteps() : kvCompletionSteps()
}
