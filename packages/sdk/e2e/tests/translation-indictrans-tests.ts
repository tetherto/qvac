import type { Expectation, Step, TestDefinition } from '@qvac/test-suite'

/**
 * One NMT translation. The model carries its own language pair, so unlike the
 * LLM-backed translations there is no `from`/`to` to pass -- which is exactly
 * the distinction the executor used to decide which call to make.
 */
const nmtSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: 'translate',
      collect: 'text',
      params: {
        modelId: '$model',
        text: '$params.text',
        modelType: 'nmtcpp-translation',
        stream: false
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

const createIndicTransTest = (
  testId: string,
  text: string,
  resource: string,
  expectation: Expectation,
  estimatedDurationMs: number = 20000,
  suites?: string[]
): TestDefinition => ({
  testId,
  params: { text, resource },
  expectation,
  ...(suites && { suites }),
  metadata: { category: 'translation-indictrans', dependency: resource, estimatedDurationMs }
})

// --- EN → HI (indictrans-en-hi) ---
// IndicTrans en→hi outputs Devanagari script — validate non-empty string

export const indictransEnHiBasic = createIndicTransTest(
  'translation-indictrans-en-hi-basic',
  'Hello, how are you today?',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' },
  20000,
  ['smoke']
)

export const indictransEnHiLongText = createIndicTransTest(
  'translation-indictrans-en-hi-long-text',
  'The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming.',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' },
  30000
)

export const indictransEnHiShortText = createIndicTransTest(
  'translation-indictrans-en-hi-short-text',
  'Thank you',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' },
  15000
)

export const indictransEnHiQuestion = createIndicTransTest(
  'translation-indictrans-en-hi-question',
  'Where is the nearest hospital?',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' }
)

export const indictransEnHiNumbers = createIndicTransTest(
  'translation-indictrans-en-hi-numbers',
  'The meeting is at 10:30 AM. We have 25 participants.',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' }
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
export const indictransEnHiEmptyText: TestDefinition = {
  testId: 'translation-indictrans-en-hi-empty-text',
  params: { text: '', resource: 'indictrans-en-hi' },
  expectation: { validation: 'throws-error', errorContains: 'Text cannot be empty' },
  steps: [
    { useModel: { deps: ['indictrans-en-hi'], as: 'model' } },
    {
      callError: {
        method: 'translate',
        collect: 'text',
        params: {
          modelId: '$model',
          text: '$params.text',
          modelType: 'nmtcpp-translation',
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
  metadata: {
    category: 'translation-indictrans',
    dependency: 'indictrans-en-hi',
    estimatedDurationMs: 10000
  }
}

export const indictransEnHiStreaming = createIndicTransTest(
  'translation-indictrans-en-hi-streaming',
  'Good morning, how are you?',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' }
)

export const indictransEnHiStats = createIndicTransTest(
  'translation-indictrans-en-hi-stats',
  'Hello world',
  'indictrans-en-hi',
  { validation: 'type', expectedType: 'string' }
)

export const indictransEnHiBatchBasic: TestDefinition = {
  testId: 'translation-indictrans-en-hi-batch-basic',
  params: { texts: ['Good morning', 'Good night'], resource: 'indictrans-en-hi' },
  expectation: { validation: 'type', expectedType: 'string' },
  // Same three claims as the Bergamot batch: one entry per input, none empty,
  // and the run's `text` is exactly those entries joined.
  steps: [
    { useModel: { deps: ['indictrans-en-hi'], as: 'model' } },
    {
      call: {
        method: 'translate',
        collect: 'text',
        params: {
          modelId: '$model',
          text: '$params.texts',
          modelType: 'nmtcpp-translation',
          stream: false
        },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'translations', as: 'translations' } },
    { assert: { on: '$translations', named: 'lengthIs', with: { length: 2 } } },
    {
      repeat: {
        over: '$translations',
        as: 'entry',
        collectInto: 'checked',
        steps: [{ assert: { on: '$entry', named: 'nonEmptyText' } }]
      }
    },
    { project: { from: '$run', path: 'text', as: 'text' } },
    {
      assert: {
        on: '$text',
        named: 'equalsJoined',
        with: { parts: '$translations', separator: '\n' }
      }
    }
  ],
  metadata: {
    category: 'translation-indictrans',
    dependency: 'indictrans-en-hi',
    estimatedDurationMs: 20000
  }
}

// --- HI → EN (indictrans-hi-en) ---

export const indictransHiEnBasic = createIndicTransTest(
  'translation-indictrans-hi-en-basic',
  'नमस्ते, आप कैसे हैं?',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['hello', 'how', 'are', 'you', 'namaste'] },
  20000,
  ['smoke']
)

export const indictransHiEnLongText = createIndicTransTest(
  'translation-indictrans-hi-en-long-text',
  'आज मौसम बहुत अच्छा है। मैंने पार्क में टहलने का फैसला किया। पक्षी गा रहे हैं और फूल खिल रहे हैं।',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['weather', 'park', 'birds', 'flowers', 'walk'] },
  30000
)

export const indictransHiEnShortText = createIndicTransTest(
  'translation-indictrans-hi-en-short-text',
  'धन्यवाद',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['thank', 'thanks'] },
  15000
)

export const indictransHiEnQuestion = createIndicTransTest(
  'translation-indictrans-hi-en-question',
  'निकटतम अस्पताल कहाँ है?',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['hospital', 'where', 'nearest'] }
)

export const indictransHiEnStreaming = createIndicTransTest(
  'translation-indictrans-hi-en-streaming',
  'शुभ प्रभात',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['good', 'morning'] }
)

export const indictransHiEnStats = createIndicTransTest(
  'translation-indictrans-hi-en-stats',
  'नमस्ते',
  'indictrans-hi-en',
  { validation: 'contains-any', contains: ['hello', 'hi', 'greetings', 'namaste'] }
)

export const translationIndicTransTests = [
  // EN → HI
  indictransEnHiBasic,
  indictransEnHiLongText,
  indictransEnHiShortText,
  indictransEnHiQuestion,
  indictransEnHiNumbers,
  indictransEnHiEmptyText,
  indictransEnHiStreaming,
  indictransEnHiStats,
  indictransEnHiBatchBasic,
  // HI → EN
  indictransHiEnBasic,
  indictransHiEnLongText,
  indictransHiEnShortText,
  indictransHiEnQuestion,
  indictransHiEnStreaming,
  indictransHiEnStats
]

/**
 * Attach the body to every definition that is one translation. A test naming
 * several texts, or comparing two runs, keeps its hand-written body.
 */
for (const test of translationIndicTransTests) {
  if (test.steps) continue
  const params = test.params as { text?: unknown; texts?: unknown }
  if (typeof params.text !== 'string' || params.texts !== undefined) continue
  test.steps = nmtSteps(String(test.metadata?.dependency ?? ''))
}
