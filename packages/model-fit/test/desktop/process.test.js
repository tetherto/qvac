'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const publicProcess = require('../../process')
const {
  FIT_PROCESS_PROTOCOL_VERSION,
  FIT_PROCESS_PROTOCOL_VERSION_V2,
  FIT_PROCESS_MAX_REQUEST_BYTES,
  FIT_PROCESS_MAX_RESPONSE_BYTES,
  encodeFitProcessRequest,
  parseFitProcessResponse,
  resolveFitProcessRunnerPath
} = publicProcess
const {
  encodeFitProcessResponse,
  parseFitProcessRequest,
  runFitProcessLine
} = require('../../process-internal')
const packageJson = require('../../package.json')

const PREBUILDS_DIR = path.join(__dirname, '../../prebuilds')
const HAS_NATIVE_PREBUILD =
  fs.existsSync(path.join(PREBUILDS_DIR, `${process.platform}-${process.arch}`)) ||
  (process.platform === 'darwin' && fs.existsSync(path.join(PREBUILDS_DIR, 'darwin-universal')))

function completedFitResult() {
  return {
    status: 0,
    fits: true,
    reason: 'fits',
    nGpuLayers: 24,
    nCtx: 4096,
    nBatch: 512,
    nUbatch: 128,
    tensorSplit: [1],
    buftOverrides: [],
    splitMode: 1,
    mainGpu: 0,
    typeK: 1,
    typeV: 1,
    flashAttnType: 1,
    maxDevices: 1,
    nDevices: 1,
    nGpuDevices: 1
  }
}

const RUNNER_DEADLINE_MS = 10_000
// A cold spawn on darwin compiles the embedded Metal library before the fitter
// can answer, which is far slower than the protocol paths.
const NATIVE_DEADLINE_MS = 120_000

function invocationErrorResponse(message) {
  return {
    version: 1,
    status: 'invocation-error',
    error: { name: 'Error', message }
  }
}

function encodedResponseBytes(response) {
  return Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8')
}

// The runner has no timeout of its own, so the harness supplies one. Without it
// a stuck child is a bare assertion timeout with no output and an orphaned
// process left on the runner.
function runRunner(input, deadlineMs = RUNNER_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    // Overlapped, not plain pipes: libuv gives a child synchronous stdio handles
    // on Windows, and a Bare child then emulates async reads with a worker
    // thread and never sees the request. The flag is a no-op off Windows.
    const child = spawn(process.execPath, [resolveFitProcessRunnerPath()], {
      stdio: ['overlapped', 'overlapped', 'overlapped']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(
          `runner did not exit within ${deadlineMs}ms; ` +
            `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
        )
      )
    }, deadlineMs)

    function settle(result, error) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error !== undefined) reject(error)
      else resolve(result)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => settle(undefined, error))
    child.on('close', (code, signal) => settle({ code, signal, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('fit process protocol constants are fixed', (t) => {
  t.is(FIT_PROCESS_PROTOCOL_VERSION, 1)
  t.is(FIT_PROCESS_PROTOCOL_VERSION_V2, 2)
  t.is(FIT_PROCESS_MAX_REQUEST_BYTES, 64 * 1024)
  t.is(FIT_PROCESS_MAX_RESPONSE_BYTES, 1024 * 1024)
})

test('v1 request encoding remains byte-compatible', (t) => {
  const config = { modelPath: '/model.gguf', nCtx: 4096, swaFull: true }
  t.is(encodeFitProcessRequest(config), `${JSON.stringify({ version: 1, config })}\n`)
})

test('v1 request parsing remains source-compatible', (t) => {
  const request = parseFitProcessRequest({
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config: { modelPath: '/model.gguf', nCtx: 4096, swaFull: false }
  })
  t.alike(request, {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config: { modelPath: '/model.gguf', nCtx: 4096, swaFull: false }
  })
})

test('request codec enforces the 64 KiB boundary', async (t) => {
  await t.exception.all(
    () =>
      encodeFitProcessRequest({
        modelPath: '/model.gguf',
        backendsDir: `/${'x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES)}`
      }),
    /exceeds 64 KiB/
  )
})

test('request parser rejects malformed envelopes', async (t) => {
  await t.exception.all(() => parseFitProcessRequest(null), /must be an object/)
  await t.exception.all(() => parseFitProcessRequest({ version: 1 }), /config must be an object/)
  await t.exception.all(
    () => parseFitProcessRequest({ version: 3, config: { modelPath: '/model.gguf' } }),
    /Unsupported fit process protocol version/
  )
})

