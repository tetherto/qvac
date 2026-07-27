import type { TestDefinition } from '@tetherto/qvac-test-suite'
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

function createBatchCompletionTest(
  testId: string,
  params: BatchCompletionTestParams,
  expectation: BatchCompletionExpectation,
  estimatedDurationMs = 15000
): TestDefinition {
  return {
    testId,
    params,
    expectation,
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
  predict: 48
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
  { validation: 'contains-all', contains: ['"first"', '"second"'] }
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
  { validation: 'contains-all', contains: ['"stream-first"', '"stream-second"'] }
)

export const batchCompletionEmptyRejected = createBatchCompletionTest(
  'batch-completion-empty-rejected',
  {
    prompts: [],
    stream: false
  },
  { validation: 'throws-error', errorContains: 'prompts' },
  2000
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
  20000
)

export const batchCompletionVisionMixed = createBatchCompletionTest(
  'batch-completion-vision-mixed',
  {
    resourceKey: 'vision-batch',
    prompts: [
      {
        id: 'image',
        history: [
          {
            role: 'user',
            content: 'What animal is in this image? Reply with one word.',
            attachments: [{ path: 'shared-test-data/images/elephant.jpg' }]
          }
        ],
        generationParams: visionDeterministic
      },
      {
        id: 'text',
        history: [{ role: 'user', content: 'Reply with only the word PLAIN.' }],
        generationParams: deterministic
      }
    ],
    stream: false,
    expectedAnyById: {
      image: ELEPHANT_IMAGE_TERMS
    }
  },
  { validation: 'contains-any', contains: ELEPHANT_IMAGE_TERMS },
  30000
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
  10000
)

export const batchCompletionTests = [
  batchCompletionBasic,
  batchCompletionStreaming,
  batchCompletionEmptyRejected,
  batchCompletionToolCalling,
  batchCompletionVisionMixed,
  batchCompletionVisionMissingImage
]
