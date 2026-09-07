'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ADDON_UNAVAILABLE,
  expectedImports,
  expectedOptionalDependencies,
  npmPackageName,
  SLICES
} = require('./platform-slices')
const { ADDON_DIR, prepare } = require('./prepare-platform-packages')

function makePrebuilds (root) {
  const prebuilds = path.join(root, 'prebuilds')
  fs.mkdirSync(prebuilds, { recursive: true })
  for (const name of [
    'linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64',
    'win32-x64', 'android-arm64', 'ios-arm64', 'ios-arm64-simulator'
  ]) {
    const dir = path.join(prebuilds, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'qvac__fabric.bare'), 'bare')
    fs.writeFileSync(path.join(dir, 'qvac__fabric.bare.exports'), 'exports')
  }
  return prebuilds
}

function metaPath (root, extras) {
  const file = path.join(root, 'package.json')
  const meta = {
    name: '@qvac/fabric',
    version: '0.11.0',
    engines: { bare: '>=1.24.0' },
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/tetherto/qvac.git' },
    optionalDependencies: expectedOptionalDependencies('0.11.0'),
    imports: expectedImports(),
    ...extras
  }
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n')
  return file
}

test('prepare-platform-packages slices hosts and groups mobile flavours', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-slices-'))
  try {
    const source = makePrebuilds(tmp)
    const output = path.join(tmp, 'platforms')
    prepare(source, output, metaPath(tmp))

    for (const slice of SLICES) {
      const dir = path.join(output, slice.name)
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      assert.equal(manifest.name, npmPackageName(slice.name))
      assert.equal(manifest.version, '0.11.0')
      assert.deepEqual(manifest.os, [slice.os])
      if (slice.cpu) assert.deepEqual(manifest.cpu, [slice.cpu])
      else assert.equal(manifest.cpu, undefined)
      if (slice.libc) assert.deepEqual(manifest.libc, [slice.libc])
    }

    const android = path.join(output, 'android-arm64', ADDON_DIR, 'prebuilds')
    for (const flavour of ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']) {
      assert.ok(fs.existsSync(path.join(android, flavour, 'qvac__fabric.bare')))
    }
    const ios = path.join(output, 'ios', ADDON_DIR, 'prebuilds')
    assert.ok(fs.existsSync(path.join(ios, 'ios-arm64', 'qvac__fabric.bare')))
    assert.ok(fs.existsSync(path.join(ios, 'ios-arm64-simulator', 'qvac__fabric.bare')))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// The inner manifest is what keeps the artifact named qvac__fabric.bare, so both
// require.addon('./addon') and cmake-bare's include_bare_module find it without a
// renamed second copy of the runtime.
test('platform slices nest the runtime under addon/ named after the meta package', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-slices-'))
  try {
    const source = makePrebuilds(tmp)
    const output = path.join(tmp, 'platforms')
    prepare(source, output, metaPath(tmp))

    const slice = path.join(output, 'linux-x64')
    assert.equal(
      fs.readFileSync(path.join(slice, 'index.js'), 'utf8'),
      "module.exports = require.addon('./addon')\n"
    )

    const inner = JSON.parse(fs.readFileSync(path.join(slice, ADDON_DIR, 'package.json'), 'utf8'))
    assert.equal(inner.name, '@qvac/fabric')
    assert.equal(inner.addon, true)
    assert.equal(inner.version, '0.11.0')

    const hostDir = path.join(slice, ADDON_DIR, 'prebuilds', 'linux-x64')
    assert.ok(fs.existsSync(path.join(hostDir, 'qvac__fabric.bare')))
    assert.deepEqual(
      fs.readdirSync(hostDir).filter((entry) => entry.endsWith('.bare')),
      ['qvac__fabric.bare']
    )

    const manifest = JSON.parse(fs.readFileSync(path.join(slice, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.files, ['index.js', ADDON_DIR, 'LICENSE', 'NOTICE'])
    assert.deepEqual(manifest.exports, { '.': './index.js', './package': './package.json' })
    assert.equal(manifest.addon, undefined)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('prepare-platform-packages refuses a host dir with no .bare addon', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-slices-'))
  try {
    const source = makePrebuilds(tmp)
    fs.rmSync(path.join(source, 'darwin-x64', 'qvac__fabric.bare'))
    assert.throws(
      () => prepare(source, path.join(tmp, 'platforms'), metaPath(tmp)),
      /binary-less platform package/
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('prepare-platform-packages rejects drifted optionalDependencies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-slices-'))
  try {
    const source = makePrebuilds(tmp)
    assert.throws(
      () => prepare(source, path.join(tmp, 'platforms'), metaPath(tmp, {
        optionalDependencies: { '@qvac/fabric-linux-x64': '0.10.0' }
      })),
      /optionalDependencies/
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('meta package.json imports map matches the slice table', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.deepEqual(meta.imports, expectedImports())
})

// Every host arm must stay resolvable without its platform package installed:
// that is what lets bare-pack traverse require('#binding') on any host, and it
// routes an uninstalled slice to the actionable error instead of a resolver throw.
test('every imports-map arm falls back to a shipped addon-unavailable module', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const fallbacks = []
  collectTargets(meta.imports['#binding'], fallbacks)
  assert.ok(fallbacks.length > 0)
  for (const target of fallbacks) assert.equal(target, ADDON_UNAVAILABLE)

  assert.ok(meta.files.includes(ADDON_UNAVAILABLE.replace('./', '')))
  assert.ok(fs.existsSync(path.join(__dirname, '..', ADDON_UNAVAILABLE)))
})

function collectTargets (node, out) {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    assert.equal(node.length, 2)
    out.push(node[1])
    return
  }
  assert.ok(node.default !== undefined, 'condition object needs a default arm')
  for (const key of Object.keys(node)) collectTargets(node[key], out)
}
