// Tools/Function calling test definitions
import type { Step, TestDefinition } from '@qvac/test-suite'
import type { ToolDialect } from './wire-types.js'

/** One tool-enabled completion, checked either by its answer or by the call it made. */
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
        toolDialect: '$params.toolDialect?',
        generationParams: '$params.generationParams?'
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

/** Greedy decoding with a fixed seed, so a model's choice is the same on every run. */
const DETERMINISTIC = { temp: 0, seed: 42 }

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
    generationParams?: Record<string, unknown>
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
      ...(options.generationParams && { generationParams: options.generationParams }),
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

// Placeholders: each only checks that a tool-enabled completion returns a string. A real test
// replaces one when it lands; the ones below the placeholders already have.
const toolsTestIds = [
  'tools-parameter-extraction',
  'tools-optional-parameters',
  'tools-complex-object-parameter',
  'tools-array-parameter',
  'tools-enum-validation',
  'tools-error-missing-required-param',
  'tools-no-function-match',
  'tools-description-clarity',
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

/** Generate the remaining tools tests. */
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
  {
    toolDialect: 'qwen35',
    resourceKey: 'tools-qwen35',
    generationParams: DETERMINISTIC,
    expectedToolCall: {
      name: 'convert_temperature',
      argKeys: ['value', 'from_unit', 'to_unit']
    }
  }
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
  {
    toolDialect: 'gemma4',
    resourceKey: 'tools-gemma4',
    generationParams: DETERMINISTIC,
    expectedToolCall: {
      name: 'convert_temperature',
      argKeys: ['value', 'from_unit', 'to_unit']
    }
  }
)

// ── Tool-calling contract ──────────────────────────────────────────────────
//
// Real-model checks of what a client relies on: `tool_choice`, `parallel_tool_calls`, the
// streamed `toolCall` events, and the two-turn loop where the client runs the tool and the next
// turn answers from its result. Every test decodes greedily with a fixed seed.

type ToolDefinition = {
  type: 'function'
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

const GET_WEATHER: ToolDefinition = {
  type: 'function',
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string', description: 'City name' } },
    required: ['location']
  }
}

const GET_TIME_DIFFERENCE: ToolDefinition = {
  type: 'function',
  name: 'get_time_difference',
  description: 'Calculate time difference between two cities',
  parameters: {
    type: 'object',
    properties: { city1: { type: 'string' }, city2: { type: 'string' } },
    required: ['city1', 'city2']
  }
}

const LOOKUP_TRACKING_CODE: ToolDefinition = {
  type: 'function',
  name: 'lookup_tracking_code',
  description: 'Look up the shipment tracking code of an order',
  parameters: {
    type: 'object',
    properties: { order_id: { type: 'string', description: 'Order number' } },
    required: ['order_id']
  }
}

const WEATHER_PROMPT = "What's the weather in London right now?"

/**
 * A code the model cannot know or guess. A turn-2 answer that contains it read the tool
 * result the client appended.
 */
const TRACKING_CODEWORD = 'QX-PELICAN-5823'

/** Tool markup that must never reach the visible content: Hermes/Qwen, Gemma, Llama 3. */
const RAW_TOOL_MARKUP = ['<tool_call>', '</tool_call>', '<|tool_call', '<function=', '"arguments"']

const toolsMetadata = (dependency: string, estimatedDurationMs = 20000) => ({
  category: 'tools',
  dependency,
  estimatedDurationMs
})

/** One tool-enabled completion, bound as `$run`, with its tool calls projected to `$calls`. */
const toolTurn = (dependency: string): Step[] => [
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
        toolDialect: '$params.toolDialect?',
        generationParams: '$params.generationParams'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'toolCalls', as: 'calls' } }
]

/** A call to `name` with these argument keys; `exclusive` also rejects any call outside `declared`. */
const assertToolCall = (
  name: string,
  argKeys: string[],
  declared: string[],
  exclusive = false
): Step => ({
  assert: {
    on: '$calls',
    named: 'toolCallShape',
    with: { name, argKeys, declared, ...(exclusive && { exclusive }) }
  }
})

const assertCallCount = (length: number): Step => ({
  assert: { on: '$calls', named: 'lengthIs', with: { length } }
})

export const toolsChoiceAuto: TestDefinition = {
  testId: 'tools-choice-auto',
  params: {
    history: [{ role: 'user', content: WEATHER_PROMPT }],
    tools: [GET_WEATHER],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'auto' }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [...toolTurn('tools'), assertToolCall('get_weather', ['location'], ['get_weather'])]
}

/**
 * A prompt no tool answers: only the forced grammar can make this a call. Parallel calls stay
 * allowed, so the count is not pinned; every call must still be to the declared tool.
 */
