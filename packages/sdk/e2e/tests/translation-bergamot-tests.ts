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

/**
 * A batch NMT translation: several inputs in one call.
 *
 * Three checks, because the executor made three claims: one entry per input,
 * none of them empty, and the run's `text` is exactly those entries joined --
 * the same answer in two shapes rather than two answers.
 */
const nmtBatchSteps = (count: number): Step[] => [
  { useModel: { deps: ['bergamot-en-fr'], as: 'model' } },
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
  { assert: { on: '$translations', named: 'lengthIs', with: { length: count } } },
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
  },
  { assert: { on: '$text', use: 'expectation' } }
]

const createBergamotTest = (
  testId: string,
  text: string,
  resource: string,
  expectation: Expectation,
  estimatedDurationMs: number = 15000,
  suites?: string[]
): TestDefinition => ({
  testId,
  params: { text, resource },
  expectation,
  ...(suites && { suites }),
  metadata: { category: 'translation-bergamot', dependency: resource, estimatedDurationMs }
})

// --- EN → FR (bergamot-en-fr) ---

export const bergamotEnFrBasic = createBergamotTest(
  'translation-bergamot-en-fr-basic',
  'Hello, how are you today?',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['bonjour', 'comment', 'vous', 'aujourd'] },
  15000,
  ['smoke']
)

export const bergamotEnFrLongText = createBergamotTest(
  'translation-bergamot-en-fr-long-text',
  'The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming.',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['temps', 'parc', 'oiseaux', 'fleurs', 'beau'] },
  20000
)

export const bergamotEnFrShortText = createBergamotTest(
  'translation-bergamot-en-fr-short-text',
  'Thank you very much',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['merci', 'beaucoup'] },
  10000
)

export const bergamotEnFrSpecialChars = createBergamotTest(
  'translation-bergamot-en-fr-special-chars',
  "What's your name? I'm John!",
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['nom', 'comment', 'appel'] }
)

export const bergamotEnFrQuestion = createBergamotTest(
  'translation-bergamot-en-fr-question',
  'Can you tell me where the train station is?',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['gare', 'où', 'dire'] }
)

export const bergamotEnFrNumbers = createBergamotTest(
  'translation-bergamot-en-fr-numbers',
  'The meeting is at 10:30. We have 25 participants.',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['réunion', '10', '25', 'participant'] }
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
export const bergamotEnFrEmptyText: TestDefinition = {
  testId: 'translation-bergamot-en-fr-empty-text',
  params: { text: '', resource: 'bergamot-en-fr' },
  expectation: { validation: 'throws-error', errorContains: 'Text cannot be empty' },
  steps: [
    { useModel: { deps: ['bergamot-en-fr'], as: 'model' } },
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
    category: 'translation-bergamot',
    dependency: 'bergamot-en-fr',
    estimatedDurationMs: 10000
  }
}

export const bergamotEnFrStreaming = createBergamotTest(
  'translation-bergamot-en-fr-streaming',
  'Good morning, how are you?',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['bonjour', 'comment', 'allez'] },
  15000,
  ['smoke']
)

export const bergamotEnFrStats = createBergamotTest(
  'translation-bergamot-en-fr-stats',
  'Hello world',
  'bergamot-en-fr',
  { validation: 'contains-any', contains: ['bonjour', 'monde'] }
)

export const bergamotEnFrBatchBasic: TestDefinition = {
  testId: 'translation-bergamot-en-fr-batch-basic',
  params: { texts: ['Good morning', 'Good night'], resource: 'bergamot-en-fr' },
  expectation: { validation: 'contains-any', contains: ['bonjour', 'matin', 'nuit', 'bonne'] },
  steps: nmtBatchSteps(2),
  metadata: {
    category: 'translation-bergamot',
    dependency: 'bergamot-en-fr',
    estimatedDurationMs: 15000
  }
}

