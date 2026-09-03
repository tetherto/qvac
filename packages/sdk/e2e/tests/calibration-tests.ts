import type { TestDefinition } from '@qvac/test-suite'

// Runs the assessModelFit calibration harness inside the SDK worker and
// returns the run — coefficients, held-out check, warnings and the
// `<platform>.ts` fixture source — as the test output. Opt-in only: the
// producer loads it when QVAC_E2E_CALIBRATION=1 (see test-definitions.ts),
// because it takes the better part of an hour and wants the device to itself.
//
// The estimate sizes both timeouts the framework derives from it (consumer 2×,
// producer 3×): the mobile profile is 21 loads plus ~4.8 GB of model downloads
// on a device with no cache.
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
