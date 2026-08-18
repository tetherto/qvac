'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { builtinModules } = require('node:module')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_NAME = '@qvac/translation-nmtcpp'
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const BARE_COMMAND = process.platform === 'win32' ? 'bare.cmd' : 'bare'
const JAVASCRIPT_FILE_PATTERN = /\.(?:cjs|js|mjs)$/
const IMPORT_PATTERNS = [
  /\b(?:require|loadModule)\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
]
const BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const REQUIRED_FILES = [
  'index.js',
  'index.d.ts',
  'lib/bergamot-model-fetcher.js',
  'lib/bergamot-model-fetcher.d.ts',
  'lib/indictrans-model-fetcher.js',
  'lib/indictrans-model-fetcher.d.ts',
  'test/mobile/integration-runtime.cjs'
]
const OPTIONAL_MODULES = ['bare-fetch', '@qvac/registry-client']
const TRANSITIVE_MISSING_MODULE = 'translation-nmtcpp-transitive-missing'
const NODE_BARE_MODULE_SHIM = `
const Module = require('node:module')
const nodePath = require('node:path')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'bare-fs') return {}
  if (request === 'bare-path') return nodePath
  return originalLoad.call(this, request, parent, isMain)
}
`

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return result.stdout
}

function installTarball(consumerRoot, tarballPath) {
  fs.mkdirSync(consumerRoot)
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'translation-package-consumer', private: true }, null, 2)}\n`
  )
  run(
    NPM_COMMAND,
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarballPath
    ],
    consumerRoot
  )
}

function packageNameFromSpecifier(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function importedModules(source) {
  return IMPORT_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1])
  )
}

function isExternalModule(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    !BUILTIN_MODULES.has(specifier) &&
    packageNameFromSpecifier(specifier) !== PACKAGE_NAME
  )
}

function optionalPeerModules(packageJson) {
  return new Set(
    Object.keys(packageJson.peerDependencies || {}).filter(
      (moduleName) => packageJson.peerDependenciesMeta?.[moduleName]?.optional === true
    )
  )
}

function assertFileImportsDeclared(packageRoot, filePath, declaredModules) {
  const source = fs.readFileSync(path.join(packageRoot, filePath), 'utf8')
  importedModules(source)
    .filter(isExternalModule)
    .forEach((specifier) => {
      const moduleName = packageNameFromSpecifier(specifier)
      assert.ok(declaredModules.has(moduleName), `${filePath} declares ${moduleName}`)
    })
}

function assertDeclaredImports(packageRoot, packageJson, packedFiles) {
  const declaredModules = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...optionalPeerModules(packageJson)
  ])
  packedFiles
    .filter((filePath) => JAVASCRIPT_FILE_PATTERN.test(filePath))
    .forEach((filePath) => assertFileImportsDeclared(packageRoot, filePath, declaredModules))
}

function assertRuntimeProbe(consumerRoot, installedRoot) {
  const probe = `
const bergamot = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')
const indictrans = require('@qvac/translation-nmtcpp/lib/indictrans-model-fetcher')

if (bergamot.getBergamotFileNames('en', 'it').modelName !== 'model.enit.intgemm.alphas.bin') {
  throw new Error('Bergamot model fetcher probe failed')
}
if (indictrans.getIndicTransFileName() !== 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin') {
  throw new Error('IndicTrans model fetcher probe failed')
}
require(${JSON.stringify(path.join(installedRoot, 'test/mobile/integration-runtime.cjs'))})
require.resolve('@qvac/translation-nmtcpp')
require.resolve('@qvac/translation-nmtcpp/addonLogging')
require.resolve('@qvac/translation-nmtcpp/marian')
`
  const result = spawnSync(BARE_COMMAND, ['-e', probe], {
    cwd: consumerRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
}

function optionalModuleRoot(consumerRoot, moduleName) {
  return path.join(consumerRoot, 'node_modules', ...moduleName.split('/'))
}

function removeOptionalModules(consumerRoot) {
  OPTIONAL_MODULES.forEach((moduleName) => {
    fs.rmSync(optionalModuleRoot(consumerRoot, moduleName), { recursive: true, force: true })
  })
}

function writeOptionalModule(consumerRoot, moduleName, source) {
  const moduleRoot = optionalModuleRoot(consumerRoot, moduleName)
  fs.mkdirSync(moduleRoot, { recursive: true })
  fs.writeFileSync(
    path.join(moduleRoot, 'package.json'),
    `${JSON.stringify({ name: moduleName, main: 'index.js' })}\n`
  )
  fs.writeFileSync(path.join(moduleRoot, 'index.js'), source)
}

function writeOptionalModules(consumerRoot, sourceForModule) {
  OPTIONAL_MODULES.forEach((moduleName) => {
    writeOptionalModule(consumerRoot, moduleName, sourceForModule(moduleName))
  })
}

function optionalDependencyProbe(expectedBergamotMessage, expectedIndicTransMessage) {
  return `
