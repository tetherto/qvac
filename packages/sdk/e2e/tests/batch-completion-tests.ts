import type { TestDefinition } from "@tetherto/qvac-test-suite";
import type { ToolDialect } from "@qvac/sdk";

interface GenerationParams {
  temp?: number;
  seed?: number;
  predict?: number;
}

interface BatchPrompt {
  id?: string;
  history: Array<{ role: string; content: string }>;
  generationParams?: GenerationParams;
  tools?: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>;
}

interface BatchCompletionTestParams {
  prompts: BatchPrompt[];
  stream?: boolean;
  resourceKey?: string;
  toolDialect?: ToolDialect;
  expectedToolCall?: {
    id: string;
    name: string;
    argKeys?: string[];
    noToolCallIds?: string[];
  };
}

type BatchCompletionExpectation =
  | { validation: "contains-all" | "contains-any"; contains: string[] }
  | { validation: "type"; expectedType: "string" | "array" }
  | { validation: "throws-error"; errorContains: string };

function createBatchCompletionTest(
  testId: string,
  params: BatchCompletionTestParams,
  expectation: BatchCompletionExpectation,
  estimatedDurationMs = 15000,
): TestDefinition {
  return {
    testId,
    params,
    expectation,
    metadata: {
      category: "batch-completion",
      dependency: params.resourceKey ?? "llm-batch",
      estimatedDurationMs,
    },
  };
}

const deterministic: GenerationParams = { temp: 0, seed: 42, predict: 16 };

export const batchCompletionBasic = createBatchCompletionTest(
  "batch-completion-basic",
  {
    prompts: [
      {
        id: "apple",
        history: [{ role: "user", content: "Reply with only the word APPLE." }],
        generationParams: deterministic,
      },
      {
        id: "banana",
        history: [
          { role: "user", content: "Reply with only the word BANANA." },
        ],
        generationParams: deterministic,
      },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["APPLE", "BANANA"] },
);

export const batchCompletionStreaming = createBatchCompletionTest(
  "batch-completion-streaming",
  {
    prompts: [
      {
        id: "four",
        history: [
          {
            role: "user",
            content: "What is 2+2? Answer with only the number.",
          },
        ],
        generationParams: deterministic,
      },
      {
        id: "six",
        history: [
          {
            role: "user",
            content: "What is 3+3? Answer with only the number.",
          },
        ],
        generationParams: deterministic,
      },
    ],
    stream: true,
  },
  { validation: "contains-all", contains: ["4", "6"] },
);

export const batchCompletionEmptyRejected = createBatchCompletionTest(
  "batch-completion-empty-rejected",
  {
    prompts: [],
    stream: false,
  },
  { validation: "throws-error", errorContains: "prompts" },
  2000,
);

export const batchCompletionToolCalling = createBatchCompletionTest(
  "batch-completion-tool-calling",
  {
    resourceKey: "tools-batch",
    prompts: [
      {
        id: "weather",
        history: [
          {
            role: "user",
            content:
              "Use the available tool to get the weather for Tokyo. Return only the tool call.",
          },
        ],
        tools: [
          {
            type: "function",
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name" },
              },
              required: ["city"],
            },
          },
        ],
        generationParams: { temp: 0, seed: 42, predict: 96 },
      },
      {
        id: "plain",
        history: [{ role: "user", content: "Reply with only the word PLAIN." }],
        generationParams: deterministic,
      },
    ],
    stream: false,
    expectedToolCall: {
      id: "weather",
      name: "get_weather",
      argKeys: ["city"],
      noToolCallIds: ["plain"],
    },
  },
  { validation: "type", expectedType: "string" },
  20000,
);

export const batchCompletionTests = [
  batchCompletionBasic,
  batchCompletionStreaming,
  batchCompletionEmptyRejected,
  batchCompletionToolCalling,
];
