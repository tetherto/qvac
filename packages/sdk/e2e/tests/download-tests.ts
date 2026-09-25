// Download resilience, and why this file stays on its executors.
//
// These tests stand up local HTTP servers that misbehave on purpose -- drop
// the connection mid-transfer, stall, serve a shard short -- and then assert
// the client recovered. The fault is the test, and it lives outside the SDK
// entirely: a step vocabulary that could express "start a server that fails
// this way" would be a second test framework hiding inside the catalog.
//
// `download-cancel-isolation` additionally cancels from inside a progress
// callback at a given percentage, which is the same in-stream predicate that
// keeps `finetune-pause-resume` and the cancellation family imperative.
import type { TestDefinition } from '@qvac/test-suite'

export const downloadCancelIsolation: TestDefinition = {
  testId: 'download-cancel-isolation',
  params: { cancelAtPercent: 1 },
  // expectation is ignored in test executor, it does validation in the executor itself.
  expectation: { validation: 'function', fn: () => true },
  suites: ['smoke'],
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

// A single-file LFS GGUF on the Hub. downloadAsset over its https URL verifies
// the streamed bytes against the Hub SHA-256, so a resolved download is proof
// the Hugging Face verification path accepts genuine Hub content.
export const downloadHuggingFaceVerify: TestDefinition = {
  testId: 'download-hf-verify',
  params: {
    assetUrl:
      'https://huggingface.co/qvac/VisionPsy-Nano-460M-Flash-GGUFs/resolve/main/mmproj-visionpsy-nano-460m-flash-q8.gguf'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

export const downloadTests = [downloadCancelIsolation, downloadHuggingFaceVerify]

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
for (const test of downloadTests) {
  if (test.steps || test.skip) continue
  test.skip = {
    reason:
      'the Python client has no body for this: it drives network faults through local HTTP fixtures, which the Python client needs a hand-written body for before this can run there',
    platforms: ['desktop-python']
  }
}
