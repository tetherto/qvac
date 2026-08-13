'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const packageJson = require('../../package.json')
const textChunker = require('@qvac/tts-ggml/text-chunker')
const textStreamAccumulator = require('@qvac/tts-ggml/text-stream-accumulator')
const legacyTextStreamAccumulator = require('../../lib/textStreamAccumulator.js')

const packageRoot = path.resolve(__dirname, '../..')
const registryScript = 'scripts/download-tts-ggml-models.js'

function packedFileNames() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return new Set(JSON.parse(result.stdout)[0].files.map(({ path: filePath }) => filePath))
}

test('enhanced examples have package scripts', () => {
  assert.equal(
    packageJson.scripts['example:chatterbox-enhanced'],
    'bare examples/chatterbox-enhanced.js "Hello from enhanced Chatterbox."'
  )
  assert.equal(
    packageJson.scripts['example:supertonic-enhanced'],
    'bare examples/supertonic-enhanced.js "Hello from enhanced Supertonic."'
  )
  assert.equal(
    packageJson.scripts['example:parler-enhanced'],
    'bare examples/parler-enhanced.js "Hello from enhanced Parler."'
  )
})

test('published commands include their runtime files', () => {
  assert.equal(packageJson.dependencies['@qvac/registry-client'], '^0.4.0')
  const files = packedFileNames()
  assert.ok(files.has(registryScript))
  assert.ok(files.has('examples/chatterbox-enhanced.js'))
  assert.ok(files.has('examples/supertonic-enhanced.js'))
  assert.ok(files.has('examples/parler-enhanced.js'))
})

test('package root exposes runtime and type entry points', () => {
  assert.equal(packageJson.exports['.'].types, './index.d.ts')
  assert.equal(packageJson.exports['.'].default, './index.js')
})

test('public helper subpaths include stable and compatible names', () => {
  assert.equal(
    packageJson.exports['./text-stream-accumulator'].default,
    './lib/textStreamAccumulator.js'
  )
  assert.equal(
    packageJson.exports['./lib/textStreamAccumulator.js'].default,
    './lib/textStreamAccumulator.js'
  )
  assert.equal(packageJson.exports['./text-chunker'].default, './lib/textChunker.js')
  assert.equal(typeof textChunker.splitTtsText, 'function')
  assert.equal(typeof textStreamAccumulator.accumulateTextStream, 'function')
  assert.equal(
    textStreamAccumulator.accumulateTextStream,
    legacyTextStreamAccumulator.accumulateTextStream
  )
})
