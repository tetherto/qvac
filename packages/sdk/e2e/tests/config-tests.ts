import type { TestDefinition } from "@tetherto/qvac-test-suite";

/**
 * End-to-end coverage for registry-download configuration plumbing.
 *
 * The qvac.config.json at the root of this package sets:
 *   - registryDownloadMaxRetries: 5
 *   - registryStreamTimeoutMs:    120000
 *
 * If either field is rejected by the SDK config schema, or the worker
 * fails to accept it, the consumer will not start at all and the full
 * suite fails fast. On top of that safety-net, these tests exercise the
 * registry-client download path (downloadBlob / downloadModel) with
 * those values in effect.
 */

export const configRegistryDownloadSmoke: TestDefinition = {
  testId: "config-registry-download-smoke",
  params: {},
  // expectation is validated inside the executor
  expectation: { validation: "function", fn: () => true },
  suites: ["smoke"],
  metadata: {
    category: "config",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const configRegistryDownloadRespectsCancel: TestDefinition = {
  testId: "config-registry-download-respects-cancel",
  params: {},
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "config",
    dependency: "none",
    estimatedDurationMs: 120000,
  },
};

export const configTests = [
  configRegistryDownloadSmoke,
  configRegistryDownloadRespectsCancel,
];
