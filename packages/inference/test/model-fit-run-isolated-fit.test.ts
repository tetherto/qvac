import test from 'brittle'
import EventEmitter from 'bare-events'

import { AbortController, type AbortSignal } from 'bare-abort-controller'
import env from 'bare-env'
import {
  FIT_PROCESS_MAX_RESPONSE_BYTES,
  FIT_PROCESS_PROTOCOL_VERSION_V2
} from '@qvac/model-fit/process'

import {
  runIsolatedFit,
  type ChildProcess,
  type ReadableChildStream,
  type RunIsolatedFitOptions,
  type SpawnContext,
  type WritableChildStream
} from '@/model-fit/run-isolated-fit'

const LOAD_KIND = 'completion' as const
const CONFIG = {
  modelPath: '/models/test.gguf',
  params: { device: 'gpu', 'ctx-size': '4096' },
  nCtxMin: 4096
}
const RUNTIME = {
  platform: 'darwin',
  arch: 'arm64',
  isAndroid: false,
  isBrowser: false,
  isIOS: false
}
const ALLOWED_DEFAULT_ENVIRONMENT = {
  HOME: '/default/home',
  PATH: '/default/bin',
  TMPDIR: '/default/tmpdir',
  TMP: '/default/tmp',
  TEMP: '/default/temp',
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  LD_LIBRARY_PATH: '/default/ld',
  DYLD_LIBRARY_PATH: '/default/dyld',
  VK_ICD_FILENAMES: '/default/icd.json',
  VK_DRIVER_FILES: '/default/driver.json',
  CUDA_VISIBLE_DEVICES: '0',
  HIP_VISIBLE_DEVICES: '1',
  ROCR_VISIBLE_DEVICES: '2'
}
const DEFAULT_ENVIRONMENT = {
  ...ALLOWED_DEFAULT_ENVIRONMENT,
  SECRET_TOKEN: 'must-not-leak'
}
const COMPLETED_RESULT = {
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
} as const

class FakeReadable extends EventEmitter {
  encoding: string | undefined
  destroyed = false
  throwOnSetEncoding = false

  setEncoding(encoding: 'utf8'): void {
    if (this.throwOnSetEncoding) throw new TypeError('setEncoding failed')
    this.encoding = encoding
  }

  destroy(): void {
    this.destroyed = true
  }
}

class FakeWritable extends EventEmitter {
  writes: string[] = []
  destroyed = false
  onEnd: (() => void) | undefined
  throwOnEnd = false

  end(data?: string): void {
    if (this.throwOnEnd) throw new TypeError('stdin end failed')
    if (data !== undefined) this.writes.push(data)
    this.onEnd?.()
  }

  destroy(): void {
    this.destroyed = true
  }
}

class FakeChild extends EventEmitter {
  pid: number | null = 42
  killed = false
  stdin: FakeWritable | null = new FakeWritable()
  stdout: FakeReadable | null = new FakeReadable()
  stderr: FakeReadable | null = new FakeReadable()
  kills: string[] = []

  kill(signal = 'SIGTERM'): boolean {
    this.killed = true
    this.kills.push(signal)
    return true
  }
}

// The fakes are structurally what the supervisor consumes; bare-events'
// EventEmitter typings differ from the seam interfaces on `on`/`off`
// signatures, so hand them over through one explicit cast.
function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess
}

function optionsFor(
  child: FakeChild,
  overrides: RunIsolatedFitOptions = {}
): RunIsolatedFitOptions {
  return {
    runtime: RUNTIME,
    environment: {},
    runnerPath: '/runner/process-runner.js',
    spawnProcess: () => asChild(child),
    ...overrides
  }
}

// bun:test's toMatchObject asserted a subset of keys; brittle's alike is an
// exact deep-compare. This keeps the original partial-match semantics.
function matchObject(
  t: { alike: (a: unknown, b: unknown, msg?: string) => void },
  actual: unknown,
  expected: Record<string, unknown>
): void {
  const source = (actual ?? {}) as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of Object.keys(expected)) {
    picked[key] = source[key]
  }
  t.alike(picked, expected)
}

