'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const publicProcess = require('../../process')
const {
  FIT_PROCESS_PROTOCOL_VERSION,
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

const RUNNER_DEADLINE_MS = 10_000
// A cold spawn on darwin compiles the embedded Metal library before the fitter
// can answer, which is far slower than the protocol paths.
const NATIVE_DEADLINE_MS = 120_000

// The runner has no timeout of its own, so the harness supplies one. Without it
// a stuck child is a bare assertion timeout with no output and an orphaned
// process left on the runner.
function runRunner (input, deadlineMs = RUNNER_DEADLINE_MS) {
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
      reject(new Error(
        `runner did not exit within ${deadlineMs}ms; ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
      ))
    }, deadlineMs)

    function settle (result, error) {
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

function invocationErrorResponse (message) {
  return {
    version: 1,
    status: 'invocation-error',
    error: { name: 'Error', message }
  }
}

function encodedResponseBytes (response) {
  return Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8')
}

function completedFitResult () {
  return {
    status: 0,
    fits: true,
    reason: 'fits',
    nGpuLayers: 24,
    nCtx: 4096,
    nBatch: 512,
    nUbatch: 128,
    tensorSplit: [0.6, 0.4],
    buftOverrides: [
      { pattern: 'blk\\.0\\.ffn_.*', bufferType: 'CPU' }
    ],
    splitMode: 1,
    mainGpu: 0,
    typeK: 1,
    typeV: 1,
    flashAttnType: 1,
    maxDevices: 16,
    nDevices: 3,
    nGpuDevices: 2
  }
}

test('fit process protocol size constants are fixed', (t) => {
  t.is(FIT_PROCESS_MAX_REQUEST_BYTES, 64 * 1024)
  t.is(FIT_PROCESS_MAX_RESPONSE_BYTES, 1024 * 1024)
})

test('fit process request encoding is versioned and newline delimited', (t) => {
  const config = { modelPath: path.resolve('/tmp/model.gguf'), nCtx: 4096 }
  const line = encodeFitProcessRequest(config)

  t.ok(line.endsWith('\n'))
  t.alike(JSON.parse(line), {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config
  })
})

test('fit process request encoding rejects requests above 64 KiB', async (t) => {
  await t.exception.all(
    () => encodeFitProcessRequest({
      modelPath: path.resolve('/tmp/model.gguf'),
      backendsDir: `/${'x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES)}`
    }),
    /Fit process request exceeds 64 KiB/
  )
})

test('fit process protocol accepts a versioned request', (t) => {
  const request = parseFitProcessRequest({
    version: FIT_PROCESS_PROTOCOL_VERSION,
    config: { modelPath: path.resolve('/tmp/model.gguf'), nCtx: 4096 }
  })

  t.is(request.version, 1)
  t.is(request.config.nCtx, 4096)
})

test('fit process protocol rejects unknown versions', async (t) => {
  await t.exception.all(
    () => parseFitProcessRequest({ version: 2, config: { modelPath: '/tmp/model.gguf' } }),
    /Unsupported fit process protocol version/
  )
})

test('fit process protocol rejects malformed envelopes', async (t) => {
  await t.exception.all(() => parseFitProcessRequest(null), /request must be an object/)
  await t.exception.all(() => parseFitProcessRequest({ version: 1 }), /config must be an object/)
  await t.exception.all(
    () => parseFitProcessRequest({ version: 1, config: { modelPath: 42 } }),
    /modelPath must be a string/
  )
})

test('fit process response encoding is newline delimited', (t) => {
  const line = encodeFitProcessResponse({
    version: 1,
    status: 'invocation-error',
    error: { name: 'TypeError', message: 'invalid' }
  })

  t.ok(line.endsWith('\n'))
  t.alike(JSON.parse(line), {
    version: 1,
    status: 'invocation-error',
    error: { name: 'TypeError', message: 'invalid' }
  })
})

test('fit process response parsing accepts completed FitResults', (t) => {
  const result = completedFitResult()
  const response = parseFitProcessResponse({
    version: FIT_PROCESS_PROTOCOL_VERSION,
    status: 'completed',
    result
  })

  t.alike(response, {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    status: 'completed',
    result
  })
})

