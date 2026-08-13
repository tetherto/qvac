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
  'example:whisper': 'bare examples/quickstart.js'
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

test('published example scripts target shipped examples', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(packageJson.scripts).filter(([name]) => name.startsWith('example:'))
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
