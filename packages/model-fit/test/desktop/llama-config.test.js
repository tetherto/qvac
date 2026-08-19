'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const process = require('bare-process')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const {
  FIT_PROCESS_PROTOCOL_VERSION_V2,
  encodeFitLlamaProcessRequest,
  parseFitProcessResponse
} = require('../../process')
const { parseFitProcessRequest, runFitProcessLine } = require('../../process-internal')

const PREBUILDS_DIR = path.join(__dirname, '../../prebuilds')
const HAS_NATIVE_PREBUILD =
  fs.existsSync(path.join(PREBUILDS_DIR, `${process.platform}-${process.arch}`)) ||
  (process.platform === 'darwin' && fs.existsSync(path.join(PREBUILDS_DIR, 'darwin-universal')))
const publicIndex = HAS_NATIVE_PREBUILD ? require('../../index') : undefined

function runRunner(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('../../process-runner.js')], {
      stdio: ['overlapped', 'overlapped', 'overlapped']
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

function runDirectBinding(config, loadKind = 'completion') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'direct-binding-runner.js'), JSON.stringify({ loadKind, ...config })],
      { stdio: ['ignore', 'overlapped', 'overlapped'] }
    )
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
  })
}

const config = {
  modelPath: path.resolve('/tmp/model.gguf'),
  params: {
    device: 'cpu',
    'ctx-size': '2048'
  },
  marginMiB: 512,
  nCtxMin: 1024
}

test('v2 encodes an explicit neutral load kind without correlation fields', (t) => {
  const line = encodeFitLlamaProcessRequest('embedding', config)
  t.alike(JSON.parse(line), {
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    loadKind: 'embedding',
    config
  })
})

test('v2 parses an explicit neutral load kind', (t) => {
  const request = parseFitProcessRequest({
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    loadKind: 'completion',
    config
  })
  t.alike(request, {
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    loadKind: 'completion',
    config
  })
})

test('v2 rejects missing and unknown load kinds', async (t) => {
  await t.exception.all(
    () => encodeFitLlamaProcessRequest('llm', config),
    /loadKind must be 'completion' or 'embedding'/
  )
  for (const loadKind of [undefined, 'llm']) {
    await t.exception.all(
      () =>
        parseFitProcessRequest({
          version: FIT_PROCESS_PROTOCOL_VERSION_V2,
          loadKind,
          config
        }),
      /loadKind must be 'completion' or 'embedding'/
    )
  }
})

test('top-level API does not export raw llama fitting', (t) => {
  if (publicIndex === undefined) {
    t.pass('native-only export check skipped before prebuild availability')
    return
  }
  t.alike(Object.keys(publicIndex).sort(), ['FIT_STATUS', 'fitParams'])
})

test('v2 rejects legacy envelope fields while v1 remains permissive', async (t) => {
  for (const key of ['fingerprint', 'fitContractVersion']) {
    await t.exception.all(
      () =>
        parseFitProcessRequest({
          version: FIT_PROCESS_PROTOCOL_VERSION_V2,
          loadKind: 'completion',
          config,
          [key]: 'legacy'
        }),
      new RegExp(`unknown v2 envelope field.*${key}`)
    )

    t.alike(
      parseFitProcessRequest({
        version: 1,
        config: { modelPath: config.modelPath },
        [key]: 'legacy'
      }),
      {
        version: 1,
        config: { modelPath: config.modelPath }
      }
    )
  }
})

test('v2 dispatches load kind and params to the llama fit function', (t) => {
  let received
  const result = {
    status: 2,
    fits: false,
    reason: 'unsupported-config',
    maxDevices: 0,
    nDevices: 0,
    nGpuDevices: 0
  }
  const outcome = runFitProcessLine(
    JSON.stringify({
      version: FIT_PROCESS_PROTOCOL_VERSION_V2,
      loadKind: 'embedding',
      config
    }),
    () => {
      throw new Error('v1 fit must not run')
    },
    (loadKind, value) => {
      received = { loadKind, config: value }
      return result
    }
  )

  t.alike(received, { loadKind: 'embedding', config })
  t.alike(outcome.response, {
    version: FIT_PROCESS_PROTOCOL_VERSION_V2,
    status: 'completed',
    result
  })
})

test('v2 validates raw config shape before native allocation', async (t) => {
  await t.exception.all(
    () =>
      encodeFitLlamaProcessRequest('completion', {
        modelPath: config.modelPath,
        params: { device: 1 }
      }),
    /params\.device must be a string/
  )

  await t.exception.all(
    () =>
      encodeFitLlamaProcessRequest('completion', {
        modelPath: config.modelPath,
        params: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`key-${index}`, 'value'])
        )
      }),
    /must not contain more than 256 entries/
  )
  await t.exception.all(
    () =>
      encodeFitLlamaProcessRequest('completion', {
        modelPath: '',
        params: { device: 'cpu' }
      }),
    /modelPath must be a non-empty string/
  )
})

test('all v2 boundaries reject unknown config fields', async (t) => {
  for (const key of ['marginMib', 'fingerprint', 'fitContractVersion']) {
    const invalid = { ...config, [key]: key === 'marginMib' ? 512 : 'legacy' }
    await t.exception.all(
      () => encodeFitLlamaProcessRequest('completion', invalid),
      new RegExp(`unknown top-level field.*${key}`)
    )
    await t.exception.all(
      () =>
        parseFitProcessRequest({
          version: FIT_PROCESS_PROTOCOL_VERSION_V2,
          loadKind: 'completion',
          config: invalid
        }),
      new RegExp(`unknown top-level field.*${key}`)
    )

    if (HAS_NATIVE_PREBUILD) {
      const direct = await runDirectBinding(invalid)
      t.is(direct.signal, null, `${key} must be rejected before backend initialization`)
      t.is(direct.code, 0)
      t.ok(JSON.parse(direct.stdout).message.includes(key))
      t.is(direct.stderr, '')
    }
  }
})

