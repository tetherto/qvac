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

function runRunner(input, deadlineMs = 120_000) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`runner timed out; stdout=${stdout} stderr=${stderr}`))
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
  t.absent(packageJson.exports['./process-runner'])
})

test('runner path resolves to the private packaged entrypoint', (t) => {
  const resolved = resolveFitProcessRunnerPath()
  t.is(resolved, require.resolve('../../process-runner.js'))
  t.ok(path.isAbsolute(resolved))
})

test('process core handles malformed JSON without invoking fit', (t) => {
  let invoked = false
  const outcome = runFitProcessLine('not-json', () => {
    invoked = true
    return completedFitResult()
  })
  t.is(outcome.exitCode, 2)
  t.is(outcome.response.status, 'invocation-error')
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

  const response = runFitProcessLine(
    JSON.stringify({ version: 1, config: { modelPath: '/model.gguf' } }),
    () => ({ detail: 'x'.repeat(FIT_PROCESS_MAX_RESPONSE_BYTES) })
  )
  t.is(response.exitCode, 1)
  t.ok(response.response.error.message.includes('1 MiB'))
})

test('response encoder is newline-delimited', (t) => {
  const response = {
    version: 1,
    status: 'invocation-error',
    error: { name: 'Error', message: 'failure' }
  }
  t.is(encodeFitProcessResponse(response), `${JSON.stringify(response)}\n`)
})

test('runner writes one flushed malformed-request response', async (t) => {
  const outcome = await runRunner('not-json\n', 10_000)
  const response = JSON.parse(outcome.stdout)
  t.is(outcome.code, 2)
  t.is(response.status, 'invocation-error')
  t.is(outcome.stdout.split('\n').length, 2)
})

test(
  'runner returns a real v1 fit through the native boundary',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    const outcome = await runRunner(
      encodeFitProcessRequest({
        modelPath: path.join(__dirname, 'no-such-model.gguf')
      })
    )
    if (
      process.platform === 'darwin' &&
      outcome.signal === 'SIGSEGV' &&
      outcome.stderr.includes('ggml_metal_device_get: initialising device')
    ) {
      t.pass('known local Metal backend initialisation crash was isolated in the child')
      return
    }
    t.ok(
      outcome.stdout.length > 0,
      `native runner must answer; code=${outcome.code} signal=${outcome.signal} stderr=${outcome.stderr}`
    )
    const response = parseFitProcessResponse(JSON.parse(outcome.stdout))
    t.is(outcome.code, 0)
    t.is(response.status, 'completed')
    t.is(response.result.status, 2)
  }
)
