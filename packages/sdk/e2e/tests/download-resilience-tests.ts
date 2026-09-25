import type { TestDefinition } from '@qvac/test-suite'

// Demonstrates QVAC-21225: an in-flight model download must survive an app
// suspend/resume and a mid-stream network drop and complete from the partial,
// with no consumer-side pause/cancel/re-request. Covers registry:// (P2P) and
// https:// (HTTP). Desktop-only: the HTTP cases host a local node:http server.
// Not in the smoke suite — network-dependent and slow.

export const downloadResilienceRegistrySuspend: TestDefinition = {
  testId: 'download-resilience-registry-suspend',
  params: {},
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

export const downloadResilienceHttpNetdrop: TestDefinition = {
  testId: 'download-resilience-http-netdrop',
  params: {},
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

export const downloadResilienceHttpSuspend: TestDefinition = {
  testId: 'download-resilience-http-suspend',
  params: {},
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

// Sharded HTTP download must recover when one shard's transfer drops mid-stream.
// Faithful e2e: a local proxy fronts the real sharded model and severs one shard
// once. Downloads a real (~hundreds of MB) model, so it is gated behind
// QVAC_E2E_HTTP_SHARDED_RESILIENCE and excluded from the default suite.
export const downloadResilienceHttpSharded: TestDefinition = {
  testId: 'download-resilience-http-sharded',
  params: {},
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 300000
  }
}

export const downloadResilienceTests = [
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded
]

/**
 * Not runnable on the Python client yet.
 *
 * A skip rather than an `incomplete`, decided deliberately: these are the
 * definitions the step vocabulary cannot express, so they would otherwise sit
 * in the Python column as debt with no owner and no date. The reason travels
 * with the rule, which is what keeps the skip auditable -- and they become
 * runnable the moment the per-client imperative bodies are written.
 *
 * Only definitions with no declarative body are skipped; anything already
 * migrated runs on Python like everywhere else.
 */
for (const test of downloadResilienceTests) {
  if (test.steps || test.skip) continue
  test.skip = {
    reason:
      'the Python client has no body for this: it drives network faults through local HTTP fixtures, which the Python client needs a hand-written body for before this can run there',
    platforms: ['desktop-python']
  }
}
