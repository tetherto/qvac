'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const packageJson = require('../../package.json')
const textChunker = require('@qvac/tts-ggml/text-chunker')
const textStreamAccumulator = require('@qvac/tts-ggml/text-stream-accumulator')
const legacyTextStreamAccumulator = require('../../lib/textStreamAccumulator.js')

const packageRoot = path.resolve(__dirname, '../..')
const registryScript = 'scripts/download-tts-ggml-models.js'
const runtimeExtensions = new Set(['.cjs', '.js', '.mjs'])
const externalSpecifierPattern =
  /(?:require\s*\(\s*|import\s*\(\s*|(?:import|export)\s+(?:[^'"]*?\s+from\s+)?)(['"])([^'"]+)\1/g
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

function packedFileNames() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: packageRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return new Set(JSON.parse(result.stdout)[0].files.map(({ path: filePath }) => filePath))
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function declaredRuntimePackages() {
  return new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {})
  ])
}

function externalSpecifiers(source) {
  const specifiers = []
  for (const match of source.matchAll(externalSpecifierPattern)) {
    const specifier = match[2]
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !nodeBuiltins.has(specifier)) {
      specifiers.push(specifier)
    }
  }
  return specifiers
}

function undeclaredImports(filePath, declaredPackages) {
  if (!runtimeExtensions.has(path.extname(filePath))) return []
  const source = fs.readFileSync(path.join(packageRoot, filePath), 'utf8')
  return externalSpecifiers(source)
    .map(packageName)
    .filter((name) => name !== packageJson.name && !declaredPackages.has(name))
    .map((name) => `${filePath}: ${name}`)
}

function undeclaredPublishedImports(files) {
  const declaredPackages = declaredRuntimePackages()
  const undeclared = []
  for (const filePath of files) {
    undeclared.push(...undeclaredImports(filePath, declaredPackages))
  }
  return [...new Set(undeclared)].sort()
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
  // ^0.6.1 keeps the transitive hyperdb on the v6 line shared by the rest of
  // the @qvac ecosystem; 0.4.x pinned hyperdb@4 and broke the SDK consumer
  // install check's single-copy invariant.
  assert.equal(packageJson.dependencies['@qvac/registry-client'], '^0.6.1')
  const files = packedFileNames()
  assert.ok(files.has(registryScript))
  assert.ok(files.has('examples/chatterbox-enhanced.js'))
  assert.ok(files.has('examples/supertonic-enhanced.js'))
  assert.ok(files.has('examples/parler-enhanced.js'))
})

test('published runtime files declare their external imports', () => {
  assert.deepEqual(undeclaredPublishedImports(packedFileNames()), [])
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
