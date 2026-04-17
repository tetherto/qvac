import type { TestDefinition } from "@tetherto/qvac-test-suite";

interface LifecycleTestOptions {
  dependency?: string;
  estimatedDurationMs?: number;
  suites?: string[];
}

const createLifecycleTest = (
  testId: string,
  options: LifecycleTestOptions = {},
): TestDefinition => ({
  testId,
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  ...(options.suites ? { suites: options.suites } : {}),
  metadata: {
    category: "lifecycle",
    dependency: options.dependency ?? "none",
    estimatedDurationMs: options.estimatedDurationMs ?? 30000,
  },
});

export const lifecycleSuspendResumeBasic = createLifecycleTest("lifecycle-suspend-resume-basic", { suites: ["smoke"] });
export const lifecycleSuspendIdempotent = createLifecycleTest("lifecycle-suspend-idempotent");
export const lifecycleResumeIdempotent = createLifecycleTest("lifecycle-resume-idempotent");
export const lifecycleSuspendResumeInference = createLifecycleTest("lifecycle-suspend-resume-inference", { dependency: "llm", estimatedDurationMs: 60000 });
export const lifecycleRapidToggle = createLifecycleTest("lifecycle-rapid-toggle");
export const lifecycleSuspendDuringInference = createLifecycleTest("lifecycle-suspend-during-inference", { dependency: "llm", estimatedDurationMs: 60000 });

export const lifecycleTests = [
  lifecycleSuspendResumeBasic,
  lifecycleSuspendIdempotent,
  lifecycleResumeIdempotent,
  lifecycleSuspendResumeInference,
  lifecycleRapidToggle,
  lifecycleSuspendDuringInference,
] as const;
