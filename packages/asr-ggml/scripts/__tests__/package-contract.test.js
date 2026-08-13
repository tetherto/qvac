'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { gunzipSync } = require('node:zlib')

const packageRoot = path.resolve(__dirname, '..', '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
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
  'test-support.d.ts'
]

function readTarString(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/s, '')
}

function readTarSize(buffer, offset) {
  const value = readTarString(buffer, offset + 124, 12).trim()
  return value ? Number.parseInt(value, 8) : 0
}

function writeTarEntry(root, name, type, content) {
  if (!name.startsWith('package/')) return
  const relativePath = name.slice('package/'.length)
  const targetPath = path.resolve(root, relativePath)
  assert.ok(targetPath.startsWith(`${path.resolve(root)}${path.sep}`))
  if (type === '5') {
    fs.mkdirSync(targetPath, { recursive: true })
    return
  }
  if (type !== '' && type !== '0') return
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, content)
}

function extractTarball(tarballPath, destination) {
  const archive = gunzipSync(fs.readFileSync(tarballPath))
  let offset = 0
  while (offset + 512 <= archive.length) {
    const name = readTarString(archive, offset, 100)
    if (!name) return
    const size = readTarSize(archive, offset)
    const type = readTarString(archive, offset + 156, 1)
    const contentStart = offset + 512
    writeTarEntry(destination, name, type, archive.subarray(contentStart, contentStart + size))
    offset = contentStart + Math.ceil(size / 512) * 512
  }
}

function createRuntimeProbe(probePath, packedRoot) {
  const source = `
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const replacements = new Map([
  ['bare-events', require('node:events')],
  ['bare-fs', require('node:fs')],
  ['bare-os', require('node:os')],
  ['bare-path', path],
  ['bare-process', process]
])
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (replacements.has(request)) return replacements.get(request)
  return originalLoad(request, parent, isMain)
}
const originalLoader = Module._extensions['.js']
Module._extensions['.js'] = function (module, filename) {
  if (filename === path.join(${JSON.stringify(packedRoot)}, 'binding.js')) {
    module.exports = {}
    return
  }
  originalLoader(module, filename)
}
const cjs = require(${JSON.stringify(packedRoot)})
assert.equal(typeof cjs, 'function')
assert.equal(cjs.getModelKey(), 'asr-ggml')
import(pathToFileURL(path.join(${JSON.stringify(packedRoot)}, 'index.js')).href).then((esm) => {
  assert.equal(esm.default, cjs)
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
  fs.writeFileSync(probePath, source)
}

function assertExportTargetsExist(packageJson, packedFiles) {
  const targets = Object.values(packageJson.exports).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry)
  )
  targets.forEach((target) => assert.ok(packedFiles.has(target.replace(/^\.\//, '')), target))
}

function assertExampleTargetsExist(packageJson, packedFiles) {
  const commands = Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith('example:'))
    .map(([, command]) => command)
  commands.forEach((command) => {
    const target = command.split(/\s+/)[1]
    assert.ok(packedFiles.has(target), target)
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

    const packedRoot = path.join(temporaryRoot, 'package')
    extractTarball(path.join(temporaryRoot, packed.filename), packedRoot)
    const packageJson = JSON.parse(fs.readFileSync(path.join(packedRoot, 'package.json'), 'utf8'))
    assert.equal(packageJson.version, '0.3.0')
    assertExportTargetsExist(packageJson, packedFiles)
    assertExampleTargetsExist(packageJson, packedFiles)

    const probePath = path.join(temporaryRoot, 'runtime-probe.cjs')
    createRuntimeProbe(probePath, packedRoot)
    const runtimeResult = spawnSync(process.execPath, [probePath], {
      cwd: temporaryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: path.join(packageRoot, 'node_modules')
      }
    })
    assert.equal(runtimeResult.status, 0, `${runtimeResult.stdout}${runtimeResult.stderr}`)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