test('response parser accepts canonical results and unsupported config', (t) => {
  const completed = parseFitProcessResponse({
    version: 1,
    status: 'completed',
    result: completedFitResult()
  })
  t.is(completed.result.reason, 'fits')

  const unsupported = parseFitProcessResponse({
    version: 2,
    status: 'completed',
    result: {
      status: 2,
      fits: false,
      reason: 'unsupported-config',
      maxDevices: 1,
      nDevices: 1,
      nGpuDevices: 1
    }
  })
  t.is(unsupported.result.reason, 'unsupported-config')
})

test('response parser accepts, omits, and rejects projections', async (t) => {
  // Present and well-formed: accepted on success and on does-not-fit alike.
  const withProjection = parseFitProcessResponse({
    version: 1,
    status: 'completed',
    result: {
      ...completedFitResult(),
      projection: [
        {
          name: 'MTL0',
          totalBytes: 19998441472,
          freeBytes: 1443887104,
          modelBytes: 11355000000,
          contextBytes: 6442450944,
          computeBytes: 460000000
        },
        {
          name: 'host',
          totalBytes: 25769803776,
          freeBytes: 20000000000,
          modelBytes: 0,
          contextBytes: 0,
          computeBytes: 46137344
        }
      ]
    }
  })
  t.is(withProjection.result.projection.length, 2)
  t.is(withProjection.result.projection[1].name, 'host')

  const failureWithProjection = parseFitProcessResponse({
    version: 1,
    status: 'completed',
    result: {
      status: 1,
      fits: false,
      reason: 'does-not-fit',
      maxDevices: 1,
      nDevices: 1,
      nGpuDevices: 1,
      projection: [
        {
          name: 'MTL0',
          totalBytes: 19998441472,
          freeBytes: 0,
          modelBytes: 19998441472,
          contextBytes: 0,
          computeBytes: 0
        }
      ]
    }
  })
  t.is(failureWithProjection.result.projection[0].freeBytes, 0)

  // Absent: an older addon or runner predates the field.
  const withoutProjection = parseFitProcessResponse({
    version: 1,
    status: 'completed',
    result: completedFitResult()
  })
  t.is(withoutProjection.result.projection, undefined)

  // Present but malformed: a truncated row is a malformed response, not
  // missing evidence.
  await t.exception.all(
    () =>
      parseFitProcessResponse({
        version: 1,
        status: 'completed',
        result: { ...completedFitResult(), projection: [{ name: 'MTL0', totalBytes: 1 }] }
      }),
    /must be a number/
  )
  await t.exception.all(
    () =>
      parseFitProcessResponse({
        version: 1,
        status: 'completed',
        result: {
          ...completedFitResult(),
          projection: [
            { totalBytes: 1, freeBytes: 1, modelBytes: 1, contextBytes: 1, computeBytes: 1 }
          ]
        }
      }),
    /must carry a string name/
  )
  await t.exception.all(
    () =>
      parseFitProcessResponse({
        version: 1,
        status: 'completed',
        result: { ...completedFitResult(), projection: {} }
      }),
    /projection must be an array/
  )
})

test('response parser rejects malformed results', async (t) => {
  await t.exception.all(() => parseFitProcessResponse(null), /must be an object/)
  await t.exception.all(
    () =>
      parseFitProcessResponse({
        version: 1,
        status: 'completed',
        result: { ...completedFitResult(), nCtx: 0 }
      }),
    /nCtx must be greater than 0/
  )
  await t.exception.all(
    () =>
      parseFitProcessResponse({
        version: 1,
        status: 'invocation-error',
        error: { name: 'TypeError', message: 42 }
      }),
    /error fields must be strings/
  )
})

test('process public boundary contains only public codec functions', (t) => {
  t.alike(Object.keys(publicProcess).sort(), [
    'FIT_PROCESS_MAX_REQUEST_BYTES',
    'FIT_PROCESS_MAX_RESPONSE_BYTES',
    'FIT_PROCESS_PROTOCOL_VERSION',
    'FIT_PROCESS_PROTOCOL_VERSION_V2',
    'encodeFitLlamaProcessRequest',
    'encodeFitProcessRequest',
    'parseFitProcessResponse',
    'resolveFitProcessRunnerPath'
  ])
  t.ok(packageJson.files.includes('process-runner.js'))
  t.ok(packageJson.files.includes('process-runner.d.ts'))
  t.ok(packageJson.files.includes('process-internal.js'))
  t.ok(packageJson.files.includes('process-internal.d.ts'))
  t.absent(packageJson.exports['./process-runner'])
  t.absent(packageJson.exports['./process-internal'])
})

