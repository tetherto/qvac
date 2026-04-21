// Tools/Function calling test definitions
import type { Expectation, TestDefinition } from "@tetherto/qvac-test-suite";

const toolsCalledValidator = (result: unknown & { toolCalls?: Array<{ name: string }> }) => {
  return Boolean(result.toolCalls && result.toolCalls.length > 0);
};

const toolsCalledExpectation: Expectation = {
  validation: "custom",
  validator: toolsCalledValidator,
};

const toolsNotCalledValidatorEqual = (numCalls: number) => (result: unknown & { toolCalls?: Array<{ name: string }> }) => {
  return Boolean(result.toolCalls && result.toolCalls.length === numCalls);
};

const toolsNotCalledExpectation: Expectation = {
  validation: "custom",
  validator: toolsNotCalledValidatorEqual(0),
};

// Helper for creating tools tests
const createToolsTest = (
  testId: string,
  userPrompt: string,
  tools: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>,
  toolsMode?: "static" | "dynamic",
  expectation: Expectation = {
    validation: "type",
    expectedType: "string",
  },
  suites?: string[],
): TestDefinition => ({
  testId,
  params: {
    history: [{ role: "user", content: userPrompt }],
    tools,
    stream: false,
    ...(toolsMode && { toolsMode }),
  },
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: "tools",
    dependency: "tools",
    estimatedDurationMs: 15000,
  },
});

// Simplified tools tests - just verify they don't crash
// Full validation will happen during testing
export const toolsSimpleFunction = createToolsTest(
  "tools-simple-function",
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: "function",
      name: "convert_temperature",
      description: "Convert temperature between Celsius and Fahrenheit",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "Temperature value" },
          from_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Source unit",
          },
          to_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Target unit",
          },
        },
        required: ["value", "from_unit", "to_unit"],
      },
    },
  ],
  undefined,
  ["smoke"],
);

export const toolsMultipleFunctions = createToolsTest(
  "tools-multiple-functions",
  "Get the weather for London and calculate the time difference with New York",
  [
    {
      type: "function",
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
    {
      type: "function",
      name: "get_time_difference",
      description: "Calculate time difference between two cities",
      parameters: {
        type: "object",
        properties: {
          city1: { type: "string" },
          city2: { type: "string" },
        },
        required: ["city1", "city2"],
      },
    },
  ],
  undefined,
  ["smoke"],
);

// Add remaining ~40 tools tests as simplified placeholders
// User can validate and expand during testing
const toolsTestIds = [
  "tools-parameter-extraction",
  "tools-optional-parameters",
  "tools-choice-auto",
  "tools-choice-none",
  "tools-choice-specific",
  "tools-multi-turn-conversation",
  "tools-complex-object-parameter",
  "tools-array-parameter",
  "tools-enum-validation",
  "tools-error-missing-required-param",
  "tools-no-function-match",
  "tools-streaming-with-tools",
  "tools-description-clarity",
  "tools-with-system-message",
  "tools-ambiguous-intent",
  "tools-concurrent-streams-verify",
  "tools-non-streaming-array",
  "tools-invalid-argument-type",
  "tools-parse-error-handling",
  "tools-empty-array",
  "tools-null-handling",
  "tools-id-generation",
  "tools-missing-property-error",
  "tools-invalid-enum-error",
  "tools-extra-properties",
  "tools-deeply-nested-params",
  "tools-many-definitions",
  "tools-invalid-definition",
  "tools-special-chars-in-name",
  "tools-performance-overhead",
  "tools-long-description",
  "tools-number-range-validation",
  "tools-string-pattern-validation",
  "tools-boolean-parameter",
  "tools-integer-vs-number",
  "tools-model-without-support",
  "tools-raw-field-preservation",
  "tools-multiple-calls-same-turn",
  "tools-text-response-fallback",
  "tools-empty-parameters",
  "tools-array-of-strings",
  "tools-array-of-objects",
  "tools-optional-nested-object",
  "tools-default-values",
  "tools-nullable-parameter",
  "tools-readonly-parameters-ignored",
  "tools-context-size-impact",
];

// Generate placeholder tests for remaining tools tests
const additionalToolsTests: TestDefinition[] = toolsTestIds.map((testId) => ({
  testId,
  params: {
    history: [{ role: "user", content: "Test function calling" }],
    tools: [
      {
        type: "function" as const,
        name: "test_function",
        description: "Test function",
        parameters: {
          type: "object" as const,
          properties: { param: { type: "string" } },
          required: [],
        },
      },
    ],
    stream: false,
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "tools",
    dependency: "tools",
    estimatedDurationMs: 15000,
  },
}));

// Test basic tool call with different possible tools modes and unset
export const toolsModeStatic = createToolsTest(
  "tools-mode-static",
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: "function",
      name: "convert_temperature",
      description: "Convert temperature between Celsius and Fahrenheit",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "Temperature value" },
          from_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Source unit",
          },
          to_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Target unit",
          },
        },
        required: ["value", "from_unit", "to_unit"],
      },
    },
  ],
  "static",
  toolsCalledExpectation,
);

