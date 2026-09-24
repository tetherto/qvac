import test from 'brittle'
import { AbortController } from 'bare-abort-controller'

import type { Logger } from '@/logging/types'
import { ModelType } from '@/schemas/index'
import { runAdvisoryFitCheck } from '@/resources/model-fit/native-probe/advisory-fit'
import type { FitProbeRequest, FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'
import type { IsolatedFitResult } from '@/resources/model-fit/native-probe/run-isolated-fit'

const COMPLETION_INPUT = {
  modelId: 'llm-1',
  modelType: ModelType.llamacppCompletion,
  modelPath: '/models/model.gguf',
  modelConfig: { ctx_size: 4096, gpu_layers: 99, device: 'gpu' },
  isShardedModel: false
}

const DEVICE_BYTES = 5 * 1024 ** 3
const HOST_BYTES = 256 * 1024 ** 2

const FIT_RESULT: FitProbeResult = {
  engine: 'llm-llamacpp',
  result: {
    status: 'fits',
    reason: 'fits',
    gpuLayers: 32,
    ctxSize: 4096,
    devices: [
      {
        name: 'Metal',
        totalBytes: 24 * 1024 ** 3,
        freeBytes: 20 * 1024 ** 3,
        modelBytes: 4 * 1024 ** 3,
        contextBytes: 1024 ** 3,
        computeBytes: 0
      },
      {
        name: 'host',
        totalBytes: 0,
        freeBytes: 0,
        modelBytes: HOST_BYTES,
        contextBytes: 0,
        computeBytes: 0
      }
    ],
    deviceBytes: DEVICE_BYTES,
    hostBytes: HOST_BYTES,
    trainCtxSize: 8192,
    expertCount: 0
  }
}

const FIT_PROJECTION = {
  deviceBytes: DEVICE_BYTES,
  hostBytes: HOST_BYTES,
  deviceName: 'Metal',
  deviceFreeBytes: 20 * 1024 ** 3,
  deviceTotalBytes: 24 * 1024 ** 3
}

function withResultStatus(status: 'does-not-fit' | 'error', reason: string): FitProbeResult {
  const base = FIT_RESULT.result as Extract<FitProbeResult, { engine: 'llm-llamacpp' }>['result']
  return { engine: 'llm-llamacpp', result: { ...base, status, reason } }
}

/** Every engine but diffusion takes a margin; the probes here are llama loads. */
function marginOf(probe: FitProbeRequest): number | undefined {
  return probe.engine === 'diffusion-cpp' ? undefined : probe.request.marginBytes
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

test('advisory fit: reports a projected fit with its plan and footprint', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    engine: 'llm-llamacpp',
    verdict: 'fit',
    reason: 'fits',
    // The trailing `host` row is not a GPU device.
    plan: { nCtx: 4096, nGpuLayers: 32, nGpuDevices: 1 },
    projection: FIT_PROJECTION
  })
  t.is(calls.length, 1)
  t.is((calls[0]?.[0] as FitProbeRequest).engine, 'llm-llamacpp')
  t.is(records[0]?.level, 'info')
  t.ok(records[0]?.message.includes('advisory only'))
})

test('advisory fit: reports a projected insufficiency without denying the load', async (t) => {
  const { logger, records } = recordingLogger()
  const { runFit } = fitReturning({
    status: 'completed',
    probe: withResultStatus('does-not-fit', 'does-not-fit')
  })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, {
    ...PROVENANCE,
    engine: 'llm-llamacpp',
    verdict: 'does-not-fit',
    reason: 'does-not-fit',
    // The figures matter most where the load does not fit.
    projection: FIT_PROJECTION
  })
  t.is(records[0]?.level, 'warn')
  t.ok(records[0]?.message.includes('the load continues unchanged'))
  t.ok(records[0]?.message.includes('device 5120 MiB'))
})

