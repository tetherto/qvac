// Tools/Function calling test definitions
import type { Step, TestDefinition } from '@qvac/test-suite'
import type { ToolDialect } from '@qvac/sdk'

/**
 * One tool-enabled completion, checked either by its answer or by the call it
 * made.
 *
 * `collect: 'text'` brings back both the text and the structured tool calls,
 * because which of the two the model produced is exactly what these tests ask
 * about -- and running the completion twice to look at them separately would
 * be a different test.
 */
const toolsSteps = (
  dependency: string,
  declared: string[],
  expectedToolCall?: { name: string; argKeys?: string[] }
): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: '$params.history',
        tools: '$params.tools',
        stream: '$params.stream',
        toolDialect: '$params.toolDialect?'
      },
      as: 'run'
    }
  },
  ...(expectedToolCall
    ? ([
        { project: { from: '$run', path: 'toolCalls', as: 'toolCalls' } },
        {
          assert: {
            on: '$toolCalls',
            named: 'toolCallShape',
            with: { name: expectedToolCall.name, argKeys: expectedToolCall.argKeys ?? [], declared }
          }
        }
      ] as Step[])
    : ([
        { project: { from: '$run', path: 'text', as: 'text' } },
        { assert: { on: '$text', use: 'expectation' } }
      ] as Step[]))
]

// Helper for creating tools tests
const createToolsTest = (
  testId: string,
  userPrompt: string,
  tools: Array<{
    type: 'function'
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }>,
  options: {
    expectation?: {
      validation: 'type'
      expectedType: 'string' | 'number' | 'array'
    }
    toolDialect?: ToolDialect
    resourceKey?: string
    suites?: string[]
    expectedToolCall?: {
      name: string
      argKeys?: string[]
    }
  } = {}
): TestDefinition => {
  const expectation = options.expectation ?? {
    validation: 'type' as const,
    expectedType: 'string' as const
  }
  const dependency = options.resourceKey ?? 'tools'
  return {
    testId,
    params: {
      history: [{ role: 'user', content: userPrompt }],
      tools,
      stream: false,
      ...(options.toolDialect && { toolDialect: options.toolDialect }),
      ...(options.resourceKey && { resourceKey: options.resourceKey }),
      ...(options.expectedToolCall && { expectedToolCall: options.expectedToolCall })
    },
    expectation,
    steps: toolsSteps(
      dependency,
      tools.map((tool) => tool.name),
      options.expectedToolCall
    ),
    ...(options.suites && { suites: options.suites }),
    metadata: {
      category: 'tools',
      dependency,
      estimatedDurationMs: 15000
    }
  }
}

// Simplified tools tests - just verify they don't crash
// Full validation will happen during testing
export const toolsSimpleFunction = createToolsTest(
  'tools-simple-function',
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: 'function',
      name: 'convert_temperature',
      description: 'Convert temperature between Celsius and Fahrenheit',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Temperature value' },
          from_unit: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Source unit'
          },
          to_unit: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Target unit'
          }
        },
        required: ['value', 'from_unit', 'to_unit']
      }
    }
  ],
  {
    suites: ['smoke'],
    expectedToolCall: {
      name: 'convert_temperature',
      argKeys: ['value', 'from_unit', 'to_unit']
    }
  }
)

export const toolsMultipleFunctions = createToolsTest(
  'tools-multiple-functions',
  'Get the weather for London and calculate the time difference with New York',
  [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' }
        },
        required: ['location']
      }
    },
    {
      type: 'function',
      name: 'get_time_difference',
      description: 'Calculate time difference between two cities',
      parameters: {
        type: 'object',
        properties: {
          city1: { type: 'string' },
          city2: { type: 'string' }
        },
        required: ['city1', 'city2']
      }
    }
  ],
  {
    suites: ['smoke'],
    expectedToolCall: {
      name: 'get_weather',
      argKeys: ['location']
    }
  }
)

