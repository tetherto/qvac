// Completion test definitions
import type { Step, TestDefinition } from '@qvac/test-suite'

interface GenerationParams {
  temp?: number
  top_p?: number
  top_k?: number
  predict?: number
  seed?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
  reasoning_budget?: number
  remove_thinking_from_context?: boolean
}

type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      json_schema: {
        name: string
        schema: Record<string, unknown>
        description?: string
        strict?: boolean
      }
    }

// Shared deterministic sampling: greedy decode + fixed seed so a passing
// assertion stays reproducible across runs, models, and addon updates.
const DETERMINISTIC: GenerationParams = { temp: 0, seed: 42 }

interface CompletionTestParams {
  history: Array<{ role: string; content: string }>
  stream?: boolean
  stopSequences?: string[]
  responseFormat?: ResponseFormat
  tools?: Array<Record<string, unknown>>
  generationParams?: GenerationParams
  /** Second-turn user message for the warm-cache overflow flow. */
  followUpContent?: string
}

type CompletionExpectation =
  | { validation: 'contains-all' | 'contains-any'; contains: string[] }
  | { validation: 'regex'; pattern: string }
  | { validation: 'type'; expectedType: 'string' | 'number' | 'array' }
  | { validation: 'throws-error'; errorContains: string }

interface CompletionTestOptions {
  estimatedDurationMs?: number
  suites?: string[]
  skip?: { reason: string }
  dependency?: 'llm' | 'llm-batch' | 'llm-small-ctx' | 'none'
  /** A hand-written body, for the tests that are more than one call. */
  steps?: Step[]
  /** Teardown, for the tests that leave something behind. */
  finally?: Step[]
}

/**
 * The named cache the warm-overflow test fills and then deletes.
 *
 * A fixed name rather than a timestamped one: the test deletes it in
 * teardown on both paths, so there is nothing for a later run to collide
 * with, and a name that changes every run leaves orphans behind whenever the
 * delete does not happen.
 */
const WARM_OVERFLOW_CACHE_KEY = 'completion-context-overflow-warm'

/**
 * The declarative body every plain completion test has.
 *
 * `collect: 'text'` names the fold: the completion's final content text. Both
 * clients resolve it the same way -- JS awaits the run's `text`, Python awaits
 * `final.content_text` -- so "the text of this completion" means one thing
 * across languages. A test that cares about the deltas themselves rather than
 * the text asks for `collect: 'events'` instead.
 *
 * The optional `?` references leave an argument out when the test does not set
 * it, rather than passing it as null. An SDK that tells "absent" apart from
 * "explicitly nothing" would otherwise see a different call than the test meant
 * to make.
 */
const completionSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        stream: '$params.stream?',
        stopSequences: '$params.stopSequences?',
        responseFormat: '$params.responseFormat?',
        tools: '$params.tools?',
        generationParams: '$params.generationParams?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

/**
 * Tests whose body is more than one call, left on the executor for now.
 *
 * Each needs something the vocabulary does not have yet -- several completions
 * in flight at once, a second turn against a warm cache, a read of the run's
 * stats rather than its text. They are named here rather than detected so that
 * what is still executor-only is a list someone can read, not a switch
 * statement to reverse-engineer.
 */
/** A completion call, with only the parameters the test sets. */
const completionCall = (extra: Record<string, unknown> = {}) => ({
  modelId: '$model',
  history: '$params.history',
  stream: '$params.stream?',
  stopSequences: '$params.stopSequences?',
  responseFormat: '$params.responseFormat?',
  tools: '$params.tools?',
  generationParams: '$params.generationParams?',
  ...extra
})

/** One completion, bound under `as` with its text projected out. */
const completionRun = (dependency: string, as: string, extra: Step[] = []): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { call: { method: 'completion', collect: 'text', params: completionCall(), as } },
  { project: { from: `$${as}`, path: 'text', as: `${as}Text` } },
  ...extra
]

