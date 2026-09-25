import type { Step, TestDefinition } from '@qvac/test-suite'
import type { ToolDialect } from '@qvac/sdk'

interface GenerationParams {
  temp?: number
  seed?: number
  predict?: number
}

interface JsonSchemaResponseFormat {
  type: 'json_schema'
  json_schema: {
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

interface BatchPrompt {
  id?: string
  history: Array<{
    role: string
    content: string
    attachments?: Array<{ path: string }>
  }>
  generationParams?: GenerationParams
  responseFormat?: JsonSchemaResponseFormat
  tools?: Array<{
    type: 'function'
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }>
}

interface BatchCompletionTestParams {
  prompts: BatchPrompt[]
  stream?: boolean
  resourceKey?: string
  toolDialect?: ToolDialect
  expectedById?: Record<string, string[]>
  expectedAnyById?: Record<string, string[]>
  expectedToolCall?: {
    id: string
    name: string
    argKeys?: string[]
    noToolCallIds?: string[]
  }
}

type BatchCompletionExpectation =
  | { validation: 'contains-all' | 'contains-any'; contains: string[] }
  | { validation: 'type'; expectedType: 'string' | 'array' }
  | { validation: 'throws-error'; errorContains: string }

/**
 * The batch call itself, with only the arguments the test sets.
 *
 * `collect: 'all'` folds the run into per-prompt finals *and* the raw event
 * stream: the streaming tests need both, and a second fold would be a second
 * batch.
 */
const batchSteps = (
  dependency: string,
  checks: Step[],
  /**
   * The prompts to send, when they are not `params.prompts` verbatim.
   *
   * A `$ref` inside `params` is data, not a reference: the interpreter
   * resolves the step's own parameters and does not then walk back into the
   * value it just read. A prompt carrying an attachment that the `asset` step
   * resolved therefore has to be built in the step, which is why the vision
   * test names its prompts through a function both it and `params` call.
   */
  prompts: unknown = '$params.prompts'
): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: 'batchCompletion',
      collect: 'all',
      params: {
        modelId: '$model',
        prompts,
        stream: '$params.stream',
        toolDialect: '$params.toolDialect?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'all', as: 'results' } },
  ...checks
]

function createBatchCompletionTest(
  testId: string,
  params: BatchCompletionTestParams,
  expectation: BatchCompletionExpectation,
  estimatedDurationMs = 15000,
  steps?: Step[]
): TestDefinition {
  return {
    testId,
    params,
    expectation,
    ...(steps && { steps }),
    metadata: {
      category: 'batch-completion',
      dependency: params.resourceKey ?? 'llm-batch',
      estimatedDurationMs
    }
  }
}

const deterministic: GenerationParams = { temp: 0, seed: 42, predict: 16 }
const markerDeterministic: GenerationParams = { ...deterministic, predict: 32 }
const visionDeterministic: GenerationParams = {
  temp: 0,
  seed: 42,
  predict: 128
}
const ELEPHANT_IMAGE_TERMS = ['elephant', 'tusk', 'trunk']

function markerResponseFormat(marker: string) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'BatchMarker',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          marker: { type: 'string', enum: [marker] }
        },
        required: ['marker'],
        additionalProperties: false
      }
    }
  } satisfies JsonSchemaResponseFormat
}

export const batchCompletionBasic = createBatchCompletionTest(
  'batch-completion-basic',
  {
    prompts: [
      {
        id: 'first',
        history: [
          {
            role: 'user',
            content: 'Return the JSON object required by the response schema.'
          }
        ],
        generationParams: markerDeterministic,
        responseFormat: markerResponseFormat('first')
      },
      {
        id: 'second',
        history: [
          {
            role: 'user',
            content: 'Return the JSON object required by the response schema.'
          }
        ],
        generationParams: markerDeterministic,
        responseFormat: markerResponseFormat('second')
      }
    ],
    stream: false,
    expectedById: {
      first: ['"first"'],
      second: ['"second"']
    }
  },
  { validation: 'contains-all', contains: ['"first"', '"second"'] },
  15000,
  batchSteps('llm-batch', [
    { assert: { on: '$results', named: 'lengthIs', with: { length: 2 } } },
    {
      assert: {
        on: '$results',
        named: 'textsById',
        with: { expect: { first: ['"first"'], second: ['"second"'] } }
      }
    }
  ])
)

export const batchCompletionStreaming = createBatchCompletionTest(
  'batch-completion-streaming',
  {
    prompts: [
      {
        id: 'stream-first',
        history: [
          {
            role: 'user',
            content: 'Return the JSON object required by the response schema.'
          }
        ],
        generationParams: markerDeterministic,
        responseFormat: markerResponseFormat('stream-first')
      },
      {
        id: 'stream-second',
        history: [
          {
            role: 'user',
            content: 'Return the JSON object required by the response schema.'
          }
        ],
        generationParams: markerDeterministic,
        responseFormat: markerResponseFormat('stream-second')
      }
    ],
    stream: true,
    expectedById: {
      'stream-first': ['"stream-first"'],
      'stream-second': ['"stream-second"']
    }
  },
  { validation: 'contains-all', contains: ['"stream-first"', '"stream-second"'] },
  15000,
  batchSteps('llm-batch', [
    { assert: { on: '$results', named: 'lengthIs', with: { length: 2 } } },
    { project: { from: '$run', path: 'events', as: 'events' } },
    {
      assert: {
        on: '$events',
        named: 'streamedEachId',
        with: { ids: ['stream-first', 'stream-second'] }
      }
    },
    {
      assert: {
        on: '$results',
        named: 'textsById',
        with: {
          expect: { 'stream-first': ['"stream-first"'], 'stream-second': ['"stream-second"'] }
        }
      }
    }
  ])
)

