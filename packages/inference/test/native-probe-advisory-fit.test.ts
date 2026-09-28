import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import type { FitLlamaResult } from '@qvac/model-fit/process'

import type { Logger } from '@/logging/types'
import { ModelType } from '@/schemas/index'
import { runAdvisoryFitCheck } from '@/resources/model-fit/native-probe/advisory-fit'
import type { IsolatedFitResult } from '@/resources/model-fit/native-probe/run-isolated-fit'

const COMPLETION_INPUT = {
  modelId: 'llm-1',
  modelType: ModelType.llamacppCompletion,
  modelPath: '/models/model.gguf',
  modelConfig: { ctx_size: 4096, gpu_layers: 99, device: 'gpu' },
  isShardedModel: false
}

const FIT_PLAN: FitLlamaResult = {
  status: 0,
  fits: true,
  reason: 'fits',
  maxDevices: 1,
  nDevices: 1,
  nGpuDevices: 1,
  nGpuLayers: 32,
  nCtx: 4096,
  nBatch: 512,
  nUbatch: 512,
  tensorSplit: [1],
  buftOverrides: [],
  splitMode: 1,
  mainGpu: 0,
  typeK: 1,
  typeV: 1,
  flashAttnType: 1
}

type LogLevelName = 'error' | 'warn' | 'info' | 'debug' | 'trace'

interface Recorded {
  level: LogLevelName
  message: string
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = []
  const record =
    (level: LogLevelName) =>
    (...args: unknown[]) => {
      records.push({ level, message: args.map(String).join(' ') })
    }
  const logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    setLevel: () => {},
    getLevel: () => 2,
    addTransport: () => {},
    setConsoleOutput: () => {}
  } as unknown as Logger
  return { logger, records }
}

const zeroResident = () => Promise.resolve(0)

// Every outcome carries the same provenance, so `alike` needs it in each
// expectation. Asserted rather than ignored: it is what tells a caller which
// evidence class and headroom policy produced the verdict.
const PROVENANCE = { basis: 'native-probe', estimatorVersion: 'native-probe-v2' } as const

function fitReturning(result: IsolatedFitResult) {
  const calls: unknown[][] = []
  const runFit = (...args: unknown[]) => {
    calls.push(args)
    return Promise.resolve(result)
  }
  return { calls, runFit: runFit as never }
}

test('advisory fit: reports a projected fit with its plan', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    verdict: 'fit',
    reason: 'fits',
    plan: { nCtx: 4096, nGpuLayers: 32, nGpuDevices: 1 }
  })
  t.is(calls.length, 1)
  t.is(calls[0]?.[0], 'completion')
  t.is(records[0]?.level, 'info')
  t.ok(records[0]?.message.includes('advisory only'))
})

test('advisory fit: reports a projected insufficiency without denying the load', async (t) => {
  const { logger, records } = recordingLogger()
  const { runFit } = fitReturning({
    status: 'completed',
    result: { ...FIT_PLAN, status: 1, fits: false, reason: 'does-not-fit' } as never
  })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, { ...PROVENANCE, verdict: 'does-not-fit', reason: 'does-not-fit' })
  t.is(records[0]?.level, 'warn')
  t.ok(records[0]?.message.includes('the load continues unchanged'))
})

test('advisory fit: treats every non-verdict fit result as absent evidence', async (t) => {
  for (const reason of ['model-unreadable', 'no-backend-device', 'unsupported-config']) {
    const { logger } = recordingLogger()
    const { runFit } = fitReturning({
      status: 'completed',
      result: { ...FIT_PLAN, status: 2, fits: false, reason } as never
    })

    const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
      mobile: false,
      residentModelBytes: zeroResident,
      runFit,
      logger
    })

    t.alike(outcome, { ...PROVENANCE, verdict: 'unknown', reason })
  }
})

test('advisory fit: treats every supervisor failure as absent evidence', async (t) => {
  for (const reason of ['crashed', 'timeout', 'invalid-response', 'spawn-failed', 'cancelled']) {
    const { logger, records } = recordingLogger()
    const { runFit } = fitReturning({
      status: 'unknown',
      reason: reason as never,
      message: 'child failed'
    })

    const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
      mobile: false,
      residentModelBytes: zeroResident,
      runFit,
      logger
    })

    t.alike(outcome, { ...PROVENANCE, verdict: 'unknown', reason, message: 'child failed' })
    t.is(records[0]?.level, 'info')
  }
})

test('advisory fit: never launches a child for an unsupported load', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(
    { ...COMPLETION_INPUT, modelType: ModelType.ttsGgml },
    { mobile: false, runFit, logger }
  )

  t.is(outcome.verdict, 'unknown')
  t.is(outcome.reason, 'unsupported-load')
  t.is(calls.length, 0)
  // Every non-llama load takes this path, so it must not spam `info`.
  t.is(records[0]?.level, 'debug')
})

test('advisory fit: the env opt-out disables the check without logging', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    enabled: false,
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, { ...PROVENANCE, verdict: 'unknown', reason: 'disabled' })
  t.is(calls.length, 0)
  t.is(records.length, 0)
})

