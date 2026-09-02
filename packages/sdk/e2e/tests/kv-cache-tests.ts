import type { TestDefinition } from '@qvac/test-suite'

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
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 45000 }
}

export const kvCacheDifferentSystemPrompts: TestDefinition = {
  testId: 'kv-cache-different-system-prompts',
  params: {
    cacheKey: 'system-prompt-test-session',
    systemPrompts: ['You are a helpful math tutor.', 'You are a creative storyteller.'],
    userMessage: 'Hello!',
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
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

export const kvCacheDeleteAndReuse: TestDefinition = {
  testId: 'kv-cache-delete-and-reuse',
  params: {
    cacheKey: 'delete-reuse-test-session',
    history: [{ role: 'user', content: 'What is 5+5? Answer with just the number.' }],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 35000 }
}

export const kvCacheStatsVerification: TestDefinition = {
  testId: 'kv-cache-stats-verification',
  params: {
    cacheKey: 'stats-verification-session',
    messages: ['First message to warm up cache.', 'Second message should show cache tokens.'],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'llm', estimatedDurationMs: 90000 }
}

// Reasoning-model dependency ("tools" is the cross-platform Qwen3 build),
// since the default `llm` resource is Llama and emits no reasoning block.
export const kvCacheRemoveThinkingCompaction: TestDefinition = {
  testId: 'kv-cache-remove-thinking-compaction',
  params: {
    cacheKeyOn: 'remove-thinking-on-session',
    cacheKeyOff: 'remove-thinking-off-session',
    messages: [
      'Think step by step, then answer: what is 17 multiplied by 23?',
      'Now add 100 to that result.'
    ],
    // Bounded, not disabled: the assertion needs a reasoning block, and a
    // positive budget still force-emits the closing think tag.
    generationParams: { reasoning_budget: 128, predict: 256, temp: 0, seed: 42 }
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: { category: 'kv-cache', dependency: 'tools', estimatedDurationMs: 180000 }
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
    generationParams: { temp: 0, top_k: 1, seed: 42 }
  },
  expectation: { validation: 'type', expectedType: 'string' },
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
export const kvCacheAutoConcurrency: TestDefinition = {
  testId: 'kv-cache-auto-concurrency',
  params: { generationParams: { temp: 0, seed: 42, predict: 48 } },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: { category: 'kv-cache', dependency: 'llm-batch', estimatedDurationMs: 60000 }
}

export const kvCacheTests = [
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
  kvCacheRemoveThinkingCompaction,
  kvCacheNoSystemPrompt,
  kvCacheToolsSequentialSave,
  kvCacheCancelThenNewPrompt
]
