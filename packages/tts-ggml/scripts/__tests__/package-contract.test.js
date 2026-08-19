'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
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
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const runtimeProbes = [
  '@qvac/tts-ggml',
  '@qvac/tts-ggml/text-chunker',
  '@qvac/tts-ggml/text-stream-accumulator',
  '@qvac/langdetect-text',
  'bare-https',
  'bare-process',
  'bare-stream',
  'bare-subprocess',
  'bare-url',
  'brittle'
]

function runNpm(arguments_, cwd) {
  const result = spawnSync(npmCommand, arguments_, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return result.stdout
}

function runPack(destination) {
  const arguments_ = ['pack', '--json', '--ignore-scripts']
  if (destination) arguments_.push('--pack-destination', destination)
  else arguments_.push('--dry-run')
  return JSON.parse(runNpm(arguments_, packageRoot))[0]
}

function packedFileNames() {
  return new Set(runPack().files.map(({ path: filePath }) => filePath))
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

function declaredPackagesFor(filePath) {
  const runtime = declaredRuntimePackages()
  if (filePath.startsWith('test/')) {
    return new Set([...runtime, ...Object.keys(packageJson.devDependencies || {})])
  }
  return runtime
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
  const undeclared = []
  for (const filePath of files) {
    undeclared.push(...undeclaredImports(filePath, declaredPackagesFor(filePath)))
  }
  return [...new Set(undeclared)].sort()
}

function writeConsumerPackage(consumerRoot) {
  const consumerPackage = { name: 'tts-ggml-contract-probe', private: true }
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), `${JSON.stringify(consumerPackage)}\n`)
}

function installTarball(consumerRoot, tarballPath) {
  runNpm(
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarballPath
    ],
    consumerRoot
  )
}

function assertRuntimeProbesResolve(consumerRoot) {
  runtimeProbes.forEach((specifier) => {
    const probe = `require.resolve(${JSON.stringify(specifier)})`
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: consumerRoot,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${specifier}: ${result.stdout}${result.stderr}`)
  })
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

test('WER helper uses asr-ggml as a development dependency', () => {
  assert.equal(packageJson.dependencies['@qvac/transcription-whispercpp'], undefined)
  assert.equal(packageJson.dependencies['@qvac/asr-ggml'], undefined)
  assert.equal(packageJson.devDependencies['@qvac/asr-ggml'], '^0.3.2')
  const source = fs.readFileSync(path.join(packageRoot, 'test/utils/runWhisper.js'), 'utf8')
  assert.match(source, /@qvac\/asr-ggml/)
  assert.doesNotMatch(source, /transcription-whispercpp/)
  assert.match(source, /function loadAsrGgml/)
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

test('production tarball install includes promoted runtime modules', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-ggml-contract-'))

  try {
    const packed = runPack(temporaryRoot)
    const consumerRoot = path.join(temporaryRoot, 'consumer')
    fs.mkdirSync(consumerRoot)
    writeConsumerPackage(consumerRoot)
    installTarball(consumerRoot, path.join(temporaryRoot, packed.filename))
    assertRuntimeProbesResolve(consumerRoot)
    const asrProbe = spawnSync(process.execPath, ['-e', "require.resolve('@qvac/asr-ggml')"], {
      cwd: consumerRoot,
      encoding: 'utf8'
    })
    assert.notEqual(asrProbe.status, 0, 'production install must not include @qvac/asr-ggml')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
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