test('advisory fit: runs the fitter on mobile', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: true,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    verdict: 'fit',
    reason: 'fits',
    plan: { nCtx: 4096, nGpuLayers: 32, nGpuDevices: 1 }
  })
  t.is(calls.length, 1)
})

test('advisory fit: absorbs a supervisor that rejects', async (t) => {
  const { logger } = recordingLogger()

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit: (() => Promise.reject(new TypeError('supervisor exploded'))) as never,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    verdict: 'unknown',
    reason: 'internal-error',
    message: 'TypeError: supervisor exploded'
  })
})

test('advisory fit: absorbs a supervisor that throws synchronously', async (t) => {
  const { logger } = recordingLogger()

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit: (() => {
      throw new RangeError('bad request')
    }) as never,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    verdict: 'unknown',
    reason: 'internal-error',
    message: 'RangeError: bad request'
  })
})

test('advisory fit: forwards the caller timeout and abort signal to the supervisor', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })
  const controller = new AbortController()

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger,
    timeoutMs: 1_234,
    signal: controller.signal
  })

  t.alike(calls[0]?.[2], { timeoutMs: 1_234, signal: controller.signal })
})

test('advisory fit: reserves resident model bytes through the fit margin', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    // 10.5 GiB of resident weights -> ceil(10752 MiB) on top of the 1024 base.
    residentModelBytes: () => Promise.resolve(10.5 * 1024 * 1024 * 1024),
    runFit,
    logger
  })

  const config = calls[0]?.[1] as { marginMiB?: number }
  t.is(config.marginMiB, 1024 + 10752)
})

test('advisory fit: always sends the explicit base margin, even with nothing resident', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  // The base always travels explicitly: relying on the addon default would
  // leave two sources of truth that diverge silently if the default moves.
  const config = calls[0]?.[1] as { marginMiB?: number }
  t.is(config.marginMiB, 1024)
})

test('advisory fit: absorbs a resident-bytes probe that rejects', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: () => Promise.reject(new TypeError('registry unavailable')),
    runFit,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    verdict: 'unknown',
    reason: 'internal-error',
    message: 'TypeError: registry unavailable'
  })
})

const GIB = 1024 ** 3

// 5 GiB on the device, 256 MiB on the host.
const FIT_WITH_PROJECTION: FitLlamaResult = {
  ...FIT_PLAN,
  projection: [
    {
      name: 'Metal',
      totalBytes: 24 * GIB,
      freeBytes: 20 * GIB,
      marginBytes: GIB,
      modelBytes: 4 * GIB,
      contextBytes: GIB,
      computeBytes: 0
    },
    {
      name: 'host',
      totalBytes: 24 * GIB,
      freeBytes: 22 * GIB,
      marginBytes: GIB,
      modelBytes: 256 * 1024 * 1024,
      contextBytes: 0,
      computeBytes: 0
    }
  ]
}

const PROJECTED_DEMAND = 5 * GIB + 256 * 1024 * 1024

const countsDevices = () => Promise.resolve(true)
const hostOnly = () => Promise.resolve(false)

test('advisory fit: carries the per-device figures the fitter measured', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_WITH_PROJECTION })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(PROJECTED_DEMAND + 2 * GIB),
    countsDeviceRows: countsDevices,
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit')
  t.alike(outcome.projection, { devices: FIT_WITH_PROJECTION.projection })
})

test('advisory fit: omits the projection where the fitter reports none', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.is(outcome.projection, undefined)
})

test('advisory fit: refuses a projected fit the machine cannot hold', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_WITH_PROJECTION })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(4 * GIB),
    countsDeviceRows: countsDevices,
    runFit,
    logger
  })

  t.is(outcome.verdict, 'does-not-fit')
  t.is(outcome.reason, 'exceeds-available-memory')
  t.ok(outcome.message?.includes('5376 MiB'))
  t.alike(outcome.projection, { devices: FIT_WITH_PROJECTION.projection })
})

test('advisory fit: keeps the placement the fitter resolved on a budget refusal', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_WITH_PROJECTION })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(4 * GIB),
    countsDeviceRows: countsDevices,
    runFit,
    logger
  })

  t.is(outcome.verdict, 'does-not-fit')
  t.alike(outcome.plan, {
    nCtx: FIT_PLAN.nCtx,
    nGpuLayers: FIT_PLAN.nGpuLayers,
    nGpuDevices: FIT_PLAN.nGpuDevices
  })
})

// The same projection and budget that refuse when the device rows are charged
// to system memory.
test('advisory fit: a device with its own memory is not charged to the system', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_WITH_PROJECTION })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(4 * GIB),
    countsDeviceRows: hostOnly,
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit', 'only the 256 MiB host row counts')
})

test('advisory fit: keeps the fitter verdict where no system sample is available', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', result: FIT_WITH_PROJECTION })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(undefined),
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit')
})

// A refusal is the fitter's own; this side only ever narrows a `fit`.
test('advisory fit: leaves a refusal alone whatever the machine reports', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({
    status: 'completed',
    result: { ...FIT_WITH_PROJECTION, status: 1, fits: false, reason: 'does-not-fit' } as never
  })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(64 * GIB),
    runFit,
    logger
  })

  t.is(outcome.reason, 'does-not-fit')
  t.alike(outcome.projection, { devices: FIT_WITH_PROJECTION.projection })
})
