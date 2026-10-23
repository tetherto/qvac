import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'

import type { AddonFit, FitProbeRequest } from '@/model-fit/run/engine'
import {
  crashedMarkerPath,
  runFit,
  runningMarkerPath,
  suspectMarkerPath
} from '@/model-fit/run/run'

const REQUEST = {
  modelPath: '/models/model.gguf',
  config: { 'ctx-size': '4096', 'gpu-layers': '99' }
}

const PROBE: FitProbeRequest = { addonPackage: '@qvac/llm-llamacpp', request: REQUEST }

const FIT_RESULT: AddonFit = {
  status: 'fits',
  devices: [{ id: 'CPU', name: 'CPU', unified: true, usedBytes: 5 * 1024 ** 3 }],
  stats: {}
}

/** Above every platform's pid limit, so no process holds it. */
const GONE_PID = 2_000_000_000

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-run-fit-'))
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function countingFit() {
  const state = { calls: 0 }
  const callFit = async () => {
    state.calls += 1
    return FIT_RESULT
  }
  return { state, callFit }
}

test('runFit: returns the engine projection and clears its markers', async (t) => {
  const stateDir = tempDir()
  const calls: FitProbeRequest[] = []
  let markedWhileRunning = false

  const result = await runFit(PROBE, {
    stateDir,
    callFit: async (probe) => {
      calls.push(probe)
      markedWhileRunning = exists(runningMarkerPath(stateDir, PROBE))
      return FIT_RESULT
    }
  })

  t.alike(result, { status: 'completed', fit: FIT_RESULT })
  t.alike(calls, [PROBE])
  t.ok(markedWhileRunning, 'the fit runs under a marker named by this pid')
  t.absent(exists(runningMarkerPath(stateDir, PROBE)))
  t.absent(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: a fit another live process is running is not a crash', async (t) => {
  const stateDir = tempDir()
  const elsewhere = runningMarkerPath(stateDir, PROBE, os.ppid())
  fs.writeFileSync(elsewhere, '')
  const { state, callFit } = countingFit()

  const result = await runFit(PROBE, { stateDir, callFit })

  t.alike(result, { status: 'completed', fit: FIT_RESULT })
  t.is(state.calls, 1)
  t.ok(exists(elsewhere), 'the live process keeps its marker')
  t.absent(exists(suspectMarkerPath(stateDir, PROBE)))
  t.absent(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: the first unfinished fit is retried under a suspect marker', async (t) => {
  const stateDir = tempDir()
  const leftover = runningMarkerPath(stateDir, PROBE, GONE_PID)
  fs.writeFileSync(leftover, '')
  let suspectWhileRunning = false

  const result = await runFit(PROBE, {
    stateDir,
    callFit: async () => {
      suspectWhileRunning = exists(suspectMarkerPath(stateDir, PROBE))
      return FIT_RESULT
    }
  })

  t.alike(result, { status: 'completed', fit: FIT_RESULT })
  t.ok(suspectWhileRunning, 'the retry runs as a suspect')
  t.absent(exists(leftover))
  t.absent(exists(suspectMarkerPath(stateDir, PROBE)), 'a finished retry clears the suspicion')
  t.absent(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: a second unfinished fit in a row skips the fitter', async (t) => {
  const stateDir = tempDir()
  const leftover = runningMarkerPath(stateDir, PROBE, GONE_PID)
  fs.writeFileSync(leftover, '')
  fs.writeFileSync(suspectMarkerPath(stateDir, PROBE), '')
  const { state, callFit } = countingFit()

  const result = await runFit(PROBE, { stateDir, callFit })

  t.is(state.calls, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.absent(exists(leftover))
  t.absent(exists(suspectMarkerPath(stateDir, PROBE)))
  t.ok(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: a crashed marker keeps skipping the fitter', async (t) => {
  const stateDir = tempDir()
  fs.writeFileSync(crashedMarkerPath(stateDir, PROBE), '')
  const { state, callFit } = countingFit()

  const result = await runFit(PROBE, { stateDir, callFit })

  t.is(state.calls, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.ok(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: a fitter that rejects rejects the run and clears the marker', async (t) => {
  const stateDir = tempDir()

  await t.exception(
    runFit(PROBE, {
      stateDir,
      callFit: async () => {
        throw new Error('the model cannot be read')
      }
    }),
    /the model cannot be read/
  )
  t.absent(exists(runningMarkerPath(stateDir, PROBE)))
  t.absent(exists(crashedMarkerPath(stateDir, PROBE)))
})

test('runFit: concurrent fits of one request share the running marker', async (t) => {
  const stateDir = tempDir()
  const running = runningMarkerPath(stateDir, PROBE)
  const release: Array<() => void> = []
  let markerHeld = 0

  const callFit = async () => {
    if (exists(running)) markerHeld += 1
    await new Promise<void>((resolve) => release.push(resolve))
    return FIT_RESULT
  }

  const first = runFit(PROBE, { stateDir, callFit })
  const second = runFit({ ...PROBE }, { stateDir, callFit })
  while (release.length < 2) await new Promise<void>((resolve) => setImmediate(() => resolve()))

  release[0]?.()
  const firstResult = await first
  t.ok(exists(running), 'the marker stays while a fit is in flight')

  release[1]?.()
  const secondResult = await second

  t.alike(firstResult, { status: 'completed', fit: FIT_RESULT })
  t.alike(secondResult, { status: 'completed', fit: FIT_RESULT })
  t.is(markerHeld, 2, 'both fits ran under the marker')
  t.absent(exists(running), 'the last fit removes the marker')
  t.absent(exists(crashedMarkerPath(stateDir, PROBE)), 'an in-flight fit is not a crash')
})

test('runFit: an aborted caller never reaches the fitter', async (t) => {
  const stateDir = tempDir()
  const controller = new AbortController()
  controller.abort(undefined)
  const { state, callFit } = countingFit()

  const result = await runFit(PROBE, { stateDir, signal: controller.signal, callFit })

  t.is(state.calls, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})

test('runFit: a cancel during the fit answers at once and the fitter keeps its marker', async (t) => {
  const stateDir = tempDir()
  const controller = new AbortController()
  let release: () => void = () => {}
  const started = new Promise<void>((resolveStarted) => {
    void runFit(PROBE, {
      stateDir,
      signal: controller.signal,
      callFit: async () => {
        resolveStarted()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return FIT_RESULT
      }
    }).then((result) => {
      t.is(result.status, 'unknown')
      if (result.status === 'unknown') t.is(result.reason, 'cancelled')
      t.ok(exists(runningMarkerPath(stateDir, PROBE)), 'the fitter is still running')
      release()
    })
  })

  await started
  controller.abort(undefined)
  while (exists(runningMarkerPath(stateDir, PROBE))) {
    await new Promise<void>((resolve) => setImmediate(() => resolve()))
  }
  t.pass('the marker goes once the fitter returns')
})

test('runFit: a fitter that does not return times out and is not called again', async (t) => {
  const stateDir = tempDir()
  const probe: FitProbeRequest = {
    ...PROBE,
    request: { ...REQUEST, modelPath: '/models/hung.gguf' }
  }
  let release: () => void = () => {}
  let calls = 0
  const callFit = async () => {
    calls += 1
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return FIT_RESULT
  }

  const first = await runFit(probe, { stateDir, timeoutMs: 10, callFit })
  t.is(first.status, 'unknown')
  if (first.status === 'unknown') t.is(first.reason, 'timeout')
  t.ok(exists(runningMarkerPath(stateDir, probe)), 'the marker stays while the fitter runs')

  const again = await runFit(probe, { stateDir, timeoutMs: 10, callFit })
  t.is(again.status, 'unknown')
  if (again.status === 'unknown') t.is(again.reason, 'timeout')
  t.is(calls, 1, 'the hung fitter is not called again')

  release()
  while (exists(runningMarkerPath(stateDir, probe))) {
    await new Promise<void>((resolve) => setImmediate(() => resolve()))
  }

  const after = await runFit(probe, { stateDir, callFit: async () => FIT_RESULT })
  t.alike(after, { status: 'completed', fit: FIT_RESULT }, 'fits resume once it returns')
})
