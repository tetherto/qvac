import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'

import type { FitProbeRequest, FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'
import {
  crashMarkerPath,
  crashedMarkerPath,
  runInProcessFit
} from '@/resources/model-fit/native-probe/run-in-process-fit'

const PROBE: FitProbeRequest = {
  engine: 'llm-llamacpp',
  request: {
    modelPath: '/models/model.gguf',
    params: { 'ctx-size': '4096', 'gpu-layers': '99' },
    minCtxSize: 4096,
    marginBytes: 1024 * 1024 * 1024
  }
}

const FIT_RESULT: FitProbeResult = {
  engine: 'llm-llamacpp',
  result: {
    status: 'fits',
    reason: 'fits',
    gpuLayers: 32,
    ctxSize: 4096,
    devices: [],
    deviceBytes: 5 * 1024 ** 3,
    hostBytes: 0,
    trainCtxSize: 8192,
    expertCount: 0
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-in-process-fit-'))
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

test('runInProcessFit: returns the engine projection and clears the marker', async (t) => {
  const stateDir = tempDir()
  const calls: FitProbeRequest[] = []

  const result = await runInProcessFit(PROBE, {
    stateDir,
    callFit: async (probe) => {
      calls.push(probe)
      return FIT_RESULT
    }
  })

  t.alike(result, { status: 'completed', probe: FIT_RESULT })
  t.alike(calls, [PROBE])
  t.is(exists(crashMarkerPath(stateDir, PROBE)), false)
  t.is(exists(crashedMarkerPath(stateDir, PROBE)), false)
})

test('runInProcessFit: a leftover running marker skips the native call', async (t) => {
  const stateDir = tempDir()
  fs.writeFileSync(crashMarkerPath(stateDir, PROBE), '')
  let called = 0

  const result = await runInProcessFit(PROBE, {
    stateDir,
    callFit: async () => {
      called += 1
      return FIT_RESULT
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.is(exists(crashMarkerPath(stateDir, PROBE)), false)
  t.is(exists(crashedMarkerPath(stateDir, PROBE)), true)
})

test('runInProcessFit: a leftover crashed marker keeps skipping native', async (t) => {
  const stateDir = tempDir()
  fs.writeFileSync(crashedMarkerPath(stateDir, PROBE), '')
  let called = 0

  const result = await runInProcessFit(PROBE, {
    stateDir,
    callFit: async () => {
      called += 1
      return FIT_RESULT
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.is(exists(crashedMarkerPath(stateDir, PROBE)), true)
})

test('runInProcessFit: a thrown fit is invocation-error and clears the marker', async (t) => {
  const stateDir = tempDir()

  const result = await runInProcessFit(PROBE, {
    stateDir,
    callFit: async () => {
      throw new TypeError('native exploded')
    }
  })

  t.alike(result, {
    status: 'unknown',
    reason: 'invocation-error',
    message: 'TypeError: native exploded'
  })
  t.is(exists(crashMarkerPath(stateDir, PROBE)), false)
  t.is(exists(crashedMarkerPath(stateDir, PROBE)), false)
})

test('runInProcessFit: an aborted caller never reaches the fitter', async (t) => {
  const stateDir = tempDir()
  const controller = new AbortController()
  controller.abort(undefined)
  let called = 0

  const result = await runInProcessFit(PROBE, {
    stateDir,
    signal: controller.signal,
    callFit: async () => {
      called += 1
      return FIT_RESULT
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})