function completedLine(result: unknown = COMPLETED_RESULT): string {
  return `${JSON.stringify({
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    status: 'completed',
    result
  })}\n`
}

function closeChild(child: FakeChild, code: number | null = 0, signal: string | null = null): void {
  child.emit('exit', code, signal)
  child.emit('close', code, signal)
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('returns unsupported-platform without spawning on mobile', async (t) => {
  for (const unsupported of [
    { isAndroid: true, isBrowser: false, isIOS: false },
    { isAndroid: false, isBrowser: true, isIOS: false },
    { isAndroid: false, isBrowser: false, isIOS: true }
  ]) {
    let spawnCount = 0
    const result = await runIsolatedFit(LOAD_KIND, CONFIG, {
      runtime: { ...RUNTIME, ...unsupported },
      spawnProcess: () => {
        spawnCount++
        return asChild(new FakeChild())
      }
    })

    t.alike(result, {
      status: 'unknown',
      reason: 'unsupported-platform',
      message: 'Fit subprocess isolation is unavailable on darwin'
    })
    t.is(spawnCount, 0)
  }
})

test('writes one versioned request and maps a valid response to completed', async (t) => {
  const child = new FakeChild()
  let handlersReadyAtWrite = false
  child.stdin!.onEnd = () => {
    handlersReadyAtWrite =
      child.listenerCount('error') === 1 &&
      child.listenerCount('exit') === 1 &&
      child.listenerCount('close') === 1 &&
      child.stdin!.listenerCount('error') === 1 &&
      child.stdout!.listenerCount('data') === 1 &&
      child.stdout!.listenerCount('error') === 1 &&
      child.stderr!.listenerCount('data') === 1 &&
      child.stderr!.listenerCount('error') === 1
    child.stdout!.emit('data', completedLine())
    closeChild(child)
  }

  const result = await runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))

  t.is(handlersReadyAtWrite, true)
  t.alike(child.stdin!.writes, [
    `${JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2,
      loadKind: LOAD_KIND,
      config: CONFIG
    })}\n`
  ])
  t.alike(result, {
    status: 'completed',
    result: COMPLETED_RESULT
  })
})

test('maps runner error responses to unknown invocation-error', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit(
    'data',
    `${JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2,
      status: 'invocation-error',
      error: { name: 'RangeError', message: 'bad config' }
    })}\n`
  )
  closeChild(child, 1)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'invocation-error',
    message: 'RangeError: bad config'
  })
})

test('prefers crashed over a runner error response when the child died by signal', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit(
    'data',
    `${JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2,
      status: 'invocation-error',
      error: { name: 'RangeError', message: 'bad config' }
    })}\n`
  )
  closeChild(child, null, 'SIGSEGV')

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code null and signal SIGSEGV'
  })
})

test('maps spawn throws and error events to unknown spawn-failed', async (t) => {
  const thrown = await runIsolatedFit(LOAD_KIND, CONFIG, {
    ...optionsFor(new FakeChild()),
    spawnProcess: () => {
      throw new TypeError('binary unavailable')
    }
  })
  t.alike(thrown, {
    status: 'unknown',
    reason: 'spawn-failed',
    message: 'TypeError: binary unavailable'
  })

  const child = new FakeChild()
  const emittedPromise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.emit('error', new TypeError('launch failed'))
  child.emit('close', null, null)
  t.alike(await emittedPromise, {
    status: 'unknown',
    reason: 'spawn-failed',
    message: 'TypeError: launch failed'
  })
})

test('maps non-zero exit without a response to unknown crashed', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  closeChild(child, 7)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code 7 and signal null'
  })
})

test('maps signal exit without a response to unknown crashed', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  closeChild(child, null, 'SIGSEGV')

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code null and signal SIGSEGV'
  })
})

