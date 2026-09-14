'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const packageRoot = path.resolve(__dirname, '..', '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const sourcePackageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
)
const expectedVersion = sourcePackageJson.version
const publishedExampleScripts = ['example:whisper']
const runtimeExtensions = new Set(['.cjs', '.js', '.mjs'])
const externalSpecifierPattern =
  /(?:require\s*\(\s*|import\s*\(\s*|(?:import|export)\s+(?:[^'"]*?\s+from\s+)?)(['"])([^'"]+)\1/g
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
const requiredFiles = [
  'package.json',
  'index.js',
  'index.d.ts',
  'addon-unavailable.js',
  'lib/backends.js',
  'lib/backends.d.ts',
  'engines/types.d.ts',
  'engines/whisper/driver.d.ts',
  'engines/parakeet/driver.d.ts',
  'lib/error.js',
  'lib/error.d.ts',
  'lib/types.d.ts',
  'binding.js',
  'addonLogging.js',
  'addonLogging.d.ts',
  'test-support.js',
  'test-support.d.ts',
  'examples/quickstart.js',
  'examples/quickstart-arguments.js'
]

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function declaredRuntimePackages() {
  return new Set([
    ...Object.keys(sourcePackageJson.dependencies || {}),
    ...Object.keys(sourcePackageJson.optionalDependencies || {}),
    ...Object.keys(sourcePackageJson.peerDependencies || {})
  ])
}

function externalSpecifiers(source) {
  const specifiers = []
  for (const match of source.matchAll(externalSpecifierPattern)) {
    const specifier = match[2]
    if (
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('#') &&
      !nodeBuiltins.has(specifier)
    ) {
      specifiers.push(specifier)
    }
  }
  return specifiers
}

function importsMapFileTargets(target) {
  if (typeof target === 'string') {
    return target.startsWith('./') ? [target] : []
  }
  if (Array.isArray(target)) {
    return target.flatMap(importsMapFileTargets)
  }
  return Object.values(target).flatMap(importsMapFileTargets)
}

function assertImportsMapTargetsExist(packageJson, packedFiles) {
  const targets = importsMapFileTargets(packageJson.imports || {})
  assert.ok(targets.length > 0, 'imports map must keep a local fallback target')
  targets.forEach((target) => assert.ok(packedFiles.has(target.replace(/^\.\//, '')), target))
}

function undeclaredImports(filePath, declaredPackages) {
  if (!runtimeExtensions.has(path.extname(filePath))) return []
  const source = fs.readFileSync(path.join(packageRoot, filePath), 'utf8')
  return externalSpecifiers(source)
    .map(packageName)
    .filter((name) => name !== sourcePackageJson.name && !declaredPackages.has(name))
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

function assertExportTargetsExist(packageJson, packedFiles) {
  const targets = Object.values(packageJson.exports).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry)
  )
  targets.forEach((target) => assert.ok(packedFiles.has(target.replace(/^\.\//, '')), target))
}

function assertExampleTargetsExist(packageJson, packedFiles) {
  const commands = publishedExampleScripts.map((name) => packageJson.scripts[name])
  commands.forEach((command) => {
    const target = command.split(/\s+/)[1]
    assert.ok(packedFiles.has(target), target)
  })
}

function installTarball(consumerRoot, tarballPath) {
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'asr-package-consumer', private: true }, null, 2)}\n`
  )
  const result = spawnSync(
    npmCommand,
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarballPath
    ],
    { cwd: consumerRoot, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
}

function createEsmResolutionProbe(probePath, installedRoot) {
  const packageUrl = pathToFileURL(`${installedRoot}${path.sep}`).href
  const source = `
import assert from 'node:assert/strict'

assert.equal(import.meta.resolve('@qvac/asr-ggml'), new URL('index.js', '${packageUrl}').href)
assert.equal(
  import.meta.resolve('@qvac/asr-ggml/addonLogging'),
  new URL('addonLogging.js', '${packageUrl}').href
)
`
  fs.writeFileSync(probePath, source)
}

function createCjsResolutionProbe(probePath, installedRoot) {
  const source = `
const assert = require('node:assert/strict')

assert.equal(require.resolve('@qvac/asr-ggml'), ${JSON.stringify(path.join(installedRoot, 'index.js'))})
assert.equal(
  require.resolve('@qvac/asr-ggml/addonLogging'),
  ${JSON.stringify(path.join(installedRoot, 'addonLogging.js'))}
)
`
  fs.writeFileSync(probePath, source)
}

function assertConsumerResolvesExports(consumerRoot, installedRoot) {
  const probes = [
    [path.join(consumerRoot, 'resolution-probe.cjs'), createCjsResolutionProbe],
    [path.join(consumerRoot, 'resolution-probe.mjs'), createEsmResolutionProbe]
  ]
  probes.forEach(([probePath, createProbe]) => {
    createProbe(probePath, installedRoot)
    const result = spawnSync(process.execPath, [probePath], {
      cwd: consumerRoot,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  })
}

test('registry-client is a hyperdb-v6 aligned devDependency', () => {
  assert.equal(sourcePackageJson.devDependencies['@qvac/registry-client'], '^0.6.1')
  assert.equal(sourcePackageJson.dependencies['@qvac/registry-client'], undefined)
})

test('packed tarball preserves the public package contract', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-ggml-package-'))

  try {
    const packResult = spawnSync(
      npmCommand,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot],
      { cwd: packageRoot, encoding: 'utf8' }
    )
    assert.equal(packResult.status, 0, `${packResult.stdout}${packResult.stderr}`)
    const [packed] = JSON.parse(packResult.stdout)
    const packedFiles = new Set(packed.files.map((entry) => entry.path))
    requiredFiles.forEach((filePath) => assert.ok(packedFiles.has(filePath), filePath))
    assert.equal(
      [...packedFiles].some((filePath) => filePath.startsWith('src/')),
      false
    )
    assert.equal(
      [...packedFiles].some((filePath) => filePath.startsWith('test/unit/')),
      false
    )
    assert.deepEqual(undeclaredPublishedImports(packedFiles), [])

    const consumerRoot = path.join(temporaryRoot, 'consumer')
    fs.mkdirSync(consumerRoot)
    installTarball(consumerRoot, path.join(temporaryRoot, packed.filename))

    const installedRoot = path.join(consumerRoot, 'node_modules', '@qvac', 'asr-ggml')
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
    )
    assert.equal(packageJson.version, expectedVersion)
    assertExportTargetsExist(packageJson, packedFiles)
    assertImportsMapTargetsExist(packageJson, packedFiles)
    assertExampleTargetsExist(packageJson, packedFiles)
    requiredFiles.forEach((filePath) =>
      assert.ok(fs.existsSync(path.join(installedRoot, filePath)), filePath)
    )
    assertConsumerResolvesExports(consumerRoot, installedRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