export const toolsChoiceRequired: TestDefinition = {
  testId: 'tools-choice-required',
  params: {
    history: [{ role: 'user', content: 'Say hello to me in one short sentence.' }],
    tools: [GET_WEATHER],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'required' }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [...toolTurn('tools'), assertToolCall('get_weather', ['location'], ['get_weather'], true)]
}

/** The prompt asks about the weather; the request forces the other tool. */
export const toolsChoiceSpecific: TestDefinition = {
  testId: 'tools-choice-specific',
  params: {
    history: [{ role: 'user', content: WEATHER_PROMPT }],
    tools: [GET_WEATHER, GET_TIME_DIFFERENCE],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'get_time_difference' }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [
    ...toolTurn('tools'),
    // Every call must be to the named tool, not only the first.
    assertToolCall('get_time_difference', ['city1', 'city2'], ['get_time_difference'], true)
  ]
}

export const toolsChoiceNone: TestDefinition = {
  testId: 'tools-choice-none',
  params: {
    history: [{ role: 'user', content: WEATHER_PROMPT }],
    tools: [GET_WEATHER],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'none' }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [...toolTurn('tools'), assertCallCount(0)]
}

export const toolsChoiceRequiredNoTools: TestDefinition = {
  testId: 'tools-choice-required-no-tools',
  params: {
    history: [{ role: 'user', content: WEATHER_PROMPT }],
    tools: [],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'required' }
  },
  expectation: { validation: 'throws-error', errorContains: 'needs at least one tool' },
  metadata: toolsMetadata('tools', 5000),
  steps: [
    { useModel: { deps: ['tools'], as: 'model' } },
    {
      callError: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: '$params.history',
          tools: '$params.tools',
          stream: '$params.stream',
          generationParams: '$params.generationParams'
        },
        as: 'error'
      }
    },
    { project: { from: '$error', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ]
}

/** Two cities invite two calls; `parallel_tool_calls: false` must keep it to one. */
export const toolsParallelDisabled: TestDefinition = {
  testId: 'tools-parallel-disabled',
  params: {
    history: [
      { role: 'user', content: 'What is the weather in London and what is the weather in Paris?' }
    ],
    tools: [GET_WEATHER],
    stream: false,
    generationParams: { ...DETERMINISTIC, tool_choice: 'required', parallel_tool_calls: false }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [
    ...toolTurn('tools'),
    assertCallCount(1),
    assertToolCall('get_weather', ['location'], ['get_weather'])
  ]
}

/** The streamed `toolCall` events are the final's calls, and no raw markup is visible. */
export const toolsStreamingWithTools: TestDefinition = {
  testId: 'tools-streaming-with-tools',
  params: {
    history: [{ role: 'user', content: WEATHER_PROMPT }],
    tools: [GET_WEATHER],
    stream: true,
    generationParams: DETERMINISTIC
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools'),
  steps: [
    { useModel: { deps: ['tools'], as: 'model' } },
    {
      call: {
        method: 'completion',
        collect: 'events',
        params: {
          modelId: '$model',
          history: '$params.history',
          tools: '$params.tools',
          stream: '$params.stream',
          generationParams: '$params.generationParams'
        },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'toolCalls', as: 'calls' } },
    assertToolCall('get_weather', ['location'], ['get_weather']),
    {
      assert: {
        on: '$run',
        named: 'streamedToolCallsMatchFinal',
        with: { forbidden: RAW_TOOL_MARKUP }
      }
    }
  ]
}

/**
 * Turn 1 calls the tool. The client appends the assistant turn with its `toolCalls` and a `tool`
 * turn holding the result; turn 2 must answer from that result.
 */
const toolLoopSteps = (dependency: string): Step[] => {
  const call = (field: string) => `$turn1.toolCalls[0].${field}`
  return [
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
          generationParams: '$params.generationParams'
        },
        as: 'turn1'
      }
    },
    { project: { from: '$turn1', path: 'toolCalls', as: 'calls' } },
    assertToolCall('lookup_tracking_code', ['order_id'], ['lookup_tracking_code']),
    {
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [
            '$params.history[0]',
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: call('id'), name: call('name'), arguments: call('arguments') }]
            },
            {
              role: 'tool',
              toolCallId: call('id'),
              toolName: call('name'),
              content: '$params.toolResult'
            }
          ],
          tools: '$params.tools',
          stream: '$params.stream',
          generationParams: '$params.generationParams'
        },
        as: 'turn2'
      }
    },
    { project: { from: '$turn2', path: 'text', as: 'answer' } },
    { assert: { on: '$answer', use: 'expectation' } }
  ]
}