test('normalizes Bare numeric signal 0 as a successful exit', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit('data', completedLine())
  child.emit('exit', 0, 0)
  child.emit('close', 0, 0)

  t.alike(await promise, {
    status: 'completed',
    result: COMPLETED_RESULT
  })
})

test('normalizes Bare numeric signal 6 as crashed', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.emit('exit', 0, 6)
  child.emit('close', 0, 6)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code 0 and signal 6'
  })
})

test('rejects multiple response lines as unknown invalid-response', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit('data', `${completedLine()}${completedLine()}`)
  closeChild(child)

  matchObject(t, await promise, {
    status: 'unknown',
    reason: 'invalid-response'
  })
})

test('rejects an additional blank line after a valid response', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit('data', `${completedLine()}\n`)
  closeChild(child)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'invalid-response',
    message: 'Fit subprocess returned invalid line framing'
  })
})

test('rejects response output larger than 1 MiB as unknown invalid-response', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  let settled = false
  void promise.then(() => {
    settled = true
  })

  child.stdout!.emit('data', 'x'.repeat(FIT_PROCESS_MAX_RESPONSE_BYTES + 1))
  await nextTurn()
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)

  closeChild(child, null, 'SIGTERM')
  t.alike(await promise, {
    status: 'unknown',
    reason: 'invalid-response',
    message: 'Fit subprocess response exceeds 1 MiB'
  })
})

test('retains only the final 16 KiB of stderr', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stderr!.emit('data', `discard-${'a'.repeat(20_000)}`)
  child.stderr!.emit('data', 'FINAL')
  closeChild(child, 1)

  const result = await promise
  matchObject(t, result, {
    status: 'unknown',
    reason: 'crashed'
  })
  if (result.status !== 'unknown') throw new TypeError('expected unknown result')
  t.is(Buffer.byteLength(result.stderrTail ?? '', 'utf8'), 16 * 1024)
  t.is(result.stderrTail?.endsWith('FINAL'), true)
  t.is(result.stderrTail?.startsWith('discard-'), false)
})

test('times out at the configured deadline, terminates, then force-kills', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, { timeoutMs: 5, terminationGraceMs: 20 })
  )
  let settled = false
  void promise.then(() => {
    settled = true
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)

  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])
  t.is(settled, false)

  closeChild(child, null, 'SIGKILL')
  t.alike(await promise, {
    status: 'unknown',
    reason: 'timeout',
    message: 'Fit subprocess exceeded 5ms'
  })
})

test('cancellation terminates the child and returns unknown cancelled', async (t) => {
  const child = new FakeChild()
  const controller = new AbortController()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, { signal: controller.signal })
  )
  let settled = false
  void promise.then(() => {
    settled = true
  })

  controller.abort(undefined)
  await nextTurn()
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)

  closeChild(child, null, 'SIGTERM')
  t.alike(await promise, {
    status: 'unknown',
    reason: 'cancelled',
    message: 'Fit subprocess was cancelled'
  })
})

test('settles exactly once when response and exit race', async (t) => {
  const child = new FakeChild()
  let resolutions = 0
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child)).then((result) => {
    resolutions++
    return result
  })

  child.stdout!.emit('data', completedLine())
  child.emit('error', new TypeError('late spawn error'))
  closeChild(child, 9, null)
  child.emit('close', 0, null)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'spawn-failed',
    message: 'TypeError: late spawn error'
  })
  await nextTurn()
  t.is(resolutions, 1)
})