test('advisory fit: treats every engine error as absent evidence', async (t) => {
  for (const reason of ['model-unreadable', 'no-backend-device', 'unsupported-config']) {
    const { logger } = recordingLogger()
    const { runFit } = fitReturning({
      status: 'completed',
      probe: withResultStatus('error', reason)
    })

    const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
      mobile: false,
      residentModelBytes: zeroResident,
      runFit,
      logger
    })

    t.alike(outcome, { ...PROVENANCE, engine: 'llm-llamacpp', verdict: 'unknown', reason })
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

test('advisory fit: never launches a child for a load with no fitter', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(
    { ...COMPLETION_INPUT, modelType: ModelType.ggmlOcr },
    { mobile: false, runFit, logger }
  )

  t.is(outcome.verdict, 'unknown')
  t.is(outcome.reason, 'unsupported-load')
  t.is(calls.length, 0)
  // Every fitterless load takes this path, so it must not spam `info`.
  t.is(records[0]?.level, 'debug')
})

test('advisory fit: dispatches a speech load to its own engine', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  await runAdvisoryFitCheck(
    {
      modelId: 'tts-1',
      modelType: ModelType.ttsGgml,
      modelPath: '/models/parler.gguf',
      modelConfig: { ttsEngine: 'parler' },
      isShardedModel: false
    },
    { mobile: false, residentModelBytes: zeroResident, runFit, logger }
  )

  t.is(calls.length, 1)
  t.is((calls[0]?.[0] as FitProbeRequest).engine, 'tts-ggml')
})

test('advisory fit: the env opt-out disables the check without logging', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

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
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: true,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit')
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
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })
  const controller = new AbortController()

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger,
    timeoutMs: 1_234,
    signal: controller.signal
  })

  t.alike(calls[0]?.[1], { mobile: false, timeoutMs: 1_234, signal: controller.signal })
})

// The runner picks the strategy from this, so the advisory check resolves the
// runtime once and passes the answer rather than choosing itself.
test('advisory fit: tells the runner which isolation this host can use', async (t) => {
  const { logger } = recordingLogger()

  for (const mobile of [true, false]) {
    const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })
    await runAdvisoryFitCheck(COMPLETION_INPUT, {
      mobile,
      residentModelBytes: zeroResident,
      runFit,
      logger
    })
    t.is((calls[0]?.[1] as { mobile: boolean }).mobile, mobile)
  }
})

test('advisory fit: reserves resident model bytes through the fit margin', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    // 10.5 GiB of resident weights -> 10752 MiB on top of the 1024 base.
    residentModelBytes: () => Promise.resolve(10.5 * 1024 * 1024 * 1024),
    runFit,
    logger
  })

  t.is(marginOf(calls[0]?.[0] as FitProbeRequest), (1024 + 10752) * 1024 * 1024)
})

test('advisory fit: always sends the explicit base margin, even with nothing resident', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  // The base always travels explicitly: relying on the engine default would
  // leave two sources of truth that diverge silently if the default moves.
  t.is(marginOf(calls[0]?.[0] as FitProbeRequest), 1024 * 1024 * 1024)
})

test('advisory fit: absorbs a resident-bytes probe that rejects', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

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

const PROJECTED_DEMAND = DEVICE_BYTES + HOST_BYTES

test('advisory fit: refuses a projected fit the machine cannot hold', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(4 * 1024 ** 3),
    runFit,
    logger
  })

  t.is(outcome.verdict, 'does-not-fit')
  t.is(outcome.reason, 'exceeds-available-memory')
  t.ok(outcome.message?.includes('5376 MiB'))
  t.alike(outcome.projection, FIT_PROJECTION)
})

// DEVICE_BYTES + HOST_BYTES of demand fits against the raw free figure and
// only fails once the 1024 MiB margin comes off, so this is what covers that
// term.
test('advisory fit: the base margin is withheld from the system budget', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(PROJECTED_DEMAND + 512 * 1024 * 1024),
    runFit,
    logger
  })

  t.is(outcome.verdict, 'does-not-fit')
  t.is(outcome.reason, 'exceeds-available-memory')
})

test('advisory fit: keeps a projected fit the machine can hold', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(PROJECTED_DEMAND + 2 * 1024 ** 3),
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit')
  t.is(outcome.reason, 'fits')
})

test('advisory fit: keeps the engine verdict where no system sample is available', async (t) => {
  const { logger } = recordingLogger()
  const { runFit } = fitReturning({ status: 'completed', probe: FIT_RESULT })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: false,
    residentModelBytes: zeroResident,
    availableSystemBytes: () => Promise.resolve(undefined),
    runFit,
    logger
  })

  t.is(outcome.verdict, 'fit')
})