test(
  'direct binding rejects relationships before backend initialization',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    for (const invalid of [
      {
        modelPath: config.modelPath,
        params: {
          device: 'cpu',
          'batch-size': '128',
          'ubatch-size': '256'
        }
      },
      {
        modelPath: config.modelPath,
        params: { device: 'cpu', 'ctx-size': '512' },
        nCtxMin: 1024
      }
    ]) {
      const direct = await runDirectBinding(invalid)
      t.is(direct.signal, null, 'invalid relationship must not initialize a backend')
      t.is(direct.code, 0)
      t.is(JSON.parse(direct.stdout).ok, false)
      t.is(direct.stderr, '')
    }
  }
)

test(
  'direct binding narrows fit-critical integers before backend initialization',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    for (const [key, value] of [
      ['ctx-size', '2147483648'],
      ['ctx_size', '2147483648'],
      ['ctx-size', '-2147483649'],
      ['batch-size', '2147483648'],
      ['batch_size', '2147483648'],
      ['ubatch-size', '2147483648'],
      ['ubatch_size', '2147483648'],
      ['parallel', '2147483648'],
      ['gpu-layers', '2147483648'],
      ['gpu_layers', '2147483648'],
      ['n-gpu-layers', '2147483648'],
      ['n_gpu_layers', '2147483648'],
      ['main-gpu', '2147483648'],
      ['main_gpu', '2147483648'],
      ['fit-ctx', '2147483648'],
      ['fit_ctx', '2147483648'],
      ['n-cpu-moe', '2147483648'],
      ['n_cpu_moe', '2147483648'],
      ['main-gpu', 'sideways'],
      ['parallel', 'not-an-integer']
    ]) {
      const direct = await runDirectBinding({
        modelPath: config.modelPath,
        params: { device: 'cpu', [key]: value }
      })
      t.is(direct.signal, null, `${key}=${value} must not initialize a backend`)
      t.is(direct.code, 0)
      t.is(JSON.parse(direct.stdout).ok, false)
      t.is(direct.stderr, '')
    }
  }
)

test(
  'direct binding leaves numeric-looking string handlers untouched',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    const direct = await runDirectBinding({
      modelPath: config.modelPath,
      params: {
        device: 'cpu',
        'tensor-split': '2147483648',
        'batch-size': '128',
        'ubatch-size': '256'
      }
    })
    t.is(direct.signal, null)
    t.is(direct.code, 0)
    t.ok(JSON.parse(direct.stdout).message.includes('ubatch-size'))
    t.is(direct.stderr, '')
  }
)

test(
  'symbolic main-gpu reaches unsupported config through direct and process paths',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    for (const [key, value] of [
      ['main-gpu', 'integrated'],
      ['main_gpu', 'integrated'],
      ['main-gpu', 'dedicated'],
      ['main_gpu', 'dedicated']
    ]) {
      const symbolic = {
        modelPath: path.join(__dirname, 'no-such-model.gguf'),
        params: { device: 'gpu', [key]: value }
      }
      const direct = await runDirectBinding(symbolic)
      t.is(direct.signal, null)
      t.is(direct.code, 0)
      t.is(JSON.parse(direct.stdout).result.reason, 'unsupported-config')
      t.is(direct.stderr, '')

      const processOutcome = await runRunner(encodeFitLlamaProcessRequest('completion', symbolic))
      t.is(processOutcome.signal, null)
      t.is(processOutcome.code, 0)
      t.is(
        parseFitProcessResponse(JSON.parse(processOutcome.stdout)).result.reason,
        'unsupported-config'
      )
      t.is(processOutcome.stderr, '')
    }
  }
)

test(
  'known unsupported configs win before model and backend checks',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    for (const setting of [
      { lora: '/adapter.gguf' },
      { shards: '2' },
      { stream: 'true' },
      { mmproj: '/projector.gguf' },
      { finetune: 'true' },
      { 'rope-scale': '2' },
      { yarn_orig_ctx: '4096' },
      { 'unknown-setting': '1' }
    ]) {
      const direct = await runDirectBinding({
        modelPath: path.join(__dirname, 'no-such-model.gguf'),
        params: { device: 'cpu', ...setting }
      })
      t.is(direct.signal, null)
      t.is(direct.code, 0)
      t.is(JSON.parse(direct.stdout).result.reason, 'unsupported-config')
      t.is(direct.stderr, '')
    }
  }
)

test(
  'v2 round-trips through the disposable native runner',
  { skip: !HAS_NATIVE_PREBUILD },
  async (t) => {
    const outcome = await runRunner(
      encodeFitLlamaProcessRequest('completion', {
        modelPath: path.join(__dirname, 'no-such-model.gguf'),
        params: { device: 'cpu' }
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

    t.is(outcome.code, 0)
    const response = parseFitProcessResponse(JSON.parse(outcome.stdout))
    t.is(response.version, FIT_PROCESS_PROTOCOL_VERSION_V2)
    t.is(response.status, 'completed')
    t.is(response.result.status, 2)
    t.ok(['model-unreadable', 'no-backend-device'].includes(response.result.reason))
  }
)