test('uses one child per call and keeps concurrent responses isolated', async (t) => {
  const children: FakeChild[] = []
  const spawnProcess = () => {
    const child = new FakeChild()
    children.push(child)
    return asChild(child)
  }
  const first = runIsolatedFit(
    LOAD_KIND,
    { modelPath: '/models/first.gguf', params: { device: 'gpu' } },
    { ...optionsFor(new FakeChild()), spawnProcess }
  )
  const second = runIsolatedFit(
    LOAD_KIND,
    { modelPath: '/models/second.gguf', params: { device: 'gpu' } },
    { ...optionsFor(new FakeChild()), spawnProcess }
  )

  t.is(children.length, 2)
  children[1]!.stdout!.emit('data', completedLine({ ...COMPLETED_RESULT, nCtx: 2_048 }))
  closeChild(children[1]!)
  children[0]!.stdout!.emit('data', completedLine({ ...COMPLETED_RESULT, nCtx: 8_192 }))
  closeChild(children[0]!)

  const firstResult = await first
  matchObject(t, firstResult, { status: 'completed' })
  t.is(firstResult.status === 'completed' ? firstResult.result.nCtx : 0, 8_192)
  const secondResult = await second
  matchObject(t, secondResult, { status: 'completed' })
  t.is(secondResult.status === 'completed' ? secondResult.result.nCtx : 0, 2_048)
})

test('passes only approved environment variables to the child', async (t) => {
  const child = new FakeChild()
  let receivedOptions: SpawnContext['options'] | undefined
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, {
    ...optionsFor(child),
    runnerArgs: ['completed'],
    environment: {
      HOME: '/home/test',
      CUDA_VISIBLE_DEVICES: '0',
      SECRET_TOKEN: 'must-not-leak'
    },
    spawnProcess: (context) => {
      receivedOptions = context.options
      return asChild(child)
    }
  })
  closeChild(child, 1)
  await promise

  matchObject(t, receivedOptions, {
    args: ['/runner/process-runner.js', 'completed'],
    platform: 'darwin',
    arch: 'arm64',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      HOME: '/home/test',
      CUDA_VISIBLE_DEVICES: '0'
    }
  })
})

test('uses overlapped child pipes on Windows', async (t) => {
  const child = new FakeChild()
  let receivedOptions: SpawnContext['options'] | undefined
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, {
    ...optionsFor(child),
    runtime: { ...RUNTIME, platform: 'win32', arch: 'x64' },
    spawnProcess: (context) => {
      receivedOptions = context.options
      return asChild(child)
    }
  })
  closeChild(child, 1)
  await promise

  t.alike(receivedOptions?.stdio, ['overlapped', 'overlapped', 'overlapped'])
})

test('uses the runtime-safe default environment source and preserves the 14-key allowlist', async (t) => {
  const previousEnvironment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(DEFAULT_ENVIRONMENT)) {
    previousEnvironment[key] = env[key]
    env[key] = value
  }

  const child = new FakeChild()
  let receivedOptions: SpawnContext['options'] | undefined
  try {
    const promise = runIsolatedFit(LOAD_KIND, CONFIG, {
      runtime: RUNTIME,
      runnerPath: '/runner/process-runner.js',
      spawnProcess: (context) => {
        receivedOptions = context.options
        return asChild(child)
      }
    })
    closeChild(child, 1)
    await promise

    t.alike(receivedOptions?.env, ALLOWED_DEFAULT_ENVIRONMENT)
    t.is(Object.keys(receivedOptions?.env ?? {}).length, 14)
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      // bare-env's proxy rejects `delete`; blank the key instead. A '' entry
      // still travels through the allowlist, but the assertions above ran
      // before this cleanup and this is the final test in the file.
      env[key] = value === undefined ? '' : value
    }
  }
})

test('maps malformed and unknown-version responses to invalid-response', async (t) => {
  for (const line of [
    '{bad json}\n',
    `${JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2 + 1,
      status: 'completed',
      result: COMPLETED_RESULT
    })}\n`,
    `${JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2,
      status: 'unexpected'
    })}\n`
  ]) {
    const child = new FakeChild()
    const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
    child.stdout!.emit('data', line)
    closeChild(child)
    matchObject(t, await promise, {
      status: 'unknown',
      reason: 'invalid-response'
    })
  }
})

