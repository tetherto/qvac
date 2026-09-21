'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { parseQuickstartArguments, USAGE } = require('../../examples/quickstart-arguments.js')

const packageRoot = path.resolve(__dirname, '..', '..')
const examplesRoot = path.join(packageRoot, 'examples')
const relativeImportPattern = /require\(['"](\.[^'"]+)['"]\)/g
const helperFiles = new Set([
  'constants.js',
  'ffmpeg.js',
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
