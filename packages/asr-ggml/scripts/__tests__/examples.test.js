'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { parseQuickstartArguments, USAGE } = require('../../examples/quickstart-arguments.js')
const {
  parseMicChunkMs,
  buildMicChunkOptions,
  startDiarizedMic,
  finishDiarizedMic
} = require('../../examples/parakeet-diarized-mic-options.js')

const packageRoot = path.resolve(__dirname, '..', '..')
const examplesRoot = path.join(packageRoot, 'examples')
const relativeImportPattern = /require\(['"](\.[^'"]+)['"]\)/g
const helperFiles = new Set([
  'constants.js',
  'ffmpeg.js',
  'parakeet-diarized-mic-options.js',
  'parakeet-long-form-arguments.js',
  'parakeet-utils.js',
  'quickstart-arguments.js'
])

function getExampleFiles() {
  return fs
    .readdirSync(examplesRoot)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => path.join(examplesRoot, fileName))
}

function getRunnableExampleTargets() {
  return getExampleFiles()
    .map((filePath) => path.basename(filePath))
    .filter((fileName) => !helperFiles.has(fileName))
    .map((fileName) => `examples/${fileName}`)
    .sort()
}

function getScriptTargets(scripts) {
  return Object.entries(scripts)
    .filter(([name]) => name.startsWith('example:'))
    .map(([, command]) => command.split(/\s+/)[1])
    .sort()
}

function getRelativeImports(filePath) {
  return [...fs.readFileSync(filePath, 'utf8').matchAll(relativeImportPattern)].map(
    (match) => match[1]
  )
}

function assertRelativeImportsResolve(filePath) {
  for (const importPath of getRelativeImports(filePath)) {
    const resolvedPath = path.resolve(path.dirname(filePath), importPath)
    assert.ok(
      fs.existsSync(resolvedPath),
      `${path.basename(filePath)} imports missing ${importPath}`
    )
  }
}

test('all example relative imports resolve', () => {
  getExampleFiles().forEach(assertRelativeImportsResolve)
})

test('package scripts cover every runnable example', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(getScriptTargets(packageJson.scripts), getRunnableExampleTargets())
})

test('quickstart parses audio, model, and VAD paths in positional order', () => {
  assert.deepEqual(parseQuickstartArguments(['audio.raw', 'model.bin', 'vad.bin']), {
    audioPath: 'audio.raw',
    modelPath: 'model.bin',
    vadModelPath: 'vad.bin'
  })
  assert.deepEqual(parseQuickstartArguments([]), {
    audioPath: undefined,
    modelPath: undefined,
    vadModelPath: undefined
  })
  assert.throws(() => parseQuickstartArguments(['a', 'b', 'c', 'd']), {
    message: USAGE
  })
})

test('diarized mic chunk overrides target separate sessions', () => {
  const diarChunkMs = parseMicChunkMs('--chunk-ms', '2000')
  assert.deepEqual(buildMicChunkOptions({ diarChunkMs }), {
    asrOptions: {},
    diarStreamingChunkMs: 2000
  })
  const asrChunkMs = parseMicChunkMs('--asr-chunk-ms', '80')
  assert.deepEqual(buildMicChunkOptions({ asrChunkMs, diarChunkMs: 3000 }), {
    asrOptions: { chunkMs: 80 },
    diarStreamingChunkMs: 3000
  })
  assert.throws(() => parseMicChunkMs('--diar-chunk-ms', '80'))
})

function micSession(name, calls, backendInfo = {}, options, startupError) {
  const model = {
    async load() {
      calls.push(`${name} load`)
    },
    getBackendInfo() {
      return backendInfo
    },
    async runStreaming(stream, receivedOptions) {
      assert.equal(stream, session.stream)
      assert.equal(receivedOptions, options)
      calls.push(`${name} start`)
      if (startupError) throw startupError
      return {
        onUpdate() {
          return this
        },
        await() {
          return Promise.resolve()
        }
      }
    },
    async unload() {
      calls.push(`${name} unload`)
    }
  }
  const session = {
    model,
    options,
    onUpdate() {},
    stream: {
      end() {
        calls.push(`${name} end`)
      }
    }
  }
  return session
}

test('diarized mic accepts Unified RNN-T and rejects offline RNN-T', async () => {
  for (const [modelType, supportsCacheAwareStreaming] of [
    ['rnnt', true],
    ['rnnt', false],
    ['nemotron', true],
    ['tdt', false]
  ]) {
    const calls = []
    const asr = micSession('asr', calls, { modelType, supportsCacheAwareStreaming })
    const diar = micSession('diar', calls)
    const start = () => startDiarizedMic(asr, diar, () => calls.push('capture'))

    if (supportsCacheAwareStreaming) {
      const { runs } = await start()
      assert.deepEqual(calls, ['asr load', 'diar load', 'asr start', 'diar start', 'capture'])
      await finishDiarizedMic([asr, diar], runs)
    } else {
      await assert.rejects(start, /requires a cache-aware ASR checkpoint/)
      assert.deepEqual(calls, ['asr load', 'asr end', 'diar end', 'asr unload', 'diar unload'])
    }
  }
})

test('an invalid Nemotron cadence closes the sessions before capture can start', async () => {
  const calls = []
  const cadence = parseMicChunkMs('--asr-chunk-ms', '1000')
  const { asrOptions } = buildMicChunkOptions({ asrChunkMs: cadence })
  const rejection = new Error('unsupported Nemotron chunk_ms')
  const asr = micSession(
    'asr',
    calls,
    { modelType: 'nemotron', supportsCacheAwareStreaming: true },
    asrOptions,
    rejection
  )
  const diar = micSession('diar', calls)

  await assert.rejects(
    startDiarizedMic(asr, diar, () => calls.push('capture')),
    rejection
  )
  assert.deepEqual(calls, [
    'asr load',
    'diar load',
    'asr start',
    'asr end',
    'diar end',
    'asr unload',
    'diar unload'
  ])
})
