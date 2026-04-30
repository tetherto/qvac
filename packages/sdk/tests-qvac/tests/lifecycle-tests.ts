import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createLifecycleTest = (
  testId: string,
  dependency: string = "none",
  estimatedDurationMs: number = 30000,
  suites?: string[],
): TestDefinition => ({
  testId,
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  ...(suites && { suites }),
  metadata: { category: "lifecycle", dependency, estimatedDurationMs },
});

export const lifecycleSuspendResumeBasic = createLifecycleTest("lifecycle-suspend-resume-basic");
export const lifecycleSuspendIdempotent = createLifecycleTest("lifecycle-suspend-idempotent");
export const lifecycleResumeIdempotent = createLifecycleTest("lifecycle-resume-idempotent");
export const lifecycleSuspendResumeInference = createLifecycleTest("lifecycle-suspend-resume-inference", "llm", 60000, ["smoke"]);
export const lifecycleRapidToggle = createLifecycleTest("lifecycle-rapid-toggle");
export const lifecycleSuspendDuringInference = createLifecycleTest("lifecycle-suspend-during-inference", "llm", 60000);
export const lifecycleStateTransitions = createLifecycleTest("lifecycle-state-transitions", "none", 15000, ["smoke"]);
export const lifecycleBlockedCompletion = createLifecycleTest("lifecycle-blocked-completion", "llm", 60000);
export const lifecycleBlockedRegistry = createLifecycleTest("lifecycle-blocked-registry");

export const lifecycleTests = [
  lifecycleSuspendResumeBasic,
  lifecycleSuspendIdempotent,
  lifecycleResumeIdempotent,
  lifecycleSuspendResumeInference,
  lifecycleRapidToggle,
  lifecycleSuspendDuringInference,
  lifecycleStateTransitions,
  lifecycleBlockedCompletion,
  lifecycleBlockedRegistry,
] as const;
