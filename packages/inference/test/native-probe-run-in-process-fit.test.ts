import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import type { FitConfig, FitResult } from '@qvac/model-fit'

import {
  crashMarkerPath,
  runInProcessFit,
  toFitConfig
} from '@/resources/model-fit/native-probe/run-in-process-fit'

const CONFIG = {
  modelPath: '/models/model.gguf',
  params: { device: 'gpu', ctx_size: '4096', gpu_layers: '99' },
  nCtxMin: 4096,
  marginMiB: 1024
}

const FIT_PLAN: FitResult = {
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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-in-process-fit-'))
}

test('toFitConfig: forwards path, context, offload, and margin', (t) => {
  t.alike(toFitConfig(CONFIG), {
    modelPath: '/models/model.gguf',
    marginMiB: 1024,
    nCtxMin: 4096,
    nCtx: 4096,
    nGpuLayers: 99
  })
})

test('toFitConfig: omits auto context so the fitter can choose', (t) => {
  const config = toFitConfig({
    modelPath: '/models/model.gguf',
    params: { ctx_size: '0' }
  })
  t.absent('nCtx' in config)
})

test('runInProcessFit: returns the native projection', async (t) => {
  const stateDir = tempDir()
  const calls: FitConfig[] = []

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: (config) => {
      calls.push(config)
      return FIT_PLAN
    }
  })

  t.alike(result, { status: 'completed', result: FIT_PLAN })
  t.alike(calls, [toFitConfig(CONFIG)])
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
})

test('runInProcessFit: leftover crash marker is unknown and skips the native call', async (t) => {
  const stateDir = tempDir()
  fs.writeFileSync(crashMarkerPath(stateDir, CONFIG), '')
  let called = 0

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: () => {
      called += 1
      return FIT_PLAN
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
})

test('runInProcessFit: a thrown fit still clears the crash marker', async (t) => {
  const stateDir = tempDir()

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: () => {
      throw new TypeError('native exploded')
    }
  })

  t.alike(result, {
    status: 'unknown',
    reason: 'invocation-error',
    message: 'TypeError: native exploded'
  })
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
})

function exists(file: string) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}