const bergamot = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')
const indictrans = require('@qvac/translation-nmtcpp/lib/indictrans-model-fetcher')

async function rejectionMessage(action) {
  try {
    await action()
  } catch (error) {
    return error.message
  }
  throw new Error('Expected model download to fail')
}

async function verify() {
  const bergamotMessage = await rejectionMessage(() =>
    bergamot.downloadBergamotFromFirefox('en', 'it', 'unused')
  )
  const indictransMessage = await rejectionMessage(() =>
    indictrans.downloadIndicTransFromRegistry('en-indic-200M-q4_0', 'unused')
  )
  if (!bergamotMessage.includes(${JSON.stringify(expectedBergamotMessage)})) {
    throw new Error(bergamotMessage)
  }
  if (!indictransMessage.includes(${JSON.stringify(expectedIndicTransMessage)})) {
    throw new Error(indictransMessage)
  }
}

verify().catch((error) => {
  console.error(error)
  if (globalThis.Bare) {
    Bare.exit(1)
  } else {
    globalThis.process.exitCode = 1
  }
})
`
}

function assertProbe(command, consumerRoot, probe) {
  const result = spawnSync(command, ['-e', probe], {
    cwd: consumerRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `${command}\n${result.stdout}${result.stderr}`)
}

function assertProbeAcrossRuntimes(consumerRoot, probe) {
  assertProbe(process.execPath, consumerRoot, `${NODE_BARE_MODULE_SHIM}\n${probe}`)
  assertProbe(BARE_COMMAND, consumerRoot, probe)
}

function assertDirectMissingOptionalDependencies(consumerRoot) {
  removeOptionalModules(consumerRoot)
  assertProbeAcrossRuntimes(
    consumerRoot,
    optionalDependencyProbe(
      'Install bare-fetch to download Bergamot translation models',
      'Install @qvac/registry-client to download IndicTrans translation models'
    )
  )
}

function assertOptionalDependencyInitializationErrors(consumerRoot) {
  writeOptionalModules(
    consumerRoot,
    (moduleName) => `throw new Error(${JSON.stringify(`${moduleName} initialization failed`)})\n`
  )
  assertProbeAcrossRuntimes(
    consumerRoot,
    optionalDependencyProbe(
      'bare-fetch initialization failed',
      '@qvac/registry-client initialization failed'
    )
  )
}

function assertTransitiveMissingDependencies(consumerRoot) {
  writeOptionalModules(
    consumerRoot,
    () => `require(${JSON.stringify(TRANSITIVE_MISSING_MODULE)})\n`
  )
  assertProbeAcrossRuntimes(
    consumerRoot,
    optionalDependencyProbe(TRANSITIVE_MISSING_MODULE, TRANSITIVE_MISSING_MODULE)
  )
}

function assertOptionalDependencyErrors(consumerRoot) {
  assertDirectMissingOptionalDependencies(consumerRoot)
  assertOptionalDependencyInitializationErrors(consumerRoot)
  assertTransitiveMissingDependencies(consumerRoot)
}

test('packed tarball preserves the public package contract', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-package-'))

  try {
    const packOutput = run(
      NPM_COMMAND,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot],
      PACKAGE_ROOT
    )
    const [packed] = JSON.parse(packOutput)
    const packedFiles = packed.files.map((entry) => entry.path)
    const packedFileSet = new Set(packedFiles)
    REQUIRED_FILES.forEach((filePath) => assert.ok(packedFileSet.has(filePath), filePath))

    const consumerRoot = path.join(temporaryRoot, 'consumer')
    const tarballPath = path.join(temporaryRoot, packed.filename)
    installTarball(consumerRoot, tarballPath)

    const installedRoot = path.join(consumerRoot, 'node_modules', '@qvac', 'translation-nmtcpp')
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
    )
    assert.equal(packageJson.dependencies['bare-fs'], '^4.5.1')
    assert.equal(packageJson.dependencies['bare-os'], '^3.9.3')
    assert.equal(packageJson.dependencies['bare-process'], '^4.2.2')
    assert.equal(packageJson.dependencies['bare-url'], '^2.1.6')
    assert.equal(packageJson.dependencies.brittle, '^3.4.0')
    assert.equal(packageJson.devDependencies['bare-os'], undefined)
    assert.equal(packageJson.devDependencies['bare-process'], undefined)
    assert.equal(packageJson.devDependencies.brittle, undefined)
    assert.equal(packageJson.peerDependencies['bare-fetch'], '^3.0.1')
    assert.equal(packageJson.peerDependencies['@qvac/registry-client'], '^0.4.0')
    assert.equal(packageJson.peerDependenciesMeta['bare-fetch'].optional, true)
    assert.equal(packageJson.peerDependenciesMeta['@qvac/registry-client'].optional, true)
    assertDeclaredImports(installedRoot, packageJson, packedFiles)
    assertRuntimeProbe(consumerRoot, installedRoot)
    assertOptionalDependencyErrors(consumerRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
