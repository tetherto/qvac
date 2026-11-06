import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import { z } from 'zod'

import type { Logger } from '@/logging/types'
import { runLoadFitCheck, type LoadCheckInput } from '@/model-fit/load-check'
import type { AddonFit, FitProbeRequest } from '@/model-fit/run/engine'
import type { FitRunResult } from '@/model-fit/run/run'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { ModelType } from '@/schemas/index'
import type { FitLoad, QvacPlugin } from '@/schemas/plugin'

const GIB = 1024 ** 3

const INPUT: LoadCheckInput = {
  modelId: 'llm-1',
  modelType: ModelType.llamacppCompletion,
  modelPath: '/models/model.gguf',
  modelConfig: { ctx_size: 4096 },
  isShardedModel: false
}

function fit(status: AddonFit['status'], usedGiB: number, freeGiB = 32): AddonFit {
  return {
    status,
    devices: [
      {
        id: 'MTL0',
        name: 'MTL0',
        unified: true,
        usedBytes: usedGiB * GIB,
        freeBytes: freeGiB * GIB
      },
      { id: 'CPU', name: 'CPU', unified: true, usedBytes: 0, freeBytes: freeGiB * GIB }
    ],
    stats: {}
  }
}

interface Recorded {
  level: string
  message: string
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = []
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      records.push({ level, message: args.map(String).join(' ') })
    }
  const logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace')
  } as unknown as Logger
  return { logger, records }
}

function withPlugin(
  t: { teardown(fn: () => void): void },
  fitRequest: (load: FitLoad) => unknown = (load) => ({ request: { modelPath: load.modelPath } })
): void {
  const plugin = {
    modelType: ModelType.llamacppCompletion,
    displayName: 'Fake fit',
    addonPackage: '@qvac/fake-fit',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({ model: { load: async () => {} } }),
    fitRequest,
    assessFit: async () => fit('fits', 1),
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
}

function runReturning(result: FitRunResult) {
  const calls: unknown[][] = []
  const runFit = async (...args: unknown[]) => {
    calls.push(args)
    return result
  }
  return { calls, runFit: runFit as never }
}

test('load check: a load within free memory fits', async (t) => {
  withPlugin(t)
  const { logger, records } = recordingLogger()
  const { calls, runFit } = runReturning({ status: 'completed', fit: fit('fits', 4) })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.alike(check, {
    probe: {
      verdict: 'fits',
      pools: [{ id: 'host', unified: true, usedBytes: 4 * GIB, freeBytes: 32 * GIB }],
      models: [fit('fits', 4)]
    }
  })
  t.is((calls[0]?.[0] as FitProbeRequest).addonPackage, '@qvac/fake-fit')
  t.alike((calls[0]?.[0] as FitProbeRequest).request, { modelPath: '/models/model.gguf' })
  t.is(records[0]?.level, 'info')
  t.ok(records[0]?.message.includes('projected to fit'))
})

test('load check: the fitter verdict stands for a single load, however close to free memory', async (t) => {
  withPlugin(t)
  const { logger } = recordingLogger()
  const { runFit } = runReturning({ status: 'completed', fit: fit('fits', 31) })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.is(check.probe.verdict, 'fits')
})

test('load check: a load over free memory does not fit, and says where', async (t) => {
  withPlugin(t)
  const { logger, records } = recordingLogger()
  const { runFit } = runReturning({ status: 'completed', fit: fit('does-not-fit', 34) })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.is(check.probe.verdict, 'does-not-fit')
  t.is(check.detail, 'needs host 34816 MiB of 32768 MiB free')
  t.is(records[0]?.level, 'warn')
})

test('load check: the fitter refusing the load does not fit', async (t) => {
  withPlugin(t)
  const { logger } = recordingLogger()
  const { runFit } = runReturning({ status: 'completed', fit: fit('does-not-fit', 4) })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.is(check.probe.verdict, 'does-not-fit')
  t.is(check.detail, 'the engine fitter projects it will not fit its devices')
})

test('load check: a run with no answer is unknown, with the reason logged', async (t) => {
  withPlugin(t)
  const { logger, records } = recordingLogger()
  const { runFit } = runReturning({ status: 'unknown', reason: 'timeout', message: 'slow' })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.alike(check, {
    probe: {
      verdict: 'unknown',
      pools: [],
      models: [{ status: 'unknown', devices: [], stats: {} }]
    }
  })
  t.is(records[0]?.level, 'info')
  t.ok(records[0]?.message.includes('timeout: slow'))
})

test('load check: a load the plugin cannot project never reaches the runner', async (t) => {
  withPlugin(t, () => ({ unknown: 'an RPC load places layers on remote devices' }))
  const { logger, records } = recordingLogger()
  const { calls, runFit } = runReturning({ status: 'completed', fit: fit('fits', 1) })

  const check = await runLoadFitCheck(INPUT, { logger, runFit })

  t.is(check.probe.verdict, 'unknown')
  t.is(calls.length, 0)
  t.ok(records[0]?.message.includes('remote devices'))
})

test('load check: an engine with no fitter is unknown at debug', async (t) => {
  const { logger, records } = recordingLogger()
  const { calls, runFit } = runReturning({ status: 'completed', fit: fit('fits', 1) })

  const check = await runLoadFitCheck(
    { ...INPUT, modelType: ModelType.ggmlClassification },
    { logger, runFit }
  )

  t.is(check.probe.verdict, 'unknown')
  t.is(calls.length, 0)
  t.is(records[0]?.level, 'debug', 'every load of such an engine answers this')
})

test('load check: a fitter that rejects is logged and the load goes ahead', async (t) => {
  withPlugin(t)
  const { logger, records } = recordingLogger()

  const check = await runLoadFitCheck(INPUT, {
    logger,
    runFit: (() => Promise.reject(new Error('assessFit: the model cannot be read'))) as never
  })

  t.alike(check, {
    probe: {
      verdict: 'unknown',
      pools: [],
      models: [{ status: 'unknown', devices: [], stats: {} }]
    }
  })
  t.is(records[0]?.level, 'warn')
  t.ok(records[0]?.message.includes('the model cannot be read'))
})

test('load check: forwards the caller abort signal to the runner', async (t) => {
  withPlugin(t)
  const { logger } = recordingLogger()
  const { calls, runFit } = runReturning({ status: 'completed', fit: fit('fits', 1) })
  const controller = new AbortController()

  await runLoadFitCheck(INPUT, {
    logger,
    runFit,
    signal: controller.signal
  })

  t.alike(calls[0]?.[1], { signal: controller.signal })
})
