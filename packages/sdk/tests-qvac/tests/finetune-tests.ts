import type { TestDefinition } from "@tetherto/qvac-test-suite";

function createFinetuneTest(
  testId: string,
  params: Record<string, unknown>,
  estimatedDurationMs: number,
  suites?: string[],
): TestDefinition {
  return {
    testId,
    params,
    expectation: { validation: "type", expectedType: "string" },
    ...(suites && { suites }),
    metadata: {
      category: "finetune",
      dependency: "finetune-llm",
      estimatedDurationMs,
    },
  };
}

export const finetuneStartComplete = createFinetuneTest(
  "finetune-start-complete",
  {
    numberOfEpochs: 1,
  },
  60000,
  ["smoke"],
);

export const finetunePauseResume = createFinetuneTest(
  "finetune-pause-resume",
  {
    numberOfEpochs: 1,
    pauseAfterGlobalSteps: 2,
  },
  90000,
);

export const finetuneProgressStreaming = createFinetuneTest(
  "finetune-progress-streaming",
  {
    numberOfEpochs: 1,
    minimumProgressEvents: 1,
  },
  60000,
);

export const finetuneErrorCases = createFinetuneTest(
  "finetune-error-cases",
  {
    invalidModelId: "missing-finetune-model",
  },
  30000,
);

export const finetuneProgressZeroDrop = createFinetuneTest(
  "finetune-progress-zero-drop",
  {
    numberOfEpochs: 2,
  },
  120000,
);

export const finetuneTests = [
  finetuneStartComplete,
  finetunePauseResume,
  finetuneProgressStreaming,
  finetuneErrorCases,
  finetuneProgressZeroDrop,
];
