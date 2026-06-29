import type { TestDefinition } from "@tetherto/qvac-test-suite";

// Demonstrates QVAC-21225: an in-flight model download must survive an app
// suspend/resume and a mid-stream network drop and complete from the partial,
// with no consumer-side pause/cancel/re-request. Covers registry:// (P2P) and
// https:// (HTTP). Desktop-only: the HTTP cases host a local node:http server.
// Not in the smoke suite — network-dependent and slow.

export const downloadResilienceRegistrySuspend: TestDefinition = {
  testId: "download-resilience-registry-suspend",
  params: {},
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
};

export const downloadResilienceHttpNetdrop: TestDefinition = {
  testId: "download-resilience-http-netdrop",
  params: {},
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const downloadResilienceHttpSuspend: TestDefinition = {
  testId: "download-resilience-http-suspend",
  params: {},
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

// Sharded HTTP download must recover when one shard's transfer drops mid-stream.
// Faithful e2e: a local proxy fronts the real sharded model and severs one shard
// once. Downloads a real (~hundreds of MB) model, so it is gated behind
// QVAC_E2E_HTTP_SHARDED_RESILIENCE and excluded from the default suite.
export const downloadResilienceHttpSharded: TestDefinition = {
  testId: "download-resilience-http-sharded",
  params: {},
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 300000,
  },
};

export const downloadResilienceTests = [
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded,
];