/**
 * Several completions issued before any of them is awaited.
 *
 * `start` is what makes this expressible: the executor fired them with
 * `Promise.allSettled`, and the claim is about what happens when the queue is
 * asked for more than one thing at a time -- every one of them must still come
 * back, which `settle` insists on.
 */
const concurrentSteps = (dependency: string, count: number, checks: Step[]): Step[] => {
  const steps: Step[] = [{ useModel: { deps: [dependency], as: 'model' } }]
  for (let i = 0; i < count; i++) {
    steps.push({
      start: { method: 'completion', collect: 'text', params: completionCall(), as: `run${i}` }
    })
  }
  for (let i = 0; i < count; i++) {
    steps.push({ settle: { of: `$run${i}`, as: `settled${i}` } })
    steps.push({ project: { from: `$settled${i}`, path: 'text', as: `text${i}` } })
  }
  return [...steps, ...checks]
}

/**
 * Tests whose body is more than one call, and which carry their own below.
 *
 * `completion-concurrent-overlap` is the one that stays on its executor: it
 * gates on `avgConcurrentSeq > 1` from the engine's own stats and reports
 * client-side token-window overlap as a diagnostic, which needs per-chunk
 * arrival timestamps the fold does not keep.
 */
const NOT_YET_DECLARATIVE = new Set([
  'completion-response-format-json-object',
  'completion-response-format-json-object-streaming',
  'completion-response-format-json-schema',
  'completion-response-format-with-tools-rejected',
  'completion-stats',
  'completion-concurrent-requests',
  'completion-concurrent-overlap',
  'completion-seed-reproducibility',
  'completion-stop-reason-length',
  'completion-context-boundary-stop',
  'completion-context-overflow-prefill',
  'completion-context-overflow-warm-cache'
])

// Helper for creating completion tests with common structure
const createCompletionTest = (
  testId: string,
  params: CompletionTestParams,
  expectation: CompletionExpectation,
  options: CompletionTestOptions = {}
): TestDefinition => {
  const dependency = options.dependency ?? 'llm'
  return {
    testId,
    params,
    expectation,
    ...(options.suites && { suites: options.suites }),
    ...(options.skip && { skip: options.skip }),
    ...(options.finally && { finally: options.finally }),
    ...(options.steps
      ? { steps: options.steps }
      : NOT_YET_DECLARATIVE.has(testId) || dependency === 'none'
        ? {}
        : { steps: completionSteps(dependency) }),
    metadata: {
      category: 'completion',
      dependency,
      estimatedDurationMs: options.estimatedDurationMs ?? 10000
    }
  }
}

// Basic completion tests
export const completionStreaming = createCompletionTest(
  'completion-streaming',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    stream: true,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['4'] },
  { suites: ['smoke'] }
)