test('rejects completed responses without FitResult discriminants', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit('data', completedLine({}))
  closeChild(child)

  matchObject(t, await promise, {
    status: 'unknown',
    reason: 'invalid-response'
  })
})

test('rejects successful FitResult responses with incomplete plans', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  const { tensorSplit: _tensorSplit, ...incompletePlan } = COMPLETED_RESULT
  child.stdout!.emit('data', completedLine(incompletePlan))
  closeChild(child)

  matchObject(t, await promise, {
    status: 'unknown',
    reason: 'invalid-response'
  })
})

test('classifies nonzero exit with partial stdout as crashed', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
  child.stdout!.emit('data', '{"version":1')
  closeChild(child, 2)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code 2 and signal null'
  })
})

test('terminates on stdio errors and waits for close before settling', async (t) => {
  for (const streamName of ['stdin', 'stdout', 'stderr'] as const) {
    const child = new FakeChild()
    const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child))
    let settled = false
    void promise.then(() => {
      settled = true
    })

    child[streamName]!.emit('error', new TypeError(`${streamName} failed`))
    await nextTurn()
    t.alike(child.kills, ['SIGTERM'])
    t.is(settled, false)

    closeChild(child, null, 'SIGTERM')
    t.alike(
      await promise,
      streamName === 'stdin'
        ? {
            status: 'unknown',
            reason: 'crashed',
            message: 'Fit subprocess exited with code null and signal SIGTERM'
          }
        : {
            status: 'unknown',
            reason: 'invalid-response',
            message: `Fit subprocess ${streamName} failed: ${streamName} failed`
          }
    )
  }
})

test('guards synchronous stream setup and request write failures', async (t) => {
  for (const failure of ['setup', 'write'] as const) {
    const child = new FakeChild()
    if (failure === 'setup') child.stdout!.throwOnSetEncoding = true
    if (failure === 'write') child.stdin!.throwOnEnd = true

    const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child, { terminationGraceMs: 5 }))
    let settled = false
    void promise.then(() => {
      settled = true
    })

    t.alike(child.kills, ['SIGTERM'])
    t.is(settled, false)
    closeChild(child, null, 'SIGTERM')
    matchObject(t, await promise, {
      status: 'unknown',
      reason: 'invalid-response'
    })
  }
})

test('keeps the first termination reason when a child error races timeout', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, { timeoutMs: 5, terminationGraceMs: 5 })
  )
  let settled = false
  void promise.then(() => {
    settled = true
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  child.emit('error', new TypeError('late child error'))
  t.is(settled, false)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])

  closeChild(child, null, 'SIGKILL')
  t.alike(await promise, {
    status: 'unknown',
    reason: 'timeout',
    message: 'Fit subprocess exceeded 5ms'
  })
})

test('rejects oversized stdout delivered after exit while pipes drain', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      timeoutMs: 5,
      drainGraceMs: 50
    })
  )
  let settled = false
  void promise.then(() => {
    settled = true
  })

  child.stdout!.emit('data', completedLine())
  child.emit('exit', 0, null)
  await new Promise<void>((resolve) => setTimeout(resolve, 15))
  child.stdin!.emit('error', new TypeError('late EPIPE'))
  child.emit('error', new TypeError('late child error'))
  child.stdout!.emit('data', 'x'.repeat(FIT_PROCESS_MAX_RESPONSE_BYTES + 1))

  t.alike(child.kills, [])
  t.is(child.stdout!.destroyed, false)
  t.is(settled, false)
  child.emit('close', 0, null)
  t.alike(await promise, {
    status: 'unknown',
    reason: 'invalid-response',
    message: 'Fit subprocess response exceeds 1 MiB'
  })
})

test('accepts a valid response that drains after child exit', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      drainGraceMs: 50
    })
  )

  child.emit('exit', 0, null)
  child.stdout!.emit('data', completedLine())
  child.emit('close', 0, null)

  t.alike(await promise, {
    status: 'completed',
    result: COMPLETED_RESULT
  })
})