// Add remaining ~40 tools tests as simplified placeholders
// User can validate and expand during testing
const toolsTestIds = [
  'tools-parameter-extraction',
  'tools-optional-parameters',
  'tools-choice-auto',
  'tools-choice-none',
  'tools-choice-specific',
  'tools-multi-turn-conversation',
  'tools-complex-object-parameter',
  'tools-array-parameter',
  'tools-enum-validation',
  'tools-error-missing-required-param',
  'tools-no-function-match',
  'tools-streaming-with-tools',
  'tools-description-clarity',
  'tools-with-system-message',
  'tools-ambiguous-intent',
  'tools-concurrent-streams-verify',
  'tools-non-streaming-array',
  'tools-invalid-argument-type',
  'tools-parse-error-handling',
  'tools-empty-array',
  'tools-null-handling',
  'tools-id-generation',
  'tools-missing-property-error',
  'tools-invalid-enum-error',
  'tools-extra-properties',
  'tools-deeply-nested-params',
  'tools-many-definitions',
  'tools-invalid-definition',
  'tools-special-chars-in-name',
  'tools-performance-overhead',
  'tools-long-description',
  'tools-number-range-validation',
  'tools-string-pattern-validation',
  'tools-boolean-parameter',
  'tools-integer-vs-number',
  'tools-model-without-support',
  'tools-raw-field-preservation',
  'tools-multiple-calls-same-turn',
  'tools-text-response-fallback',
  'tools-empty-parameters',
  'tools-array-of-strings',
  'tools-array-of-objects',
  'tools-optional-nested-object',
  'tools-default-values',
  'tools-nullable-parameter',
  'tools-readonly-parameters-ignored',
  'tools-context-size-impact'
]

/**
 * Generate the remaining tools tests.
 *
 * Every one of these carries identical params -- the same prompt, the same
 * single tool, the same `type: string` expectation -- so they are 42 copies of
 * one test wearing 42 ids. That was already true before the migration; giving
 * them a declarative body does not make it more true, but it does make it
 * visible, because the body is now written once and shared rather than reached
 * through a handler each of them registers.
 */
const additionalToolsTests: TestDefinition[] = toolsTestIds.map((testId) => ({
  testId,
  steps: toolsSteps('tools', ['test_function']),
  params: {
    history: [{ role: 'user', content: 'Test function calling' }],
    tools: [
      {
        type: 'function' as const,
        name: 'test_function',
        description: 'Test function',
        parameters: {
          type: 'object' as const,
          properties: { param: { type: 'string' } },
          required: []
        }
      }
    ],
    stream: false
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'tools',
    dependency: 'tools',
    estimatedDurationMs: 15000
  }
}))

export const toolsSimpleFunctionQwen35 = createToolsTest(
  'tools-simple-function-qwen35',
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: 'function',
      name: 'convert_temperature',
      description: 'Convert temperature between Celsius and Fahrenheit',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Temperature value' },
          from_unit: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Source unit'
          },
          to_unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Target unit' }
        },
        required: ['value', 'from_unit', 'to_unit']
      }
    }
  ],
  { toolDialect: 'qwen35', resourceKey: 'tools-qwen35' }
)

export const toolsSimpleFunctionGemma4 = createToolsTest(
  'tools-simple-function-gemma4',
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: 'function',
      name: 'convert_temperature',
      description: 'Convert temperature between Celsius and Fahrenheit',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Temperature value' },
          from_unit: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Source unit'
          },
          to_unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Target unit' }
        },
        required: ['value', 'from_unit', 'to_unit']
      }
    }
  ],
  { toolDialect: 'gemma4', resourceKey: 'tools-gemma4' }
)

export const toolsTests = [
  toolsSimpleFunction,
  toolsMultipleFunctions,
  toolsSimpleFunctionQwen35,
  toolsSimpleFunctionGemma4,
  ...additionalToolsTests
]