const toolLoopTest = (testId: string, stream: boolean): TestDefinition => ({
  testId,
  params: {
    history: [
      {
        role: 'user',
        content:
          'Use the tool to look up the tracking code of order 4417, then tell me the exact code.'
      }
    ],
    tools: [LOOKUP_TRACKING_CODE],
    toolResult: JSON.stringify({ order_id: '4417', tracking_code: TRACKING_CODEWORD }),
    stream,
    generationParams: DETERMINISTIC
  },
  expectation: { validation: 'contains-all', contains: [TRACKING_CODEWORD] },
  metadata: toolsMetadata('tools', 40000),
  steps: toolLoopSteps('tools')
})

export const toolsMultiTurnConversation = toolLoopTest('tools-multi-turn-conversation', false)
export const toolsMultiTurnStreaming = toolLoopTest('tools-multi-turn-streaming', true)

const DEVELOPER_FIRST = [
  { role: 'developer', content: 'You are a weather assistant. Use the tools to answer.' },
  { role: 'user', content: WEATHER_PROMPT }
]

const SYSTEM_AFTER_USER = [
  { role: 'user', content: WEATHER_PROMPT },
  { role: 'system', content: 'Answer in one short sentence.' }
]

/**
 * A history with a system or developer turn the Qwen3.5 chat template rejects, and a forced tool
 * call. The request must make the call or fail; answering in prose would mean the tools were
 * dropped from the prompt without a word.
 */
const qwen35RoleRequiredTest = (
  testId: string,
  history: Array<{ role: string; content: string }>
): TestDefinition => ({
  testId,
  params: {
    history,
    tools: [GET_WEATHER],
    stream: false,
    toolDialect: 'qwen35',
    generationParams: { ...DETERMINISTIC, tool_choice: 'required' }
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools-qwen35'),
  steps: [
    { useModel: { deps: ['tools-qwen35'], as: 'model' } },
    {
      call: {
        method: 'completionOrError',
        collect: 'text',
        params: {
          modelId: '$model',
          history: '$params.history',
          tools: '$params.tools',
          stream: '$params.stream',
          toolDialect: '$params.toolDialect',
          generationParams: '$params.generationParams'
        },
        as: 'run'
      }
    },
    { assert: { on: '$run', named: 'toolCallOrError', with: { declared: ['get_weather'] } } }
  ]
})

/**
 * The same histories with the default `tool_choice`, as an agent client sends them. The prompt
 * asks for the tool, so the model must call it: an answer in prose means the tools never reached
 * the prompt.
 */
const qwen35RoleAutoTest = (
  testId: string,
  history: Array<{ role: string; content: string }>
): TestDefinition => ({
  testId,
  params: {
    history,
    tools: [GET_WEATHER],
    stream: false,
    toolDialect: 'qwen35',
    generationParams: DETERMINISTIC
  },
  expectation: { validation: 'type', expectedType: 'array' },
  metadata: toolsMetadata('tools-qwen35'),
  steps: [...toolTurn('tools-qwen35'), assertToolCall('get_weather', ['location'], ['get_weather'])]
})

export const toolsQwen35DeveloperMessage = qwen35RoleRequiredTest(
  'tools-qwen35-developer-message',
  DEVELOPER_FIRST
)
export const toolsQwen35SystemAfterUser = qwen35RoleRequiredTest(
  'tools-qwen35-system-after-user',
  SYSTEM_AFTER_USER
)
export const toolsQwen35DeveloperMessageAuto = qwen35RoleAutoTest(
  'tools-qwen35-developer-message-auto',
  DEVELOPER_FIRST
)
export const toolsQwen35SystemAfterUserAuto = qwen35RoleAutoTest(
  'tools-qwen35-system-after-user-auto',
  SYSTEM_AFTER_USER
)

const contractTests: TestDefinition[] = [
  toolsChoiceAuto,
  toolsChoiceRequired,
  toolsChoiceSpecific,
  toolsChoiceNone,
  toolsChoiceRequiredNoTools,
  toolsParallelDisabled,
  toolsStreamingWithTools,
  toolsMultiTurnConversation,
  toolsMultiTurnStreaming,
  toolsQwen35DeveloperMessage,
  toolsQwen35SystemAfterUser,
  toolsQwen35DeveloperMessageAuto,
  toolsQwen35SystemAfterUserAuto
]

export const toolsTests = [
  toolsSimpleFunction,
  toolsMultipleFunctions,
  toolsSimpleFunctionQwen35,
  toolsSimpleFunctionGemma4,
  ...contractTests,
  ...additionalToolsTests
]
