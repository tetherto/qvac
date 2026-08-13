'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const packageRoot = path.resolve(__dirname, '..', '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
).version
const publishedExampleScripts = ['example:whisper']
const requiredFiles = [
  'package.json',
  'index.js',
  'index.d.ts',
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

    const consumerRoot = path.join(temporaryRoot, 'consumer')
    fs.mkdirSync(consumerRoot)
    installTarball(consumerRoot, path.join(temporaryRoot, packed.filename))

    const installedRoot = path.join(consumerRoot, 'node_modules', '@qvac', 'asr-ggml')
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
    )
    assert.equal(packageJson.version, expectedVersion)
    assertExportTargetsExist(packageJson, packedFiles)
    assertExampleTargetsExist(packageJson, packedFiles)
    requiredFiles.forEach((filePath) =>
      assert.ok(fs.existsSync(path.join(installedRoot, filePath)), filePath)
    )
    assertConsumerResolvesExports(consumerRoot, installedRoot)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