export const bergamotEnFrBatchMultiple: TestDefinition = {
  testId: 'translation-bergamot-en-fr-batch-multiple',
  params: {
    texts: ['How are you?', 'The weather is nice.', 'Thank you.', 'Goodbye.'],
    resource: 'bergamot-en-fr'
  },
  expectation: { validation: 'contains-any', contains: ['comment', 'temps', 'merci', 'revoir'] },
  steps: nmtBatchSteps(4),
  metadata: {
    category: 'translation-bergamot',
    dependency: 'bergamot-en-fr',
    estimatedDurationMs: 20000
  }
}

export const bergamotEnFrBatchArray: TestDefinition = {
  testId: 'translation-bergamot-en-fr-batch-array',
  params: {
    texts: ['Good morning', 'The weather is nice.', 'Thank you.'],
    resource: 'bergamot-en-fr'
  },
  expectation: { validation: 'contains-any', contains: ['bonjour', 'matin', 'temps', 'merci'] },
  steps: nmtBatchSteps(3),
  metadata: {
    category: 'translation-bergamot',
    dependency: 'bergamot-en-fr',
    estimatedDurationMs: 20000
  }
}

// --- EN → ES (bergamot-en-es) ---

export const bergamotEnEsBasic = createBergamotTest(
  'translation-bergamot-en-es-basic',
  'Hello, how are you today?',
  'bergamot-en-es',
  { validation: 'contains-any', contains: ['hola', 'cómo', 'estás', 'hoy'] },
  15000,
  ['smoke']
)

export const bergamotEnEsLongText = createBergamotTest(
  'translation-bergamot-en-es-long-text',
  'The weather is beautiful today. I decided to go for a walk in the park.',
  'bergamot-en-es',
  { validation: 'contains-any', contains: ['tiempo', 'parque', 'paseo', 'hermoso'] },
  20000
)

export const bergamotEnEsQuestion = createBergamotTest(
  'translation-bergamot-en-es-question',
  'Where is the nearest hospital?',
  'bergamot-en-es',
  { validation: 'contains-any', contains: ['hospital', 'dónde', 'cercano'] }
)

export const bergamotEnEsStreaming = createBergamotTest(
  'translation-bergamot-en-es-streaming',
  'Good morning, how are you?',
  'bergamot-en-es',
  { validation: 'contains-any', contains: ['buenos', 'días', 'cómo'] }
)

// --- ES → IT via EN pivot (bergamot-es-it-pivot) ---

export const bergamotPivotBasic = createBergamotTest(
  'translation-bergamot-pivot-basic',
  'Era una mañana soleada cuando María decidió visitar el mercado local.',
  'bergamot-es-it-pivot',
  {
    validation: 'contains-any',
    contains: ['mattina', 'sole', 'maria', 'mercato', 'locale', 'visita']
  },
  30000
)

export const bergamotPivotStreaming = createBergamotTest(
  'translation-bergamot-pivot-streaming',
  'Buenos días, ¿cómo estás hoy?',
  'bergamot-es-it-pivot',
  { validation: 'contains-any', contains: ['buon', 'giorno', 'come', 'stai', 'oggi'] },
  30000
)

export const translationBergamotTests = [
  // EN → FR
  bergamotEnFrBasic,
  bergamotEnFrLongText,
  bergamotEnFrShortText,
  bergamotEnFrSpecialChars,
  bergamotEnFrQuestion,
  bergamotEnFrNumbers,
  bergamotEnFrEmptyText,
  bergamotEnFrStreaming,
  bergamotEnFrStats,
  bergamotEnFrBatchBasic,
  bergamotEnFrBatchMultiple,
  bergamotEnFrBatchArray,
  // EN → ES
  bergamotEnEsBasic,
  bergamotEnEsLongText,
  bergamotEnEsQuestion,
  bergamotEnEsStreaming,
  // ES → IT via EN pivot
  bergamotPivotBasic,
  bergamotPivotStreaming
]

/**
 * Attach the body to every definition that is one translation. A test naming
 * several texts, or comparing two runs, keeps its hand-written body.
 */
for (const test of translationBergamotTests) {
  if (test.steps) continue
  const params = test.params as { text?: unknown; texts?: unknown }
  if (typeof params.text !== 'string' || params.texts !== undefined) continue
  test.steps = nmtSteps(String(test.metadata?.dependency ?? ''))
}