test('rejects a second response line delivered after child exit', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      drainGraceMs: 50
    })
  )

  child.stdout!.emit('data', completedLine())
  child.emit('exit', 0, null)
  child.stdout!.emit('data', '{"late":"inherited"}\n')
  child.emit('close', 0, null)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'invalid-response',
    message: 'Fit subprocess returned invalid line framing'
  })
})

test('classifies early crash ahead of a racing stdin EPIPE', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      terminationGraceMs: 5,
      finalKillGraceMs: 5
    })
  )

  child.stdin!.emit('error', new TypeError('write EPIPE'))
  closeChild(child, 1, null)

  t.alike(await promise, {
    status: 'unknown',
    reason: 'crashed',
    message: 'Fit subprocess exited with code 1 and signal null'
  })
})

test('bounds a standalone stdin failure when the child never exits', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      terminationGraceMs: 5,
      finalKillGraceMs: 5
    })
  )

  child.stdin!.emit('error', new TypeError('write EPIPE'))
  const outcome = await Promise.race([
    promise,
    new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30))
  ])
  if (outcome === 'still-pending') child.emit('close', null, 'SIGKILL')
  t.alike(outcome, {
    status: 'unknown',
    reason: 'invalid-response',
    message: 'Fit subprocess stdin failed: write EPIPE; child did not report exit'
  })
})

test('reaps a post-spawn child error before returning spawn-failed', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child, { terminationGraceMs: 5 }))
  let settled = false
  void promise.then(() => {
    settled = true
  })

  child.emit('error', new TypeError('post-spawn failure'))
  t.alike(child.kills, ['SIGTERM'])
  t.is(settled, false)

  closeChild(child, null, 'SIGTERM')
  t.alike(await promise, {
    status: 'unknown',
    reason: 'spawn-failed',
    message: 'TypeError: post-spawn failure'
  })
})

test('settles after SIGKILL when the child reports neither exit nor close', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      timeoutMs: 5,
      terminationGraceMs: 5,
      finalKillGraceMs: 5
    })
  )

  const result = await Promise.race([
    promise,
    new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30))
  ])
  if (result === 'still-pending') child.emit('close', null, 'SIGKILL')
  t.alike(child.kills, ['SIGTERM', 'SIGKILL'])
  t.is(child.stdin!.destroyed, true)
  t.is(child.stdout!.destroyed, true)
  t.is(child.stderr!.destroyed, true)
  t.alike(result, {
    status: 'unknown',
    reason: 'timeout',
    message: 'Fit subprocess exceeded 5ms; child did not report exit'
  })
})

test('bounds pipe drain after exit without close', async (t) => {
  for (const scenario of ['parsed', 'crashed', 'pending'] as const) {
    const child = new FakeChild()
    const controller = new AbortController()
    const promise = runIsolatedFit(
      LOAD_KIND,
      CONFIG,
      optionsFor(child, {
        drainGraceMs: 5,
        ...(scenario === 'pending' ? { signal: controller.signal } : {})
      })
    )

    if (scenario === 'parsed') child.stdout!.emit('data', completedLine())
    if (scenario === 'crashed') child.stdout!.emit('data', '{"version":1')
    if (scenario === 'pending') controller.abort(undefined)
    child.emit('exit', scenario === 'parsed' ? 0 : null, scenario === 'parsed' ? null : 'SIGTERM')

    const outcome = await Promise.race([
      promise,
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30))
    ])
    if (outcome === 'still-pending') child.emit('close', 0, null)

    matchObject(
      t,
      outcome,
      scenario === 'parsed'
        ? { status: 'completed', result: COMPLETED_RESULT }
        : scenario === 'crashed'
          ? { status: 'unknown', reason: 'crashed' }
          : { status: 'unknown', reason: 'cancelled' }
    )
    t.is(child.stdin!.destroyed, true)
    t.is(child.stdout!.destroyed, true)
    t.is(child.stderr!.destroyed, true)
  }
})

