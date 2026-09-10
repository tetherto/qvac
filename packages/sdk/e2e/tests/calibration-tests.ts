import type { TestDefinition } from '@qvac/test-suite'

// Opt-in: ordinary runs drop it with `--exclude-suite calibration`. The definition
// always ships because consumers resolve testIds against this list. The estimate
// sizes the derived timeouts (consumer 2×, producer 3×): 21 loads plus ~4.8 GB of downloads.
export const calibrationModelFit: TestDefinition = {
  testId: 'calibration-model-fit',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['calibration'],
  metadata: {
    category: 'calibration',
    dependency: 'calibration',
    estimatedDurationMs: 45 * 60 * 1000
  }
}

export const calibrationTests = [calibrationModelFit] as const