export const batchCompletionEmptyRejected = createBatchCompletionTest(
  'batch-completion-empty-rejected',
  {
    prompts: [],
    stream: false
  },
  { validation: 'throws-error', errorContains: 'prompts' },
  2000,
  [
    { useModel: { deps: ['llm-batch'], as: 'model' } },
    {
      callError: {
        method: 'batchCompletion',
        collect: 'all',
        params: { modelId: '$model', prompts: '$params.prompts', stream: '$params.stream' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ]
)

export const batchCompletionToolCalling = createBatchCompletionTest(
  'batch-completion-tool-calling',
  {
    resourceKey: 'tools-batch',
    prompts: [
      {
        id: 'weather',
        history: [
          {
            role: 'user',
            content:
              'Use the available tool to get the weather for Tokyo. Return only the tool call.'
          }
        ],
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'City name' }
              },
              required: ['city']
            }
          }
        ],
        generationParams: { temp: 0, seed: 42, predict: 96 }
      },
      {
        id: 'plain',
        history: [{ role: 'user', content: 'Reply with only the word PLAIN.' }],
        generationParams: deterministic
      }
    ],
    stream: false,
    expectedToolCall: {
      id: 'weather',
      name: 'get_weather',
      argKeys: ['city'],
      noToolCallIds: ['plain']
    }
  },
  { validation: 'type', expectedType: 'string' },
  20000,
  batchSteps('tools-batch', [
    { project: { from: '$results', path: '[0].final.toolCalls', as: 'calls' } },
    {
      assert: {
        on: '$calls',
        named: 'toolCallShape',
        with: { declared: ['get_weather'], name: 'get_weather', argKeys: ['city'] }
      }
    },
    { assert: { on: '$results', named: 'noToolCallsFor', with: { ids: ['plain'] } } }
  ])
)

/**
 * One prompt with an image, one without, in the same batch.
 *
 * Written as a function of the attachment reference so `params` and the step
 * body cannot drift: `params` records the fixture by name, the step sends
 * whatever the `asset` step resolved it to on this platform.
 */
const visionMixedPrompts = (image: string) => [
  {
    id: 'image',
    history: [
      {
        role: 'user',
        content: 'What animal is in this image? Reply with one word.',
        attachments: [{ path: image }]
      }
    ],
    generationParams: visionDeterministic
  },
  {
    id: 'text',
    history: [{ role: 'user', content: 'Reply with only the word PLAIN.' }],
    generationParams: deterministic
  }
]

export const batchCompletionVisionMixed = createBatchCompletionTest(
  'batch-completion-vision-mixed',
  {
    resourceKey: 'vision-batch',
    prompts: visionMixedPrompts('shared-test-data/images/elephant.jpg'),
    stream: false,
    expectedAnyById: {
      image: ELEPHANT_IMAGE_TERMS
    }
  },
  { validation: 'contains-any', contains: ELEPHANT_IMAGE_TERMS },
  30000,
  [
    { asset: { kind: 'image', file: 'elephant.jpg', form: 'path', as: 'image' } },
    ...batchSteps(
      'vision-batch',
      [
        {
          assert: {
            on: '$results',
            named: 'textsById',
            with: { expect: { image: ELEPHANT_IMAGE_TERMS }, mode: 'any' }
          }
        }
      ],
      visionMixedPrompts('$image')
    )
  ]
)

export const batchCompletionVisionMissingImage = createBatchCompletionTest(
  'batch-completion-vision-missing-image',
  {
    resourceKey: 'vision-batch',
    prompts: [
      {
        id: 'missing',
        history: [
          {
            role: 'user',
            content: 'What is in this image?',
            attachments: [{ path: 'shared-test-data/images/nonexistent.jpg' }]
          }
        ],
        generationParams: visionDeterministic
      }
    ],
    stream: false
  },
  { validation: 'throws-error', errorContains: 'not found' },
  10000,
  [
    { useModel: { deps: ['vision-batch'], as: 'model' } },
    {
      callError: {
        method: 'batchCompletion',
        collect: 'all',
        params: { modelId: '$model', prompts: '$params.prompts', stream: '$params.stream' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ]
)

export const batchCompletionTests = [
  batchCompletionBasic,
  batchCompletionStreaming,
  batchCompletionEmptyRejected,
  batchCompletionToolCalling,
  batchCompletionVisionMixed,
  batchCompletionVisionMissingImage
]