export const completionEmptyPrompt = createCompletionTest(
  'completion-empty-prompt',
  {
    history: [{ role: 'user', content: '' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 5000, suites: ['smoke'] }
)

export const completionMultiTurn = createCompletionTest(
  'completion-multi-turn',
  {
    history: [
      { role: 'user', content: 'Name a tropical fruit using one lowercase word.' },
      { role: 'assistant', content: 'papaya' },
      {
        role: 'user',
        content: 'Repeat your previous answer exactly. Output only that lowercase word.'
      }
    ],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['papaya'] },
  { suites: ['smoke'] }
)

// Temperature variations
export const completionTemperature00 = createCompletionTest(
  'completion-temperature-00',
  {
    history: [{ role: 'user', content: 'What is 5+5? Answer with just the number.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['10'] },
  { estimatedDurationMs: 8000, suites: ['smoke'] }
)

export const completionTemperature05 = createCompletionTest(
  'completion-temperature-05',
  {
    history: [{ role: 'user', content: 'What is 6+6? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.5, seed: 42 }
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 8000 }
)

// High-temperature sweep: the point is that the sampling param is accepted and
// generation still works — not exact arithmetic (brittle at temp >= 1.0).
export const completionTemperature10 = createCompletionTest(
  'completion-temperature-10',
  {
    history: [{ role: 'user', content: 'What is 7+7? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 1.0, seed: 42 }
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 8000 }
)

export const completionTemperature15 = createCompletionTest(
  'completion-temperature-15',
  {
    history: [{ role: 'user', content: 'What is 8+8? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 1.5, seed: 42 }
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 8000 }
)

// top_p variations
export const completionTopP = createCompletionTest(
  'completion-top-p',
  {
    history: [{ role: 'user', content: 'What is 7 + 8? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.1, top_p: 0.1, seed: 42 }
  },
  { validation: 'contains-all', contains: ['15'] }
)

export const completionTopP01 = createCompletionTest(
  'completion-top-p-01',
  {
    history: [
      {
        role: 'user',
        content: 'Count from 1 to 5. Answer with just the numbers separated by spaces.'
      }
    ],
    stream: false,
    generationParams: { temp: 0.1, top_p: 0.1, seed: 42 }
  },
  { validation: 'contains-all', contains: ['1', '2', '3', '4', '5'] },
  { estimatedDurationMs: 8000, suites: ['smoke'] }
)

export const completionTopP05 = createCompletionTest(
  'completion-top-p-05',
  {
    history: [{ role: 'user', content: 'What is 9+9? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.1, top_p: 0.5, seed: 42 }
  },
  { validation: 'contains-all', contains: ['18'] },
  { estimatedDurationMs: 8000 }
)

export const completionTopP10 = createCompletionTest(
  'completion-top-p-10',
  {
    history: [{ role: 'user', content: 'What is 11+11? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.1, top_p: 1.0, seed: 42 }
  },
  { validation: 'contains-all', contains: ['22'] },
  { estimatedDurationMs: 8000 }
)

// Frequency penalty variations
export const completionFrequencyPenalty00 = createCompletionTest(
  'completion-frequency-penalty-00',
  {
    history: [{ role: 'user', content: 'What is 15+15? Answer with just the number.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: 0.0 }
  },
  { validation: 'contains-all', contains: ['30'] },
  { estimatedDurationMs: 8000 }
)

export const completionFrequencyPenaltyNeg10 = createCompletionTest(
  'completion-frequency-penalty-neg10',
  {
    history: [{ role: 'user', content: 'What is 13+13? Answer with just the number.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: -1.0 }
  },
  { validation: 'contains-all', contains: ['26'] },
  { estimatedDurationMs: 8000 }
)

export const completionFrequencyPenalty10 = createCompletionTest(
  'completion-frequency-penalty-10',
  {
    history: [{ role: 'user', content: 'What is 17+17? Answer with just the number.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: 1.0 }
  },
  { validation: 'contains-all', contains: ['34'] },
  { estimatedDurationMs: 8000 }
)

export const completionPresencePenalty = createCompletionTest(
  'completion-presence-penalty',
  {
    history: [
      {
        role: 'user',
        content: 'What is frozen water called? Answer with one word.'
      }
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, presence_penalty: 1.0 }
  },
  { validation: 'contains-all', contains: ['ice'] },
  { estimatedDurationMs: 8000 }
)

// Temperature variations (already have 0.0, 0.5, 1.0, 1.5)
export const completionTemperature01 = createCompletionTest(
  'completion-temperature-01',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.1, seed: 42 }
  },
  { validation: 'contains-all', contains: ['4'] },
  { estimatedDurationMs: 8000 }
)

export const completionTemperature09 = createCompletionTest(
  'completion-temperature-09',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }],
    stream: false,
    generationParams: { temp: 0.9, seed: 42 }
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 8000 }
)

// Advanced parameters
export const completionStopSequences = createCompletionTest(
  'completion-stop-sequences',
  {
    history: [
      {
        role: 'user',
        content: 'Repeat exactly the following words separated by spaces: apple banana cherry'
      }
    ],
    stream: false,
    stopSequences: ['banana']
  },
  { validation: 'contains-all', contains: ['apple', 'banana'] } // Should stop at banana
)

export const completionRepeatPenalty = createCompletionTest(
  'completion-repeat-penalty',
  {
    history: [
      {
        role: 'user',
        content: 'Count from 1 to 5. Answer with just the numbers separated by spaces.'
      }
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, repeat_penalty: 1.3 }
  },
  { validation: 'contains-all', contains: ['1', '2', '3', '4', '5'] },
  { estimatedDurationMs: 8000 }
)

export const completionTopK = createCompletionTest(
  'completion-top-k',
  {
    history: [{ role: 'user', content: 'What is 2 + 3? Answer with just the number.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, top_k: 1 }
  },
  { validation: 'contains-all', contains: ['5'] },
  { estimatedDurationMs: 8000 }
)

// Runs the same prompt twice with a fixed seed and asserts byte-identical
// output — see CompletionExecutor.seedReproducibility.
export const completionSeedReproducibility = createCompletionTest(
  'completion-seed-reproducibility',
  {
    history: [{ role: 'user', content: 'Generate a random story in 20 words.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'type', expectedType: 'string' },
  {
    // The same prompt and seed twice. Identical text is the claim; the first
    // run having produced anything at all is the premise, because two empty
    // strings are also identical.
    steps: [
      ...completionRun('llm', 'first'),
      { assert: { on: '$firstText', named: 'nonEmptyText' } },
      {
        call: { method: 'completion', collect: 'text', params: completionCall(), as: 'second' }
      },
      { project: { from: '$second', path: 'text', as: 'secondText' } },
      { compare: { left: '$firstText', right: '$secondText', named: 'equalStrings' } }
    ]
  }
)

export const completionStopSequencesMultiple = createCompletionTest(
  'completion-stop-sequences-multiple',
  {
    history: [{ role: 'user', content: 'List 20 animals, one per line.' }],
    stream: false,
    stopSequences: ['dog', 'cat', 'bird']
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionMaxTokens = createCompletionTest(
  'completion-max-tokens',
  {
    history: [{ role: 'user', content: 'Count from 1 to 100.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 10 }
  },
  { validation: 'type', expectedType: 'string' }
)

// Fires multiple completions in parallel and asserts all resolve correctly —
// see CompletionExecutor.concurrentRequests.
export const completionConcurrentRequests = createCompletionTest(
  'completion-concurrent-requests',
  {
    history: [{ role: 'user', content: 'What is 3 + 3? Answer with just the number.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['6'] },
  {
    estimatedDurationMs: 15000,
    suites: ['smoke'],
    steps: concurrentSteps('llm', 3, [
      { assert: { on: '$text0', use: 'expectation' } },
      { assert: { on: '$text1', use: 'expectation' } },
      { assert: { on: '$text2', use: 'expectation' } }
    ])
  }
)

// Proves real concurrent decoding, not just eventual success: fires several
// streamed completions at once on a parallel:4 model and asserts (in the
// executor) that at least two decode intervals overlap. A serialized model
// would run them one after another with zero overlap. See
// CompletionExecutor.concurrentOverlap.
export const completionConcurrentOverlap = createCompletionTest(
  'completion-concurrent-overlap',
  {
    history: [{ role: 'user', content: 'Count from one to twenty using words.' }],
    stream: true,
    generationParams: { ...DETERMINISTIC, predict: 64 }
  },
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 20000, suites: ['smoke'], dependency: 'llm-batch' }
)

export const completionCountInWords = createCompletionTest(
  'completion-count-in-words',
  {
    history: [{ role: 'user', content: 'Count from one to five using words.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-any', contains: ['one', 'two', 'three'] }
)

export const completionWithWhitespace = createCompletionTest(
  'completion-whitespace',
  {
    history: [
      {
        role: 'user',
        content: '   What is 12 + 12?   Answer with just the number.   '
      }
    ],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['24'] }
)

export const completionJsonFormat = createCompletionTest(
  'completion-json-format',
  {
    history: [
      {
        role: 'user',
        content: 'Return this JSON: {"result": 25}. Just return the exact JSON.'
      }
    ],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['25', '{', '}'] },
  { suites: ['smoke'] }
)

export const completionCodeGeneration = createCompletionTest(
  'completion-code-generation',
  {
    history: [{ role: 'user', content: 'Write a hello world function in JavaScript.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-any', contains: ['function', 'hello', 'console'] }
)

export const completionConversationContext = createCompletionTest(
  'completion-conversation-context',
  {
    history: [{ role: 'user', content: 'Tell me about AI in one short sentence.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 32 }
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionSingleWord = createCompletionTest(
  'completion-single-word',
  {
    history: [{ role: 'user', content: 'Hello' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionListGeneration = createCompletionTest(
  'completion-list-generation',
  {
    history: [{ role: 'user', content: 'List 5 colors.' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionQaFromContext = createCompletionTest(
  'completion-qa-from-context',
  {
    history: [{ role: 'user', content: 'The sky is blue. What color is the sky?' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'contains-all', contains: ['blue'] },
  { suites: ['smoke'] }
)

export const completionSentenceCompletion = createCompletionTest(
  'completion-sentence-completion',
  {
    history: [{ role: 'user', content: 'The quick brown fox' }],
    stream: false,
    generationParams: DETERMINISTIC
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionResponseFormatText = createCompletionTest(
  'completion-response-format-text',
  {
    history: [{ role: 'user', content: 'Reply with only the word BANANA.' }],
    stream: false,
    responseFormat: { type: 'text' },
    generationParams: { ...DETERMINISTIC, predict: 16 }
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionResponseFormatJsonObject = createCompletionTest(
  'completion-response-format-json-object',
  {
    history: [
      {
        role: 'system',
        content: 'Reply with a single valid JSON object only. No markdown, no prose.'
      },
      { role: 'user', content: "Return an object with a single key 'ok' set to the boolean true." }
    ],
    stream: false,
    responseFormat: { type: 'json_object' },
    generationParams: { ...DETERMINISTIC, predict: 64 }
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 15000,
    steps: completionRun('llm', 'run', [{ assert: { on: '$runText', named: 'jsonObjectShape' } }])
  }
)

export const completionResponseFormatJsonObjectStreaming = createCompletionTest(
  'completion-response-format-json-object-streaming',
  {
    history: [
      {
        role: 'system',
        content: 'Reply with a single valid JSON object only. No markdown, no prose.'
      },
      { role: 'user', content: "Return an object with a single key 'ok' set to the boolean true." }
    ],
    stream: true,
    responseFormat: { type: 'json_object' },
    generationParams: { ...DETERMINISTIC, predict: 64 }
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 15000,
    // Streamed, and the pieces still have to join into one JSON object: a
    // format promise that only held in non-streaming mode would be worth less
    // than no promise.
    steps: completionRun('llm', 'run', [{ assert: { on: '$runText', named: 'jsonObjectShape' } }])
  }
)

export const completionResponseFormatJsonSchema = createCompletionTest(
  'completion-response-format-json-schema',
  {
    history: [
      {
        role: 'user',
        content: 'Extract the person info as JSON. Person: Alice, age 30, occupation data engineer.'
      }
    ],
    stream: false,
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'Person',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            occupation: { type: 'string' }
          },
          required: ['name', 'age', 'occupation'],
          additionalProperties: false
        }
      }
    },
    generationParams: { ...DETERMINISTIC, predict: 128 }
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 20000,
    // `exactKeys` is the `additionalProperties: false` half of the schema: a
    // model that returned the three fields plus a fourth would satisfy every
    // per-field check and still have broken the contract.
    steps: completionRun('llm', 'run', [
      {
        assert: {
          on: '$runText',
          named: 'jsonObjectShape',
          with: {
            fields: { name: 'string', age: 'integer', occupation: 'string' },
            exactKeys: ['name', 'age', 'occupation']
          }
        }
      }
    ])
  }
)

export const completionReasoningBudgetDisabled = createCompletionTest(
  'completion-reasoning-budget-disabled',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    stream: false,
    generationParams: { reasoning_budget: 0, predict: 32 }
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionReasoningBudgetUnrestricted = createCompletionTest(
  'completion-reasoning-budget-unrestricted',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    stream: false,
    generationParams: { reasoning_budget: -1, predict: 32 }
  },
  { validation: 'type', expectedType: 'string' }
)

export const completionRemoveThinkingFromContext = createCompletionTest(
  'completion-remove-thinking-from-context',
  {
    history: [{ role: 'user', content: 'What is 2+2? Answer with only the number.' }],
    stream: false,
    generationParams: { remove_thinking_from_context: true, predict: 32 }
  },
  { validation: 'type', expectedType: 'string' }
)

// Validates that stopReason "length" is emitted when the token budget is
// exhausted before EOS. Uses a tiny predict budget against a prompt that
// would produce far more tokens if unconstrained.
export const completionStopReasonLength = createCompletionTest(
  'completion-stop-reason-length',
  {
    history: [{ role: 'user', content: 'Count from 1 to 100.' }],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 3 }
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 8000,
    steps: completionRun('llm', 'run', [
      { project: { from: '$run', path: 'stopReason', as: 'stopReason' } },
      { assert: { on: '$stopReason', named: 'valueIn', with: { values: ['length'] } } }
    ])
  }
)

export const completionResponseFormatWithToolsRejected = createCompletionTest(
  'completion-response-format-with-tools-rejected',
  {
    history: [{ role: 'user', content: 'irrelevant' }],
    stream: false,
    responseFormat: { type: 'json_object' },
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    ],
    generationParams: { ...DETERMINISTIC, predict: 64 }
  },
  { validation: 'throws-error', errorContains: 'responseFormat' },
  {
    estimatedDurationMs: 5000,
    dependency: 'none',
    // No model: the refusal is the client's own validation, and it has to
    // happen before anything is looked up. The id is deliberately one no
    // registry holds, so a check that moved behind the wire would fail on the
    // lookup rather than quietly passing.
    steps: [
      {
        callError: {
          method: 'completion',
          collect: 'text',
          params: {
            modelId: 'schema-refinement-placeholder',
            history: '$params.history',
            stream: '$params.stream',
            responseFormat: '$params.responseFormat',
            tools: '$params.tools',
            generationParams: '$params.generationParams'
          },
          as: 'err'
        }
      },
      { project: { from: '$err', path: 'message', as: 'message' } },
      { assert: { on: '$message', use: 'expectation' } }
    ]
  }
)

export const completionStats: TestDefinition = {
  testId: 'completion-stats',
  params: {
    history: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    stream: false,
    generationParams: { predict: 32 }
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: completionRun('llm', 'run', [
    { assert: { on: '$runText', named: 'nonEmptyText' } },
    { project: { from: '$run', path: 'stats', as: 'stats' } },
    {
      assert: {
        on: '$stats',
        named: 'fieldsPresent',
        with: { fields: ['timeToFirstToken', 'tokensPerSecond'] }
      }
    },
    {
      assert: {
        on: '$stats',
        named: 'nonNegativeNumbers',
        with: { fields: ['timeToFirstToken', 'tokensPerSecond'] }
      }
    }
  ]),
  metadata: { category: 'completion', dependency: 'llm', estimatedDurationMs: 10000 }
}

// The 1000 budget is far above the whole 512 window, so a "length" stop under
// it can only be the boundary; an early EOS is a fixture diagnostic.
export const completionContextBoundaryStop = createCompletionTest(
  'completion-context-boundary-stop',
  {
    history: [
      {
        role: 'user',
        content:
          'Count upward from 1 forever, one number per line. There is no final number; never stop counting.'
      }
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 1000 }
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 45000,
    dependency: 'llm-small-ctx',
    // Three claims, and the middle one is the test: it stopped for "length",
    // it stopped *below* the prediction budget -- which is what makes it the
    // context boundary rather than the budget running out -- and the tokens
    // produced before the boundary were returned rather than discarded.
    steps: completionRun('llm-small-ctx', 'run', [
      { project: { from: '$run', path: 'stopReason', as: 'stopReason' } },
      { assert: { on: '$stopReason', named: 'valueIn', with: { values: ['length'] } } },
      { project: { from: '$run', path: 'stats.generatedTokens', as: 'generated' } },
      {
        assert: {
          on: '$generated',
          named: 'belowBudget',
          with: { budget: '$params.generationParams.predict' }
        }
      },
      { project: { from: '$run', path: 'fullText', as: 'fullText' } },
      { assert: { on: '$fullText', named: 'nonEmptyText' } }
    ])
  }
)

// A prompt that cannot fit the window is refused before any decoding with the
// typed ContextOverflowError carrying the parsed sizes.
export const completionContextOverflowPrefill = createCompletionTest(
  'completion-context-overflow-prefill',
  {
    history: [
      {
        role: 'user',
        content:
          'The quick brown fox jumps over the lazy dog and keeps running through the field. '.repeat(
            120
          ) + 'After all this text, what is 4+4?'
      }
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 8 }
  },
  { validation: 'throws-error', errorContains: 'context' },
  {
    estimatedDurationMs: 15000,
    dependency: 'llm-small-ctx',
    // The rejection has to carry the parsed sizes, not just say "context".
    // `promptTokens >= ctxSize` is the addon's own guard, and `ctxSize` must
    // be the configured 512 rather than a rescaled or defaulted figure --
    // either would mean the parser read the wrong quantity.
    steps: [
      { useModel: { deps: ['llm-small-ctx'], as: 'model' } },
      {
        callError: {
          method: 'completion',
          collect: 'text',
          params: completionCall(),
          as: 'err'
        }
      },
      { project: { from: '$err', path: 'message', as: 'message' } },
      { assert: { on: '$message', use: 'expectation' } },
      { project: { from: '$err', path: 'details', as: 'details' } },
      {
        assert: {
          on: '$details',
          named: 'positiveIntegers',
          with: { fields: ['promptTokens', 'ctxSize'] }
        }
      },
      {
        assert: {
          on: '$details',
          named: 'atLeastField',
          with: { field: 'promptTokens', atLeast: 'ctxSize' }
        }
      },
      { project: { from: '$details', path: 'ctxSize', as: 'ctxSize' } },
      { assert: { on: '$ctxSize', named: 'valueIn', with: { values: [512] } } }
    ]
  }
)

// Turn one fills most of the 512 window and is cached; the follow-up fits
// the window alone but not on top of the cache.
export const completionContextOverflowWarmCache = createCompletionTest(
  'completion-context-overflow-warm-cache',
  {
    history: [
      {
        role: 'user',
        content:
          'The quick brown fox jumps over the lazy dog and keeps running through the field. '.repeat(
            20
          ) + 'Reply with the single word: noted.'
      }
    ],
    followUpContent:
      'The quick brown fox jumps over the lazy dog and keeps running through the field. '.repeat(
        10
      ) + 'After all this text, what is 4+4?',
    stream: false,
    // Enough budget that turn one finishes on EOS (commit-eligible) instead
    // of tripping the prediction cutoff, while still fitting the 512 window.
    generationParams: { ...DETERMINISTIC, predict: 48 }
  },
  { validation: 'throws-error', errorContains: 'context' },
  {
    estimatedDurationMs: 30000,
    dependency: 'llm-small-ctx',
    // Two turns against one named cache. Turn one has to end commit-eligible
    // -- no stop reason, some text -- or turn two would be a cold full-history
    // resend and would not be testing the warm path at all. Turn two then
    // fits the window on its own but not on top of what is cached, and the
    // rejection has to carry the warm signature: a `requiredTokens` at least
    // the size of the window.
    steps: [
      { useModel: { deps: ['llm-small-ctx'], as: 'model' } },
      {
        call: {
          method: 'completion',
          collect: 'text',
          params: {
            modelId: '$model',
            history: '$params.history',
            stream: false,
            kvCache: WARM_OVERFLOW_CACHE_KEY,
            generationParams: '$params.generationParams'
          },
          as: 'firstTurn'
        }
      },
      { project: { from: '$firstTurn', path: 'stopReason', as: 'firstStop' } },
      { assert: { on: '$firstStop', named: 'isAbsent' } },
      { project: { from: '$firstTurn', path: 'fullText', as: 'firstText' } },
      { assert: { on: '$firstText', named: 'nonEmptyText' } },
      {
        callError: {
          method: 'completion',
          collect: 'text',
          params: {
            modelId: '$model',
            history: [
              { role: 'user', content: '$params.history[0].content' },
              { role: 'assistant', content: '$firstText' },
              { role: 'user', content: '$params.followUpContent' }
            ],
            stream: false,
            kvCache: WARM_OVERFLOW_CACHE_KEY,
            generationParams: '$params.generationParams'
          },
          as: 'err'
        }
      },
      { project: { from: '$err', path: 'message', as: 'message' } },
      { assert: { on: '$message', use: 'expectation' } },
      { project: { from: '$err', path: 'details', as: 'details' } },
      { project: { from: '$details', path: 'ctxSize', as: 'ctxSize' } },
      { assert: { on: '$ctxSize', named: 'valueIn', with: { values: [512] } } },
      {
        assert: {
          on: '$details',
          named: 'atLeastField',
          with: { field: 'requiredTokens', atLeast: 'ctxSize' }
        }
      }
    ],
    finally: [
      {
        call: {
          method: 'deleteCache',
          params: { kvCacheKey: WARM_OVERFLOW_CACHE_KEY, modelId: '$model?' }
        }
      }
    ]
  }
)

export const completionTests = [
  completionStreaming,
  completionTemperature01,
  completionTemperature09,
  completionEmptyPrompt,
  completionMultiTurn,
  completionMaxTokens,
  completionStopSequences,
  completionTopP,
  completionRepeatPenalty,
  completionTopK,
  completionTemperature00,
  completionTemperature05,
  completionTemperature10,
  completionTemperature15,
  completionTopP01,
  completionTopP05,
  completionTopP10,
  completionFrequencyPenaltyNeg10,
  completionFrequencyPenalty00,
  completionFrequencyPenalty10,
  completionPresencePenalty,
  completionSeedReproducibility,
  completionStopSequencesMultiple,
  completionConcurrentRequests,
  completionConcurrentOverlap,
  completionCountInWords,
  completionWithWhitespace,
  completionJsonFormat,
  completionCodeGeneration,
  completionConversationContext,
  completionSingleWord,
  completionListGeneration,
  completionQaFromContext,
  completionSentenceCompletion,
  completionResponseFormatText,
  completionResponseFormatJsonObject,
  completionResponseFormatJsonObjectStreaming,
  completionResponseFormatJsonSchema,
  completionResponseFormatWithToolsRejected,
  completionReasoningBudgetDisabled,
  completionReasoningBudgetUnrestricted,
  completionRemoveThinkingFromContext,
  completionStats,
  completionStopReasonLength,
  completionContextBoundaryStop,
  completionContextOverflowPrefill,
  completionContextOverflowWarmCache
]