test('fit process response parsing accepts invocation errors', (t) => {
  const response = parseFitProcessResponse({
    version: FIT_PROCESS_PROTOCOL_VERSION,
    status: 'invocation-error',
    error: { name: 'TypeError', message: 'invalid config' }
  })

  t.alike(response, {
    version: FIT_PROCESS_PROTOCOL_VERSION,
    status: 'invocation-error',
    error: { name: 'TypeError', message: 'invalid config' }
  })
})

test('fit process response parsing rejects malformed envelopes', async (t) => {
  await t.exception.all(() => parseFitProcessResponse(null), /response must be an object/)
  await t.exception.all(
    () => parseFitProcessResponse({ version: 2, status: 'completed', result: completedFitResult() }),
    /Unsupported fit process protocol version/
  )
  await t.exception.all(
    () => parseFitProcessResponse({ version: 1, status: 'unknown' }),
    /response status/
  )
  await t.exception.all(
    () => parseFitProcessResponse({
      version: 1,
      status: 'invocation-error',
      error: { name: 'TypeError', message: 42 }
    }),
    /error message must be a string/
  )
})

test('fit process response parsing validates canonical FitResults', async (t) => {
  const missingPlanField = completedFitResult()
  delete missingPlanField.nCtx

  await t.exception.all(
    () => parseFitProcessResponse({
      version: 1,
      status: 'completed',
      result: missingPlanField
    }),
    /result nCtx must be a number/
  )
  await t.exception.all(
    () => parseFitProcessResponse({
      version: 1,
      status: 'completed',
      result: { ...completedFitResult(), fits: false }
    }),
    /result fits must be true/
  )
  await t.exception.all(
    () => parseFitProcessResponse({
      version: 1,
      status: 'completed',
      result: {
        ...completedFitResult(),
        buftOverrides: [{ pattern: 'blk\\..*', bufferType: 1 }]
      }
    }),
    /bufferType must be a string/
  )
})

test('fit process runner remains packaged but is not publicly exported', (t) => {
  t.ok(packageJson.files.includes('process-runner.js'))
  t.ok(packageJson.files.includes('process-runner.d.ts'))
  t.ok(packageJson.files.includes('process-internal.js'))
  t.ok(packageJson.files.includes('process-internal.d.ts'))
  t.absent(packageJson.exports['./process-runner'])
  t.absent(packageJson.exports['./process-internal'])
})

test('fit process public boundary excludes runner internals', (t) => {
  t.alike(Object.keys(publicProcess).sort(), [
    'FIT_PROCESS_MAX_REQUEST_BYTES',
    'FIT_PROCESS_MAX_RESPONSE_BYTES',
    'FIT_PROCESS_PROTOCOL_VERSION',
    'encodeFitProcessRequest',
    'parseFitProcessResponse',
    'resolveFitProcessRunnerPath'
  ])
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
  t.ok(packageJson.scripts['test:integration:suite'].endsWith('bare test/integration/all.js --exit'))
})

test('fit process runner path resolves to the published entrypoint', (t) => {
  const resolved = resolveFitProcessRunnerPath()

  t.is(resolved, require.resolve('../../process-runner.js'))
  t.ok(path.isAbsolute(resolved))
  t.is(path.basename(resolved), 'process-runner.js')
})

test('fit process core rejects malformed JSON without invoking fit', (t) => {
  let invoked = false
  const outcome = runFitProcessLine('not-json', () => {
    invoked = true
    throw new Error('unreachable')
  })

  t.is(outcome.exitCode, 2)
  t.is(outcome.response.status, 'invocation-error')
  t.is(outcome.response.error.name, 'SyntaxError')
  t.is(invoked, false)
})

test('fit process core maps fit validation failures to a response', (t) => {
  const outcome = runFitProcessLine(
    JSON.stringify({
      version: 1,
      config: { modelPath: 'relative.gguf' }
    }),
    (config) => {
      if (!path.isAbsolute(config.modelPath)) {
        throw new TypeError('model-fit: config.modelPath must be an absolute path')
      }
      throw new Error('unreachable')
    }
  )

  t.is(outcome.exitCode, 1)
  t.is(outcome.response.status, 'invocation-error')
  t.ok(outcome.response.error.message.includes('absolute'))
})