test('does not write a request when the signal is already aborted', async (t) => {
  const child = new FakeChild()
  const controller = new AbortController()
  controller.abort(undefined)
  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, {
      signal: controller.signal,
      terminationGraceMs: 5
    })
  )

  t.alike(child.stdin!.writes, [])
  t.alike(child.kills, ['SIGTERM'])
  closeChild(child, null, 'SIGTERM')
  matchObject(t, await promise, {
    status: 'unknown',
    reason: 'cancelled'
  })
})

test('destroys available pipes when child stdio is incomplete', async (t) => {
  const child = new FakeChild()
  const stdin = child.stdin!
  const stdout = child.stdout!
  child.stderr = null
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child, { terminationGraceMs: 5 }))

  t.is(stdin.destroyed, true)
  t.is(stdout.destroyed, true)
  t.alike(child.kills, ['SIGTERM'])
  closeChild(child, null, 'SIGTERM')
  matchObject(t, await promise, {
    status: 'unknown',
    reason: 'spawn-failed'
  })
})

test('removes process, stream, abort listeners and timers after settlement', async (t) => {
  const child = new FakeChild()
  const controller = new AbortController()
  let abortRemoves = 0
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.removeEventListener = ((
    ...args: Parameters<AbortSignal['removeEventListener']>
  ) => {
    abortRemoves++
    originalRemove(...args)
  }) as AbortSignal['removeEventListener']

  const promise = runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, { signal: controller.signal, timeoutMs: 10 })
  )
  child.stdout!.emit('data', completedLine())
  closeChild(child)
  await promise

  for (const emitter of [child, child.stdin!, child.stdout!, child.stderr!]) {
    t.alike(emitter.eventNames(), ['error'])
    t.is(emitter.listenerCount('error'), 1)
  }
  t.is(abortRemoves, 1)
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  t.alike(child.kills, [])
})

test('absorbs late child and stream errors emitted after settlement', async (t) => {
  const child = new FakeChild()
  const promise = runIsolatedFit(LOAD_KIND, CONFIG, optionsFor(child, { timeoutMs: 10 }))
  child.stdout!.emit('data', completedLine())
  closeChild(child)
  const result = await promise

  for (const emitter of [child, child.stdin!, child.stdout!, child.stderr!]) {
    t.execution(() => emitter.emit('error', new TypeError('EPIPE')))
    t.execution(() => emitter.emit('error', new TypeError('ERR_STREAM_DESTROYED')))
  }
  child.stdout!.emit('data', completedLine({ ...COMPLETED_RESULT, nCtx: 1 }))
  await nextTurn()

  t.alike(result, { status: 'completed', result: COMPLETED_RESULT })
  t.alike(await promise, { status: 'completed', result: COMPLETED_RESULT })
  t.alike(child.kills, [])
})

test('absorbs stream errors raised by the post-SIGKILL destroy path', async (t) => {
  const child = new FakeChild()
  const stdin = child.stdin!
  const stdout = child.stdout!
  const stderr = child.stderr!
  stdin.destroy = () => {
    stdin.destroyed = true
    stdin.emit('error', new TypeError('ERR_STREAM_DESTROYED'))
  }

  const result = await runIsolatedFit(
    LOAD_KIND,
    CONFIG,
    optionsFor(child, { timeoutMs: 5, terminationGraceMs: 5, finalKillGraceMs: 5 })
  )

  t.alike(result, {
    status: 'unknown',
    reason: 'timeout',
    message: 'Fit subprocess exceeded 5ms; child did not report exit'
  })
  for (const emitter of [child, stdin, stdout, stderr]) {
    t.execution(() => emitter.emit('error', new TypeError('late EPIPE')))
    t.alike(emitter.eventNames(), ['error'])
  }
})
