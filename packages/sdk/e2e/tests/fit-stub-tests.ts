import type { TestDefinition } from '@qvac/test-suite'

// Runs @qvac/model-fit on a header-only, sparse-truncated copy of a downloaded
// GGUF and on the full file, inside the SDK worker on the device under test.
// Passes when the stub is sparse on this filesystem and both plans are equal.
// The full JSON report is the test output either way, so a failure still says
// which of the three steps (sparse, stub load, plan equality) broke.
export const fitStubCheck = {
  testId: 'fit-stub-check',
  params: { nCtx: 4096, marginMiB: 1024 },
  expectation: {
    validation: 'contains-all',
    contains: ['"pass":true']
  },
  metadata: {
    category: 'fit-stub',
    dependency: 'fit-stub',
    estimatedDurationMs: 120_000
  }
} as const satisfies TestDefinition

export const fitStubTests = [fitStubCheck]
