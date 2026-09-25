import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * One LLM-backed translation, folded to its text.
 *
 * `from` and `context` are optional references: left out when the test does
 * not set them, which is how the autodetect case says "no source language"
 * without needing a body of its own. `stream: false` because `text` is the
 * handle that carries the result in non-streaming mode on both clients; the
 * streaming case reads the token stream instead, through `collect: 'all'`.
 */
const translateSteps = (extra: Step[] = []): Step[] => [
  { useModel: { deps: ['llm'], as: 'model' } },
  {
    call: {
      method: 'translate',
      collect: 'text',
      params: {
        modelId: '$model',
        text: '$params.text',
        to: '$params.to',
        from: '$params.from?',
        context: '$params.context?',
        modelType: 'llamacpp-completion',
        stream: false
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } },
  ...extra
]

/** The executor additionally required real output from these two. */
const producesText: Step[] = [{ assert: { on: '$text', named: 'nonEmptyText' } }]

const createLlmTest = (
  testId: string,
  text: string,
  to: string,
  opts: { from?: string; context?: string; estimatedDurationMs?: number } = {},
  suites?: string[]
): TestDefinition => ({
  testId,
  params: {
    text,
    to,
    resource: 'llm',
    ...(opts.from && { from: opts.from }),
    ...(opts.context && { context: opts.context })
  },
  expectation: { validation: 'type', expectedType: 'string' },
  ...(suites && { suites }),
  steps: translateSteps(opts.context ? producesText : []),
  metadata: {
    category: 'translation-llm',
    dependency: 'llm',
    estimatedDurationMs: opts.estimatedDurationMs ?? 90000
  }
})

export const llmEnEs = createLlmTest(
  'translation-llm-en-es',
  'Hello, how are you today?',
  'es',
  { from: 'en' },
  ['smoke']
)

export const llmEnFr = createLlmTest('translation-llm-en-fr', 'Good morning, how are you?', 'fr', {
  from: 'en'
})

export const llmEsEn = createLlmTest(
  'translation-llm-es-en',
  'Buenos días, ¿cómo estás hoy?',
  'en',
  { from: 'es' }
)

export const llmAutodetect: TestDefinition = {
  testId: 'translation-llm-autodetect',
  params: { text: "Bonjour, comment allez-vous aujourd'hui?", to: 'en', resource: 'llm' },
  expectation: { validation: 'type', expectedType: 'string' },
  // No `from`: the optional reference resolves to nothing and the argument is
  // left off the call, so the worker detects the source language.
  steps: translateSteps(producesText),
  metadata: { category: 'translation-llm', dependency: 'llm', estimatedDurationMs: 90000 }
}

/**
 * Streamed, and it arrived in pieces.
 *
 * `collect: 'all'` carries both the tokens and the text they join to, so one
 * translation answers "did it stream" and "what did it say".
 */
export const llmStreaming: TestDefinition = {
  testId: 'translation-llm-streaming',
  params: { text: 'Hello, how are you today?', from: 'en', to: 'es', resource: 'llm' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      call: {
        method: 'translate',
        collect: 'all',
        params: {
          modelId: '$model',
          text: '$params.text',
          to: '$params.to',
          from: '$params.from?',
          modelType: 'llamacpp-completion',
          stream: true
        },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'all', as: 'tokens' } },
    { assert: { on: '$tokens', named: 'lengthAtLeast', with: { length: 1 } } },
    { project: { from: '$run', path: 'text', as: 'text' } },
    { assert: { on: '$text', named: 'nonEmptyText' } }
  ],
  metadata: { category: 'translation-llm', dependency: 'llm', estimatedDurationMs: 30000 }
}

/**
 * The run reported how long it took.
 *
 * `totalTokens` plus one timing figure, because which timing field the engine
 * fills depends on the backend -- the claim is that it reported timing, not
 * which field it chose.
 */
export const llmStats: TestDefinition = {
  testId: 'translation-llm-stats',
  params: { text: 'Hello world', from: 'en', to: 'es', resource: 'llm' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: translateSteps([
    { assert: { on: '$text', named: 'nonEmptyText' } },
    { project: { from: '$run', path: 'stats', as: 'stats' } },
    { assert: { on: '$stats', named: 'fieldsPresent', with: { fields: ['totalTokens'] } } },
    {
      assert: {
        on: '$stats',
        named: 'anyFieldPresent',
        with: { fields: ['totalTime', 'timeToFirstToken', 'tokensPerSecond'] }
      }
    }
  ]),
  metadata: { category: 'translation-llm', dependency: 'llm', estimatedDurationMs: 30000 }
}

export const llmContext = createLlmTest('translation-llm-context', 'bank', 'es', {
  from: 'en',
  context: 'Use formal language, context is financial institution'
})

export const llmLongText = createLlmTest(
  'translation-llm-long-text',
  'The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming. It is a perfect day to enjoy nature and relax.',
  'es',
  { from: 'en', estimatedDurationMs: 45000 }
)

/**
 * An empty input is refused, not translated.
 *
 * The executor accepted either an empty result or a rejection, so it never
 * said which one happens. Migrating it answered the question: the client's own
 * request validation rejects `text: ""` before anything reaches the worker.
 * Written as the rejection it is, so a client that started translating empty
 * input instead would fail here.
 */
export const llmEmptyText: TestDefinition = {
  testId: 'translation-llm-empty-text',
  params: { text: '', from: 'en', to: 'es', resource: 'llm' },
  expectation: { validation: 'throws-error', errorContains: 'Text cannot be empty' },
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      callError: {
        method: 'translate',
        collect: 'text',
        params: {
          modelId: '$model',
          text: '$params.text',
          to: '$params.to',
          from: '$params.from?',
          modelType: 'llamacpp-completion',
          stream: false
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    // The wording is deliberately not asserted. Both clients refuse before
    // anything reaches the worker -- the SDK's own request validation on JS,
    // pydantic on Python -- and each validator words it its own way. What
    // crosses clients, and what this test is about, is that the call is
    // refused rather than run.
    { assert: { on: '$message', named: 'nonEmptyText' } }
  ],
  metadata: { category: 'translation-llm', dependency: 'llm', estimatedDurationMs: 15000 }
}

export const translationLlmTests = [
  llmEnEs,
  llmEnFr,
  llmEsEn,
  llmAutodetect,
  llmStreaming,
  llmStats,
  llmContext,
  llmLongText,
  llmEmptyText
]
