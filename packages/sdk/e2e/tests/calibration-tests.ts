import type { TestDefinition } from '@qvac/test-suite'

// Runs the assessModelFit calibration harness inside the SDK worker and
// returns the run — coefficients, held-out check, warnings and the
// `<platform>.ts` fixture source — as the test output. Opt-in only: it takes
// the better part of an hour and wants the device to itself, so every run
// except a calibration dispatch drops it with `--exclude-suite calibration`.
// The definition itself always ships, because a consumer resolves incoming
// testIds against this list and cannot run what it has not defined.
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