test('the runner smoke is reachable from both test lanes', (t) => {
  // Both lanes must reach this file, because only the prebuild-backed one
  // un-skips the native round-trip. The wiring has to live here: reusable
  // workflows resolve from the base branch, so a workflow edit would not take
  // effect on its own PR.
  t.ok(packageJson.scripts['test:unit'].includes('npm run test:process'))
  t.ok(packageJson.scripts['test:integration'].includes('npm run test:process'))

  // The integration job appends `<platform>-<arch>`, and npm appends run args to
  // the end of the script, so the bare invocation has to be last.
  t.ok(packageJson.scripts['test:integration'].endsWith('npm run test:integration:suite'))
  t.ok(
    packageJson.scripts['test:integration:suite'].endsWith('bare test/integration/all.js --exit')
  )

  // The C++ unit targets are behind BUILD_TESTING, which is off by default, so
  // the only thing that keeps them running is a script CI can call.
  t.ok(packageJson.scripts['test:cpp:build'].includes('BUILD_TESTING=ON'))
  t.ok(packageJson.scripts['test:cpp'].includes('npm run test:cpp:build'))
  t.ok(packageJson.scripts['test:cpp'].includes('npm run test:cpp:run'))
})

test('runner path resolves to the private packaged entrypoint', (t) => {
  const resolved = resolveFitProcessRunnerPath()
  t.is(resolved, require.resolve('../../process-runner.js'))
  t.ok(path.isAbsolute(resolved))
  t.is(path.basename(resolved), 'process-runner.js')
})

test('process core handles malformed JSON without invoking fit', (t) => {
  let invoked = false
  const outcome = runFitProcessLine('not-json', () => {
    invoked = true
    throw new Error('unreachable')
  })
  t.is(outcome.exitCode, 2)
  t.is(outcome.response.status, 'invocation-error')
  t.is(outcome.response.error.name, 'SyntaxError')
  t.is(outcome.response.version, FIT_PROCESS_PROTOCOL_VERSION)
  t.is(invoked, false)
})

test('process core preserves recognizable malformed request versions', (t) => {
  for (const malformed of [
    {
      version: 2,
      loadKind: 'completion',
      config: { modelPath: '/model.gguf', params: { device: 'cpu' } },
      legacy: true
    },
    {
      version: 2,
      loadKind: 'completion',
      config: {
        modelPath: '/model.gguf',
        params: { device: 'cpu' },
        unknownField: true
      }
    },
    {
      version: 2,
      loadKind: 'completion',
      config: { modelPath: '/model.gguf', params: { device: 1 } }
    }
  ]) {
    const outcome = runFitProcessLine(JSON.stringify(malformed), () => completedFitResult())
    t.is(outcome.response.version, FIT_PROCESS_PROTOCOL_VERSION_V2)
    t.is(outcome.response.status, 'invocation-error')
    t.is(outcome.exitCode, 2)
  }

  for (const malformed of [
    { version: 1, config: { modelPath: 1 } },
    { version: 3, config: { modelPath: '/model.gguf' } },
    { config: { modelPath: '/model.gguf' } }
  ]) {
    const outcome = runFitProcessLine(JSON.stringify(malformed), () => completedFitResult())
    t.is(outcome.response.version, FIT_PROCESS_PROTOCOL_VERSION)
    t.is(outcome.response.status, 'invocation-error')
    t.is(outcome.exitCode, 2)
  }
})

test('process core preserves v1 completed and invocation-error envelopes', (t) => {
  const result = completedFitResult()
  const completed = runFitProcessLine(
    JSON.stringify({ version: 1, config: { modelPath: '/model.gguf' } }),
    () => result
  )
  t.alike(completed.response, { version: 1, status: 'completed', result })
  t.is(completed.response.result, result)
  // The outcome carries the encoded line so the runner writes it without a
  // second pass over a response that may approach 1 MiB.
  t.is(completed.responseLine, encodeFitProcessResponse(completed.response))

  const failed = runFitProcessLine(
    JSON.stringify({ version: 1, config: { modelPath: '/model.gguf' } }),
    () => {
      throw new TypeError('invalid config')
    }
  )
  t.alike(failed.response, {
    version: 1,
    status: 'invocation-error',
    error: { name: 'TypeError', message: 'invalid config' }
  })
})

