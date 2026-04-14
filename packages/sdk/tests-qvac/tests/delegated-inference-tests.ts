import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createDelegatedTest = (
  testId: string,
  params: Record<string, unknown>,
  expectation: TestDefinition["expectation"],
  estimatedDurationMs: number = 15000,
  skip?: TestDefinition["skip"],
  suites?: string[],
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(suites && { suites }),
  metadata: { category: "delegated-inference", dependency: "none", estimatedDurationMs },
  skip,
});

export const delegatedProviderStart = createDelegatedTest(
  "delegated-provider-start", {}, { validation: "function", fn: () => true },
  15000, undefined, ["smoke"],
);

export const delegatedProviderStop = createDelegatedTest(
  "delegated-provider-stop", {}, { validation: "function", fn: () => true },
  15000, undefined, ["smoke"],
);

export const delegatedProviderFirewall = createDelegatedTest(
  "delegated-provider-firewall",
  { firewall: { mode: "allow", publicKeys: [] } },
  { validation: "function", fn: () => true },
);

export const delegatedProviderRestart = createDelegatedTest(
  "delegated-provider-restart", {}, { validation: "function", fn: () => true }, 20000,
);

export const delegatedLoadModelFallbackLocal = createDelegatedTest(
  "delegated-load-model-fallback-local",
  { fallbackToLocal: true },
  { validation: "type", expectedType: "string" },
  90000, undefined, ["smoke"],
);

export const delegatedHeartbeatProvider = createDelegatedTest(
  "delegated-heartbeat-provider", {}, { validation: "function", fn: () => true },
);

export const delegatedCancelDownload = createDelegatedTest(
  "delegated-cancel-download", {}, { validation: "function", fn: () => true }, 30000,
);

export const delegatedConnectionFailure = createDelegatedTest(
  "delegated-connection-failure",
  { timeout: 3000 },
  { validation: "throws-error", errorContains: "" },
  15000, undefined, ["smoke"],
);

export const delegatedInvalidTopic = createDelegatedTest(
  "delegated-invalid-topic", {}, { validation: "throws-error", errorContains: "" }, 5000,
);

export const delegatedProviderNotFound = createDelegatedTest(
  "delegated-provider-not-found",
  { timeout: 3000 },
  { validation: "throws-error", errorContains: "" },
);

// --- E2E (two-process, desktop only) ---

export const delegatedE2ECompletion = createDelegatedTest(
  "delegated-e2e-completion",
  { history: [{ role: "user", content: "What is 2+2? Answer with only the number." }] },
  { validation: "type", expectedType: "string" },
  180000,
  { reason: "E2E delegation requires child_process (Desktop only)", platforms: ["mobile-ios", "mobile-android"] },
);

export const delegatedE2EStreaming = createDelegatedTest(
  "delegated-e2e-streaming",
  { history: [{ role: "user", content: "What is 3+3? Answer with only the number." }] },
  { validation: "type", expectedType: "string" },
  180000,
  { reason: "E2E delegation requires child_process (Desktop only)", platforms: ["mobile-ios", "mobile-android"] },
);

export const delegatedInferenceTests = [
  delegatedProviderStart,
  delegatedProviderStop,
  delegatedProviderFirewall,
  delegatedProviderRestart,
  delegatedLoadModelFallbackLocal,
  delegatedHeartbeatProvider,
  delegatedCancelDownload,
  delegatedConnectionFailure,
  delegatedInvalidTopic,
  delegatedProviderNotFound,
  delegatedE2ECompletion,
  delegatedE2EStreaming,
];
