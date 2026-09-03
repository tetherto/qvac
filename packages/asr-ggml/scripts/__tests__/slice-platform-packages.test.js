'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const slicerPromise = import('../../../../scripts/ci/slice-platform-packages.mjs')

const META_MANIFEST = {
  name: '@qvac/fake-ggml',
  version: '1.2.3',
  license: 'Apache-2.0',
  author: 'Tether',
  repository: {
    type: 'git',
    url: 'git+https://github.com/tetherto/qvac.git',
    directory: 'packages/fake-ggml'
  },
  bugs: 'https://github.com/tetherto/qvac/issues',
  homepage: 'https://qvac.tether.io',
  engines: { bare: '>=1.20.0' }
}

const ALL_HOSTS = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
]

const EXPECTED_SLICE_SUFFIXES = [
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'android-arm64',
  'ios'
]

function makeFixture(hosts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-test-'))
  const workdir = path.join(root, 'fake-ggml')
  const prebuildsDir = path.join(workdir, 'prebuilds')
  fs.mkdirSync(prebuildsDir, { recursive: true })
  fs.writeFileSync(
    path.join(workdir, 'package.json'),
    JSON.stringify(META_MANIFEST, null, 2) + '\n'
  )
  fs.writeFileSync(path.join(workdir, 'LICENSE'), 'license text\n')
  fs.writeFileSync(path.join(workdir, 'NOTICE'), 'notice text\n')
  for (const host of hosts) {
    populateHostDir(prebuildsDir, host)
  }
  return { root, workdir, outDir: path.join(root, 'out') }
}

function populateHostDir(prebuildsDir, host) {
  const hostDir = path.join(prebuildsDir, host)
  const backendsDir = path.join(hostDir, 'qvac__fake-ggml')
  fs.mkdirSync(backendsDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, 'qvac__fake-ggml.bare'), 'binary-' + host)
  fs.writeFileSync(path.join(backendsDir, 'libqvac-speech-ggml-cpu.so'), 'backend-' + host)
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), 'utf8'))
}

test('slices every host dir into per-platform packages', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const sliceDirs = slicePlatformPackages({ workdir, outDir })

  assert.deepEqual(
    sliceDirs.map((dir) => path.basename(dir)),
    EXPECTED_SLICE_SUFFIXES.map((suffix) => 'qvac-fake-ggml-' + suffix)
  )
  assert.equal(fs.existsSync(path.join(workdir, 'prebuilds')), false)
})

test('generates a loadable platform package layout', async (t) => {
  const { slicePlatformPackages, PLATFORM_INDEX_SOURCE } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  slicePlatformPackages({ workdir, outDir })
  const sliceDir = path.join(outDir, 'qvac-fake-ggml-linux-x64')

  const manifest = readJson(sliceDir, 'package.json')
  assert.equal(manifest.name, '@qvac/fake-ggml-linux-x64')
  assert.equal(manifest.version, '1.2.3')
  assert.deepEqual(manifest.os, ['linux'])
  assert.deepEqual(manifest.cpu, ['x64'])
  assert.deepEqual(manifest.libc, ['glibc'])
  assert.equal(manifest.license, 'Apache-2.0')
  assert.deepEqual(manifest.repository, META_MANIFEST.repository)
  assert.deepEqual(manifest.files, ['index.js', 'addon', 'NOTICE'])

  const innerManifest = readJson(sliceDir, 'addon', 'package.json')
  assert.equal(innerManifest.name, '@qvac/fake-ggml')
  assert.equal(innerManifest.version, '1.2.3')
  assert.equal(innerManifest.addon, true)

  assert.equal(fs.readFileSync(path.join(sliceDir, 'index.js'), 'utf8'), PLATFORM_INDEX_SOURCE)
  assert.equal(
    fs.readFileSync(
      path.join(sliceDir, 'addon', 'prebuilds', 'linux-x64', 'qvac__fake-ggml.bare'),
      'utf8'
    ),
    'binary-linux-x64'
  )
  assert.ok(
    fs.existsSync(
      path.join(
        sliceDir,
        'addon',
        'prebuilds',
        'linux-x64',
        'qvac__fake-ggml',
        'libqvac-speech-ggml-cpu.so'
      )
    )
  )
  assert.ok(fs.existsSync(path.join(sliceDir, 'LICENSE')))
  assert.ok(fs.existsSync(path.join(sliceDir, 'NOTICE')))
})

test('groups every ios flavour into one ios package', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  slicePlatformPackages({ workdir, outDir })
  const prebuilds = path.join(outDir, 'qvac-fake-ggml-ios', 'addon', 'prebuilds')

  assert.deepEqual(fs.readdirSync(prebuilds).sort(), [
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator'
  ])
  const manifest = readJson(outDir, 'qvac-fake-ggml-ios', 'package.json')
  assert.deepEqual(manifest.os, ['ios'])
  assert.equal(manifest.cpu, undefined)
})

test('injects lockstep optionalDependencies into the meta manifest', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  slicePlatformPackages({ workdir, outDir })

  const manifest = readJson(workdir, 'package.json')
  assert.deepEqual(manifest.optionalDependencies, {
    '@qvac/fake-ggml-linux-x64': '1.2.3',
    '@qvac/fake-ggml-linux-arm64': '1.2.3',
    '@qvac/fake-ggml-darwin-arm64': '1.2.3',
    '@qvac/fake-ggml-darwin-x64': '1.2.3',
    '@qvac/fake-ggml-win32-x64': '1.2.3',
    '@qvac/fake-ggml-android-arm64': '1.2.3',
    '@qvac/fake-ggml-ios': '1.2.3'
  })
})

test('fails on a host dir with no slice mapping', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture([...ALL_HOSTS, 'linux-riscv64'])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /linux-riscv64/)
})

test('fails when the merged artifact is missing a host', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS.filter((host) => host !== 'win32-x64'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /win32-x64/)
})

test('fails when a slice exceeds the size budget', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () => slicePlatformPackages({ workdir, outDir, maxSliceMb: 0 }),
    /size budget|exceeds/
  )
})