test('process core bounds request and response sizes', (t) => {
  const request = runFitProcessLine('x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES), () => {
    throw new Error('unreachable')
  })
  t.is(request.exitCode, 2)
  t.ok(request.response.error.message.includes('64 KiB'))

  // One byte less leaves room for the newline the sender pays for, so the
  // failure moves from the size guard to JSON parsing.
  const withinBudget = runFitProcessLine('x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES - 1), () => {
    throw new Error('unreachable')
  })
  t.is(withinBudget.response.error.name, 'SyntaxError')

  const response = runFitProcessLine(
    JSON.stringify({ version: 1, config: { modelPath: '/model.gguf' } }),
    () => ({ detail: 'x'.repeat(FIT_PROCESS_MAX_RESPONSE_BYTES) })
  )
  t.is(response.exitCode, 1)
  t.ok(response.response.error.message.includes('1 MiB'))
  t.ok(Buffer.byteLength(response.responseLine, 'utf8') <= FIT_PROCESS_MAX_RESPONSE_BYTES)
})

test('every request the encoder produces fits the runner budget', (t) => {
  const probe = encodeFitProcessRequest({ modelPath: '/model.gguf', backendsDir: '/' })
  const padding = FIT_PROCESS_MAX_REQUEST_BYTES - Buffer.byteLength(probe, 'utf8')
  const line = encodeFitProcessRequest({
    modelPath: '/model.gguf',
    backendsDir: `/${'x'.repeat(padding)}`
  })

  t.is(Buffer.byteLength(line, 'utf8'), FIT_PROCESS_MAX_REQUEST_BYTES)

  let invoked = false
  const outcome = runFitProcessLine(line.slice(0, -1), () => {
    invoked = true
    return completedFitResult()
  })

  t.is(outcome.exitCode, 0)
  t.is(invoked, true)
})

test('response encoding accepts the 1 MiB byte boundary', (t) => {
  const message = messageForEncodedBytes(FIT_PROCESS_MAX_RESPONSE_BYTES)
  const atBoundary = invocationErrorResponse(message)

  t.is(encodedResponseBytes(atBoundary), FIT_PROCESS_MAX_RESPONSE_BYTES)

  const line = encodeFitProcessResponse(atBoundary)
  t.is(Buffer.byteLength(line, 'utf8'), FIT_PROCESS_MAX_RESPONSE_BYTES)
})

test('response encoding rejects above the 1 MiB byte boundary', async (t) => {
  const message = messageForEncodedBytes(FIT_PROCESS_MAX_RESPONSE_BYTES + 1)

  await t.exception.all(
    () => encodeFitProcessResponse(invocationErrorResponse(message)),
    /Fit process response exceeds 1 MiB/
  )
})

test('response encoder is newline-delimited', (t) => {
  const response = {
    version: 1,
    status: 'invocation-error',
    error: { name: 'Error', message: 'failure' }
  }
  t.is(encodeFitProcessResponse(response), `${JSON.stringify(response)}\n`)
})

// No prebuild guard: a malformed request is answered without loading the addon,
// so this runs everywhere and covers the spawn/flush/exit path on its own.
test('runner writes one flushed malformed-request response', async (t) => {
  const outcome = await runRunner('not-json\n')
  const response = JSON.parse(outcome.stdout)
  t.is(outcome.code, 2)
  t.is(outcome.signal, null)
  t.is(response.status, 'invocation-error')
  t.is(response.error.name, 'SyntaxError')
  t.is(outcome.stdout.split('\n').length, 2)
  t.is(outcome.stderr, '')
})

test('fit process runner answers a closed stdin without a request', async (t) => {
  const outcome = await runRunner('')

  t.is(outcome.code, 2)
  t.is(JSON.parse(outcome.stdout).status, 'invocation-error')
})

test(
  'runner returns a real v1 fit through the native boundary',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    t.timeout(NATIVE_DEADLINE_MS * 1.5)

    // The only test that loads the addon in the child. A path that cannot exist
    // is a documented ERROR outcome rather than a throw, so this exercises
    // native load, backend registration and the response encoding without a
    // model file. A crash is a failure here, not a tolerated outcome: the child
    // exists so the crash is isolated, not so it can be reported as a pass.
    const outcome = await runRunner(
      encodeFitProcessRequest({
        modelPath: path.join(__dirname, 'no-such-model.gguf')
      }),
      NATIVE_DEADLINE_MS
    )
    t.is(
      outcome.signal,
      null,
      `native runner must not crash; code=${outcome.code} stderr=${outcome.stderr}`
    )
    const response = parseFitProcessResponse(JSON.parse(outcome.stdout))

    t.is(outcome.code, 0)
    t.is(response.status, 'completed')
    t.is(response.result.status, 2)
    t.ok(['model-unreadable', 'no-backend-device'].includes(response.result.reason))
  }
)

function messageForEncodedBytes(targetBytes) {
  const baseBytes = encodedResponseBytes(invocationErrorResponse(''))
  return 'x'.repeat(Math.max(0, targetBytes - baseBytes))
}
