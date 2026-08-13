'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { parseQuickstartArguments, USAGE } = require('../../examples/quickstart-arguments.js')

const packageRoot = path.resolve(__dirname, '..', '..')
const examplesRoot = path.join(packageRoot, 'examples')
const relativeImportPattern = /require\(['"](\.[^'"]+)['"]\)/g

const expectedScripts = {
  'example:whisper:live': 'bare examples/example.live-transcription.js',
  'example:whisper:chunking': 'bare examples/example.audio-ctx-chunking.js',
  'example:whisper:reload': 'bare examples/example.reload.js',
  'example:whisper:decoder': 'bare examples/example.decoder.js',
  'example:parakeet:indic': 'bare examples/parakeet-indic-conformer-transcribe.js',
  'example:parakeet:mic-diarize-aosc': 'bare examples/parakeet-live-mic-diarized-aosc.js',
  'example:parakeet:decode': 'bare examples/parakeet-decode-audio.js'
}

function getExampleFiles() {
  return fs
    .readdirSync(examplesRoot)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => path.join(examplesRoot, fileName))
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

test('all documented example scripts are runnable package scripts', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expectedScripts).map((name) => [name, packageJson.scripts[name]])
    ),
    expectedScripts
  )
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
