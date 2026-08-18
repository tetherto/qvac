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
const IMPORT_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
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
const RUNTIME_IMPORT_FILES = [
  'index.js',
  'addonLogging.js',
  'marian.js',
  'lib/error.js',
  'lib/bergamot-model-fetcher.js',
  'lib/indictrans-model-fetcher.js',
  'test/mobile/integration-runtime.cjs'
]

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
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1])
}

function isExternalModule(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !BUILTIN_MODULES.has(specifier) &&
    packageNameFromSpecifier(specifier) !== PACKAGE_NAME
  )
}

function assertDeclaredImports(packageRoot, packageJson) {
  const declaredModules = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {})
  ])
  RUNTIME_IMPORT_FILES.forEach((filePath) => {
    const source = fs.readFileSync(path.join(packageRoot, filePath), 'utf8')
    importedModules(source)
      .filter(isExternalModule)
      .forEach((specifier) => {
        const moduleName = packageNameFromSpecifier(specifier)
        assert.ok(declaredModules.has(moduleName), `${filePath} declares ${moduleName}`)
      })
  })
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

function assertOptionalDependencyErrors(consumerRoot) {
  const probe = `
const assert = require('node:assert/strict')
const Module = require('node:module')
const originalLoad = Module._load
const blocked = new Set(['bare-fetch', '@qvac/registry-client'])
let failureMode = 'missing'

Module._load = function (request, parent, isMain) {
  if (request === 'bare-fs') return {}
  if (request === 'bare-path') return originalLoad.call(this, 'node:path', parent, isMain)
  if (blocked.has(request)) {
    const error = new Error(
      failureMode === 'missing' ? \`Cannot find module '\${request}'\` : \`\${request} initialization failed\`
    )
    if (failureMode === 'missing') error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return originalLoad.call(this, request, parent, isMain)
}

async function verify() {
  const bergamot = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')
  const indictrans = require('@qvac/translation-nmtcpp/lib/indictrans-model-fetcher')
  await assert.rejects(
    bergamot.downloadBergamotFromFirefox('en', 'it', 'unused'),
    /Install bare-fetch to download Bergamot translation models/
  )
  await assert.rejects(
    indictrans.downloadIndicTransFromRegistry('en-indic-200M-q4_0', 'unused'),
    /Install @qvac\\/registry-client to download IndicTrans translation models/
  )
  failureMode = 'initialization'
  await assert.rejects(
    bergamot.downloadBergamotFromFirefox('en', 'it', 'unused'),
    /bare-fetch initialization failed/
  )
  await assert.rejects(
    indictrans.downloadIndicTransFromRegistry('en-indic-200M-q4_0', 'unused'),
    /@qvac\\/registry-client initialization failed/
  )
}

verify().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: consumerRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
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
    const packedFiles = new Set(packed.files.map((entry) => entry.path))
    REQUIRED_FILES.forEach((filePath) => assert.ok(packedFiles.has(filePath), filePath))

    const consumerRoot = path.join(temporaryRoot, 'consumer')
    const tarballPath = path.join(temporaryRoot, packed.filename)
    installTarball(consumerRoot, tarballPath)

    const installedRoot = path.join(consumerRoot, 'node_modules', '@qvac', 'translation-nmtcpp')
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
    )
    assert.equal(packageJson.dependencies['bare-fs'], '^4.5.1')
    assert.equal(packageJson.dependencies['bare-url'], '^2.1.6')
    assert.equal(packageJson.peerDependencies['bare-fetch'], '^3.0.1')
    assert.equal(packageJson.peerDependencies['@qvac/registry-client'], '^0.4.0')
    assert.equal(packageJson.peerDependenciesMeta['bare-fetch'].optional, true)
    assert.equal(packageJson.peerDependenciesMeta['@qvac/registry-client'].optional, true)
    assertDeclaredImports(installedRoot, packageJson)
    assertRuntimeProbe(consumerRoot, installedRoot)
    assertOptionalDependencyErrors(consumerRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
