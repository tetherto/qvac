import type { TestDefinition } from "@tetherto/qvac-test-suite";

interface GenerationParams {
  temp?: number;
  seed?: number;
  predict?: number;
}

interface BatchPrompt {
  id?: string;
  history: Array<{ role: string; content: string }>;
  generationParams?: GenerationParams;
}

interface BatchCompletionTestParams {
  prompts: BatchPrompt[];
  stream?: boolean;
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
      dependency: "llm-batch",
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
          { role: "user", content: "What is 2+2? Answer with only the number." },
        ],
        generationParams: deterministic,
      },
      {
        id: "six",
        history: [
          { role: "user", content: "What is 3+3? Answer with only the number." },
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

export const batchCompletionTests = [
  batchCompletionBasic,
  batchCompletionStreaming,
  batchCompletionEmptyRejected,
];
