import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import type { FitLlamaResult } from '@qvac/model-fit/process'

import type { Logger } from '@/logging/types'
import { ModelType } from '@/schemas/index'
import { runAdvisoryFitCheck } from '@/model-fit/advisory-fit'
import type { IsolatedFitResult } from '@/model-fit/run-isolated-fit'

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

  t.alike(outcome, { verdict: 'does-not-fit', reason: 'does-not-fit' })
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

    t.alike(outcome, { verdict: 'unknown', reason })
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

    t.alike(outcome, { verdict: 'unknown', reason, message: 'child failed' })
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

  t.alike(outcome, { verdict: 'unknown', reason: 'disabled' })
  t.is(calls.length, 0)
  t.is(records.length, 0)
})

test('advisory fit: never launches a child on mobile', async (t) => {
  const { logger } = recordingLogger()
  const { calls, runFit } = fitReturning({ status: 'completed', result: FIT_PLAN })

  const outcome = await runAdvisoryFitCheck(COMPLETION_INPUT, {
    mobile: true,
    residentModelBytes: zeroResident,
    runFit,
    logger
  })

  t.alike(outcome, {
    verdict: 'unknown',
    reason: 'unsupported-load',
    message: 'mobile has no disposable process boundary'
  })
  t.is(calls.length, 0)
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
    verdict: 'unknown',
    reason: 'internal-error',
    message: 'TypeError: registry unavailable'
  })
})
