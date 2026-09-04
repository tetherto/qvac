'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { expectedImports, expectedOptionalDependencies, npmPackageName, SLICES } = require('./platform-slices')
const { prepare } = require('./prepare-platform-packages')

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

test('prepare-platform-packages slices hosts, groups mobile flavours, and aliases cmake-bare names', () => {
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

    const android = path.join(output, 'android-arm64', 'prebuilds')
    for (const flavour of ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']) {
      assert.ok(fs.existsSync(path.join(android, flavour, 'qvac__fabric.bare')))
    }
    const ios = path.join(output, 'ios', 'prebuilds')
    assert.ok(fs.existsSync(path.join(ios, 'ios-arm64', 'qvac__fabric.bare')))
    assert.ok(fs.existsSync(path.join(ios, 'ios-arm64-simulator', 'qvac__fabric.bare')))

    const linuxAlias = path.join(output, 'linux-x64', 'prebuilds', 'linux-x64', 'qvac__fabric-linux-x64.bare')
    assert.equal(fs.readlinkSync(linuxAlias), 'qvac__fabric.bare')
    assert.equal(
      fs.readlinkSync(path.join(output, 'linux-x64', 'prebuilds', 'linux-x64', 'qvac__fabric-linux-x64.bare.exports')),
      'qvac__fabric.bare.exports'
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