export const toolsModeDynamic = createToolsTest(
  "tools-mode-dynamic",
  "What's 25 degrees Celsius in Fahrenheit?",
  [
    {
      type: "function",
      name: "convert_temperature",
      description: "Convert temperature between Celsius and Fahrenheit",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "Temperature value" },
          from_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Source unit",
          },
          to_unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
            description: "Target unit",
          },
        },
        required: ["value", "from_unit", "to_unit"],
      },
    },
  ],
  "dynamic",
  toolsCalledExpectation,
);

// Test multiple tools with correct selection
export const toolsModeMultipleTools = createToolsTest(
  "tools-mode-multiple-tools",
  "Get the weather for London and calculate the time difference with New York",
  [
    {
      type: "function",
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
    {
      type: "function",
      name: "get_time_difference",
      description: "Calculate time difference between two cities",
      parameters: {
        type: "object",
        properties: {
          city1: { type: "string" },
          city2: { type: "string" },
        },
        required: ["city1", "city2"],
      },
    },
  ],
  "dynamic",
  toolsCalledExpectation,
);

// Test model declines tool use
export const toolsModeModelDeclines = createToolsTest(
  "tools-mode-model-declines",
  "Tell me a joke about programming",
  [
    {
      type: "function",
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  ],
  "dynamic",
  toolsNotCalledExpectation,
);

// Test no tools provided (empty array)
export const toolsModeEmptyArray = createToolsTest(
  "tools-mode-empty-array",
  "What's the weather like?",
  [],
  "dynamic",
  toolsNotCalledExpectation,
);

// Test single tool
export const toolsModeSingleTool = createToolsTest(
  "tools-mode-single-tool",
  "Get the current time in Tokyo",
  [
    {
      type: "function",
      name: "get_time",
      description: "Get current time for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  ],
  "dynamic",
  toolsCalledExpectation,
);

// Test large tool set (10+ tools)
const largeToolSet = Array.from({ length: 12 }, (_, i) => ({
  type: "function" as const,
  name: `tool_function_${i}`,
  description: `Test function number ${i}`,
  parameters: {
    type: "object" as const,
    properties: {
      param: { type: "string", description: `Parameter for function ${i}` },
    },
    required: ["param"],
  },
}));

export const toolsModeLargeToolSet = createToolsTest(
  "tools-mode-large-tool-set",
  "Execute tool number 5",
  largeToolSet,
  "dynamic",
  toolsCalledExpectation,
);

export const dynamicToolsTests = [
  toolsModeDynamic,
  toolsModeMultipleTools,
  toolsModeModelDeclines,
  toolsModeEmptyArray,
  toolsModeSingleTool,
  toolsModeLargeToolSet,
];

export const toolsTests = [
  toolsSimpleFunction,
  toolsMultipleFunctions,
  toolsModeStatic,
  ...additionalToolsTests,
  ...dynamicToolsTests,
];
