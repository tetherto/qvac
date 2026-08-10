'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const {
  FIT_PROCESS_PROTOCOL_VERSION,
  FIT_PROCESS_MAX_REQUEST_BYTES,
  FIT_PROCESS_MAX_RESPONSE_BYTES,
  encodeFitProcessRequest,
  parseFitProcessRequest,
  parseFitProcessResponse,
  encodeFitProcessResponse,
  resolveFitProcessRunnerPath,
  runFitProcessLine
} = require('../../process')
const packageJson = require('../../package.json')

const PREBUILDS_DIR = path.join(__dirname, '../../prebuilds')
const HAS_NATIVE_PREBUILD =
  fs.existsSync(path.join(PREBUILDS_DIR, `${process.platform}-${process.arch}`)) ||
  (process.platform === 'darwin' && fs.existsSync(path.join(PREBUILDS_DIR, 'darwin-universal')))

function runRunner (input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolveFitProcessRunnerPath()], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
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
  t.absent(packageJson.exports['./process-runner'])
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
})

test('fit process core rejects requests above the 64 KiB limit', (t) => {
  let invoked = false
  const outcome = runFitProcessLine('x'.repeat(FIT_PROCESS_MAX_REQUEST_BYTES + 1), () => {
    invoked = true
    throw new Error('unreachable')
  })

  t.is(outcome.exitCode, 2)
  t.is(outcome.response.status, 'invocation-error')
  t.ok(outcome.response.error.message.includes('64 KiB'))
  t.is(invoked, false)
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
  t.ok(Buffer.byteLength(encodeFitProcessResponse(outcome.response), 'utf8') <= FIT_PROCESS_MAX_RESPONSE_BYTES)
})

test('fit process runner writes one flushed JSON response', { skip: !HAS_NATIVE_PREBUILD }, async (t) => {
  const outcome = await runRunner('not-json\n')
  const response = JSON.parse(outcome.stdout)

  t.is(outcome.code, 2)
  t.is(outcome.signal, null)
  t.is(response.status, 'invocation-error')
  t.is(response.error.name, 'SyntaxError')
  t.is(outcome.stdout.split('\n').length, 2)
  t.is(outcome.stderr, '')
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