test('fit process core passes a completed FitResult through unchanged', (t) => {
  const result = completedFitResult()
  const outcome = runFitProcessLine(
    JSON.stringify({
      version: 1,
      config: { modelPath: '/tmp/model.gguf' }
    }),
    () => result
  )

  t.is(outcome.exitCode, 0)
  t.alike(outcome.response, {
    version: 1,
    status: 'completed',
    result
  })
  t.is(outcome.response.result, result)
  t.alike(outcome.response.result, result)

  // The outcome carries the encoded line so the runner writes it without a
  // second pass over a response that may approach 1 MiB.
  t.is(outcome.responseLine, encodeFitProcessResponse(outcome.response))
})

test('fit process core rejects requests above the 64 KiB limit', (t) => {
  let invoked = false
  const overBudget = runFitProcessLine('x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES), () => {
    invoked = true
    throw new Error('unreachable')
  })

  t.is(overBudget.exitCode, 2)
  t.is(overBudget.response.status, 'invocation-error')
  t.ok(overBudget.response.error.message.includes('64 KiB'))
  t.is(invoked, false)

  // One byte less leaves room for the newline the sender pays for, so the
  // failure moves from the size guard to JSON parsing.
  const withinBudget = runFitProcessLine('x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES - 1), () => {
    throw new Error('unreachable')
  })

  t.is(withinBudget.response.error.name, 'SyntaxError')
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

test('fit process core maps oversized responses to invocation errors', (t) => {
  const outcome = runFitProcessLine(
    JSON.stringify({
      version: 1,
      config: { modelPath: '/tmp/model.gguf' }
    }),
    () => ({ detail: 'x'.repeat(FIT_PROCESS_MAX_RESPONSE_BYTES) })
  )

  t.is(outcome.exitCode, 1)
  t.is(outcome.response.status, 'invocation-error')
  t.ok(outcome.response.error.message.includes('1 MiB'))
  t.ok(Buffer.byteLength(outcome.responseLine, 'utf8') <= FIT_PROCESS_MAX_RESPONSE_BYTES)
})

// No prebuild guard: a malformed request is answered without loading the addon,
// so this runs everywhere and covers the spawn/flush/exit path on its own.
test('fit process runner writes one flushed JSON response', async (t) => {
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

test('fit process runner returns a real fit through the boundary', { skip: !HAS_NATIVE_PREBUILD }, async (t) => {
  t.timeout(NATIVE_DEADLINE_MS * 1.5)

  // The only test that loads the addon in the child. A path that cannot exist is
  // a documented ERROR outcome rather than a throw, so this exercises native
  // load, backend registration and the response encoding without a model file.
  const outcome = await runRunner(encodeFitProcessRequest({
    modelPath: path.join(__dirname, 'no-such-model.gguf')
  }), NATIVE_DEADLINE_MS)
  const response = parseFitProcessResponse(JSON.parse(outcome.stdout))

  t.is(outcome.code, 0)
  t.is(response.status, 'completed')
  t.is(response.result.status, 2)
  t.ok(['model-unreadable', 'no-backend-device'].includes(response.result.reason))
})

function messageForEncodedBytes (targetBytes) {
  const baseBytes = encodedResponseBytes(invocationErrorResponse(''))
  return 'x'.repeat(Math.max(0, targetBytes - baseBytes))
}

test('fit process response encoding accepts the 1 MiB byte boundary', (t) => {
  const message = messageForEncodedBytes(FIT_PROCESS_MAX_RESPONSE_BYTES)
  const atBoundary = invocationErrorResponse(message)

  t.is(encodedResponseBytes(atBoundary), FIT_PROCESS_MAX_RESPONSE_BYTES)

  const line = encodeFitProcessResponse(atBoundary)
  t.is(Buffer.byteLength(line, 'utf8'), FIT_PROCESS_MAX_RESPONSE_BYTES)
})

test('fit process response encoding rejects above the 1 MiB byte boundary', async (t) => {
  const message = messageForEncodedBytes(FIT_PROCESS_MAX_RESPONSE_BYTES + 1)

  await t.exception.all(
    () => encodeFitProcessResponse(invocationErrorResponse(message)),
    /Fit process response exceeds 1 MiB/
  )
})
