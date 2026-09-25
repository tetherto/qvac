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
 * Bodies that are about what happens BETWEEN runs -- a cache deleted then
 * reused, two sessions switched, a cancelled run that must leave the committed
 * cache intact, several completions racing for one cache path. One call is not
 * what they are about, so they keep their hand-written bodies.
 */
/**
 * A run of completions that all share one cache key, each with its own message.
 *
 * The executor looped and pushed; as a body that is a `repeat`, with the
 * per-iteration message named. What is being tested is that a cache survives
 * being used again -- so every response has to be real, and an empty one is
 * the failure.
 */
const sharedCacheTurns = (over: string, content: string, systemPrompt: string): Step[] => [
  { useModel: { deps: ['llm'], as: 'model' } },
  {
    repeat: {
      over,
      as: 'turn',
      collectInto: 'texts',
      steps: [
        {
          call: {
            method: 'completion',
            collect: 'text',
            params: {
              modelId: '$model',
              history: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content }
              ],
              stream: '$params.stream?',
              kvCache: '$params.cacheKey?'
            },
            as: 'run'
          }
        },
        { project: { from: '$run', path: 'text', as: 'text' } },
        { assert: { on: '$text', named: 'nonEmptyText' } }
      ]
    }
  }
]

/**
 * Bodies that stay on the executor, and why.
 *
 * The three `concurrent`/`auto-concurrency` tests measure when each decode
 * *started and ended*, from the arrival times of individual tokens, and gate
 * on whether those intervals overlap. The folds keep what a run produced, not
 * when each piece of it arrived, so a declarative body could only assert that
 * every completion came back -- which is the part that already passes when the
 * lock is broken. The rest are multi-turn flows still to be written out.
 */
/**
 * One two-turn conversation over a named cache, with reasoning compaction set
 * one way or the other, leaving the second turn's cached-token count bound.
 */
const thinkingSession = (cacheKey: string, removeThinking: boolean, as: string): Step[] => [
  { call: { method: 'deleteCache', params: { kvCacheKey: cacheKey } } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: [{ role: 'user', content: '$params.messages[0]' }],
        stream: false,
        kvCache: cacheKey,
        generationParams: {
          reasoning_budget: '$params.generationParams.reasoning_budget',
          predict: '$params.generationParams.predict',
          temp: '$params.generationParams.temp',
          seed: '$params.generationParams.seed',
          remove_thinking_from_context: removeThinking
        }
      },
      as: `${as}First`
    }
  },
  { project: { from: `$${as}First`, path: 'text', as: `${as}FirstText` } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: [
          { role: 'user', content: '$params.messages[0]' },
          { role: 'assistant', content: `$${as}FirstText` },
          { role: 'user', content: '$params.messages[1]' }
        ],
        stream: false,
        kvCache: cacheKey,
        generationParams: {
          reasoning_budget: '$params.generationParams.reasoning_budget',
          predict: '$params.generationParams.predict',
          temp: '$params.generationParams.temp',
          seed: '$params.generationParams.seed',
          remove_thinking_from_context: removeThinking
        }
      },
      as: `${as}Second`
    }
  },
  { project: { from: `$${as}Second`, path: 'stats.cacheTokens', as: `${as}CacheTokens` } }
]

/**
 * One tool-calling turn over the named cache, leaving its text, its tool call
 * and its cached-token count bound.
 */
const toolTurn = (history: unknown, as: string): Step[] => [
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history,
        stream: '$params.stream',
        kvCache: '$params.cacheKey',
        tools: '$params.tools',
        generationParams: '$params.generationParams'
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
        declared: ['$params.declaredTool'],
        name: '$params.declaredTool',
        argKeys: '$params.requiredArgs'
      }
    }
  },
  { project: { from: `$${as}Turn`, path: 'stats.cacheTokens', as: `${as}CacheTokens` } }
]

/**
 * The two cancellation tests below stay on their executor for the same reason
 * `finetune-pause-resume` does: they cancel after a given number of tokens has
 * arrived, which means deciding inside the stream. `start`/`settle` can put a
 * call in flight, but a step cannot carry the predicate that says when the
 * moment has come.
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

/**
 * Three turns over two cache keys, returning to the first.
 *
 * Switching away and back is the point: a cache that was clobbered by the
 * intervening session would show up on the third turn and nowhere else.
 */
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

/**
 * The same cache key, reused under two different system prompts.
 *
 * The prefix changes, so the cached prefix has to be invalidated rather than
 * reused; a client that matched on the key alone would answer the second
 * prompt with the first one's state.
 */
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

/**
 * A cache deleted mid-flight, then used again under the same name.
 *
 * Deleting a live cache and reusing its key is where a stale handle would
 * surface: the second completion has to rebuild rather than reload something
 * that is no longer there.
 */
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

// Reasoning-model dependency ("tools" is the cross-platform Qwen3 build),
// since the default `llm` resource is Llama and emits no reasoning block.
/**
 * Two identical two-turn conversations, one with reasoning compaction on.
 *
 * With compaction on, turn one's `<think>` block is dropped from the persisted
 * cache, so turn two reloads a smaller prefix and reports fewer cached tokens.
 * A passthrough regression -- the flag dropped before the addon -- collapses
 * the two runs to equal counts, which is exactly what the comparison catches.
 *
 * Both turns of each session are written out rather than looped: turn two's
 * history contains turn one's answer, which is the whole reason there is a
 * prefix to reuse.
 */
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
  steps: [
    { useModel: { deps: ['tools'], as: 'model' } },
    ...thinkingSession('$params.cacheKeyOn', true, 'on'),
    ...thinkingSession('$params.cacheKeyOff', false, 'off'),
    { compare: { left: '$offCacheTokens', right: '$onCacheTokens', named: 'greaterThan' } }
  ],
  finally: [
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKeyOn' } } },
    { call: { method: 'deleteCache', params: { kvCacheKey: '$params.cacheKeyOff' } } }
  ],
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

/**
 * Two tool-calling turns with a model reload in between.
 *
 * The reload is the test. It clears everything the addon holds in memory, so
 * the second turn's cached tokens can only have come from the file on disk --
 * if the save was silently rejected the two counts come back equal. Both turns
 * must also still produce a well-formed call against a declared tool, because
 * a cache that reloaded but corrupted the tool grammar would satisfy the
 * token comparison on its own.
 */
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
    // Evict and reload to clear the in-memory cache. Without this the addon
    // keeps the session in RAM and the second turn would report more cached
    // tokens even if the disk save never happened.
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

// A cancelled follow-up turn must not cost the session its committed cache.
// The addon rewinds a cancelled run to the pre-request state and the engine
// keeps the file, so the next turn stays warm. Proven by prompt tokens: the
// warm turn sends only its own message, while the same history without a
// cache sends all of it.
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
  kvCacheRemoveThinkingCompaction,
  kvCacheNoSystemPrompt,
  kvCacheToolsSequentialSave,
  kvCacheCancelThenNewPrompt
]

/**
 * Attach a body on the same conditions the executor dispatched on: a delete
 * operation, or a completion that names a cache.
 */
for (const test of kvCacheTests) {
  if (test.steps || KV_CACHE_MULTI_RUN.has(test.testId)) continue
  const isDelete =
    test.testId.startsWith('kv-cache-delete-') || test.testId === 'kv-cache-hypercore-deletion'
  test.steps = isDelete ? deleteCacheSteps() : kvCompletionSteps()
}
