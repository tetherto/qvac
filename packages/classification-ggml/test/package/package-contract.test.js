'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, 'package.json')
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs'])
const IMPORT_PATTERNS = [
  /(?:require(?:\.resolve)?|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^\s*export\s+[^'"]+\s+from\s+['"]([^'"]+)['"]/gm
]
const RUNTIME_PROBES = [
  '@qvac/classification-ggml',
  'bare-os',
  'bare-process',
  'bare-url',
  'brittle'
]

function runNpm(arguments_, cwd) {
  const result = spawnSync(NPM_COMMAND, arguments_, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return result.stdout
}

function runPack(destination) {
  const arguments_ = ['pack', '--json', '--ignore-scripts']
  if (destination) arguments_.push('--pack-destination', destination)
  else arguments_.push('--dry-run')
  return JSON.parse(runNpm(arguments_, PACKAGE_ROOT))[0]
}

function collectPatternSpecifiers(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1])
}

function collectSpecifiers(source) {
  return IMPORT_PATTERNS.flatMap((pattern) => collectPatternSpecifiers(source, pattern))
}

function collectPublishedSpecifiers(packedFiles) {
  return packedFiles
    .filter((file) => JAVASCRIPT_EXTENSIONS.has(path.extname(file.path)))
    .flatMap((file) =>
      collectSpecifiers(fs.readFileSync(path.join(PACKAGE_ROOT, file.path), 'utf8'))
    )
}

function normalizePackageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function isExternalSpecifier(specifier, packageName) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:') &&
    specifier !== packageName &&
    !specifier.startsWith(`${packageName}/`)
  )
}

function collectExternalModules(packedFiles, packageJson) {
  const modules = collectPublishedSpecifiers(packedFiles)
    .filter((specifier) => isExternalSpecifier(specifier, packageJson.name))
    .map(normalizePackageName)
  return [...new Set(modules)].sort()
}

function isOptionalPeer(packageJson, moduleName) {
  return Boolean(
    packageJson.peerDependencies?.[moduleName] &&
    packageJson.peerDependenciesMeta?.[moduleName]?.optional
  )
}

function assertModuleDeclared(packageJson, moduleName) {
  assert.ok(
    packageJson.dependencies?.[moduleName] || isOptionalPeer(packageJson, moduleName),
    `${moduleName} is used by a published file but is not a runtime dependency or optional peer`
  )
}

function collectExportTargets(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(collectExportTargets)
}

function assertPublishedTargetsExist(packageJson, packedPaths) {
  const targets = [
    ...collectExportTargets(packageJson.exports),
    ...Object.values(packageJson.bin || {})
  ]
  targets.forEach((target) => assert.ok(packedPaths.has(target.replace(/^\.\//, '')), target))
}

function writeConsumerPackage(consumerRoot) {
  const packageJson = { name: 'classification-ggml-contract-probe', private: true }
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), `${JSON.stringify(packageJson)}\n`)
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
  RUNTIME_PROBES.forEach((specifier) => {
    const probe = `require.resolve(${JSON.stringify(specifier)})`
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: consumerRoot,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${specifier}: ${result.stdout}${result.stderr}`)
  })
}

test('published files declare every external runtime module', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'))
  const packedFiles = runPack().files
  const packedPaths = new Set(packedFiles.map((file) => file.path))
  const externalModules = collectExternalModules(packedFiles, packageJson)

  externalModules.forEach((moduleName) => assertModuleDeclared(packageJson, moduleName))
  assertPublishedTargetsExist(packageJson, packedPaths)
  assert.ok(collectPublishedSpecifiers(packedFiles).includes('@qvac/fabric/package'))
})

test('production tarball install includes promoted runtime modules', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-ggml-contract-'))

  try {
    const packed = runPack(temporaryRoot)
    const consumerRoot = path.join(temporaryRoot, 'consumer')
    fs.mkdirSync(consumerRoot)
    writeConsumerPackage(consumerRoot)
    installTarball(consumerRoot, path.join(temporaryRoot, packed.filename))
    assertRuntimeProbesResolve(consumerRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
