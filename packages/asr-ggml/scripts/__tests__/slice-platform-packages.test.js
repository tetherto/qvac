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

function moduleName(host) {
  return 'qvac__fake-ggml-' + (host.startsWith('ios-') ? 'ios' : host)
}

function populateHostDir(prebuildsDir, host) {
  const hostDir = path.join(prebuildsDir, host)
  const backendsDir = path.join(hostDir, moduleName(host))
  fs.mkdirSync(backendsDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, moduleName(host) + '.bare'), 'binary-' + host)
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
  assert.deepEqual(manifest.files, ['index.js', 'prebuilds', 'NOTICE'])
  assert.equal(manifest.addon, true)
  assert.equal(fs.existsSync(path.join(sliceDir, 'addon')), false)

  assert.equal(PLATFORM_INDEX_SOURCE, 'module.exports = require.addon()\n')
  assert.equal(fs.readFileSync(path.join(sliceDir, 'index.js'), 'utf8'), PLATFORM_INDEX_SOURCE)
  assert.equal(
    fs.readFileSync(
      path.join(sliceDir, 'prebuilds', 'linux-x64', 'qvac__fake-ggml-linux-x64.bare'),
      'utf8'
    ),
    'binary-linux-x64'
  )
  assert.ok(
    fs.existsSync(
      path.join(
        sliceDir,
        'prebuilds',
        'linux-x64',
        'qvac__fake-ggml-linux-x64',
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
  const prebuilds = path.join(outDir, 'qvac-fake-ggml-ios', 'prebuilds')

  assert.deepEqual(fs.readdirSync(prebuilds).sort(), [
    'ios-arm64',
    'ios-arm64-simulator',
    'ios-x64-simulator'
  ])
  for (const host of fs.readdirSync(prebuilds)) {
    assert.ok(fs.existsSync(path.join(prebuilds, host, 'qvac__fake-ggml-ios.bare')), host)
  }
  const manifest = readJson(outDir, 'qvac-fake-ggml-ios', 'package.json')
  assert.equal(manifest.os, undefined)
  assert.equal(manifest.cpu, undefined)
})

test('leaves cross-built mobile slices installable on any host', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  slicePlatformPackages({ workdir, outDir })

  for (const suffix of ['android-arm64', 'ios']) {
    const manifest = readJson(outDir, 'qvac-fake-ggml-' + suffix, 'package.json')
    assert.equal(manifest.os, undefined, suffix + ' must not be os-filtered')
    assert.equal(manifest.cpu, undefined, suffix + ' must not be cpu-filtered')
    assert.equal(manifest.libc, undefined, suffix + ' must not be libc-filtered')
  }
})

test('documents direct dependency usage for cross-built mobile slices', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  slicePlatformPackages({ workdir, outDir })

  const mobileReadme = fs.readFileSync(
    path.join(outDir, 'qvac-fake-ggml-android-arm64', 'README.md'),
    'utf8'
  )
  assert.match(mobileReadme, /must depend on this package directly/)
  const desktopReadme = fs.readFileSync(
    path.join(outDir, 'qvac-fake-ggml-linux-x64', 'README.md'),
    'utf8'
  )
  assert.match(desktopReadme, /Do not depend on this package directly/)
})

test('injects lockstep optionalDependencies for host-filtered slices only', async (t) => {
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
    '@qvac/fake-ggml-win32-x64': '1.2.3'
  })
  assert.deepEqual(manifest.peerDependencies, {
    '@qvac/fake-ggml-android-arm64': '1.2.3',
    '@qvac/fake-ggml-ios': '1.2.3'
  })
  assert.deepEqual(manifest.peerDependenciesMeta, {
    '@qvac/fake-ggml-android-arm64': { optional: true },
    '@qvac/fake-ggml-ios': { optional: true }
  })
})

test('fails on a host dir with no slice mapping', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture([...ALL_HOSTS, 'linux-riscv64'])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /linux-riscv64/)
})

test('fails when a host dir carries no .bare addon', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.rmSync(path.join(workdir, 'prebuilds', 'win32-x64', 'qvac__fake-ggml-win32-x64.bare'))

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /binary-less|No \.bare/)
})

test('fails when a host dir carries the module under the meta name', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const hostDir = path.join(workdir, 'prebuilds', 'android-arm64')
  fs.renameSync(
    path.join(hostDir, 'qvac__fake-ggml-android-arm64.bare'),
    path.join(hostDir, 'qvac__fake-ggml.bare')
  )

  assert.throws(
    () => slicePlatformPackages({ workdir, outDir }),
    /not qvac__fake-ggml-android-arm64\.bare.*NAME qvac__fake-ggml-android-arm64/
  )
})

test('fails when the merged artifact is missing a host', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS.filter((host) => host !== 'win32-x64'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /win32-x64/)
})

function addMetaDirs(workdir) {
  const prebuildsDir = path.join(workdir, 'prebuilds')
  fs.mkdirSync(path.join(prebuildsDir, 'include'), { recursive: true })
  fs.writeFileSync(path.join(prebuildsDir, 'include', 'ggml.h'), '// header\n')
  fs.mkdirSync(path.join(prebuildsDir, 'share', 'fake-ggml'), { recursive: true })
  fs.writeFileSync(
    path.join(prebuildsDir, 'share', 'fake-ggml', 'fake-ggml-config.cmake'),
    '# config\n'
  )
}

test('keeps the declared meta dirs in the meta package', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  addMetaDirs(workdir)

  const sliceDirs = slicePlatformPackages({ workdir, outDir, keepDirs: ['include', 'share'] })

  assert.equal(sliceDirs.length, EXPECTED_SLICE_SUFFIXES.length)
  assert.deepEqual(fs.readdirSync(path.join(workdir, 'prebuilds')).sort(), ['include', 'share'])
  assert.ok(fs.existsSync(path.join(workdir, 'prebuilds', 'include', 'ggml.h')))
  for (const dir of sliceDirs) {
    const prebuilds = fs.readdirSync(path.join(dir, 'prebuilds'))
    assert.ok(!prebuilds.includes('include'), path.basename(dir) + ' must not carry include/')
    assert.ok(!prebuilds.includes('share'), path.basename(dir) + ' must not carry share/')
  }
})

test('treats undeclared meta dirs as unmapped hosts', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  addMetaDirs(workdir)

  assert.throws(() => slicePlatformPackages({ workdir, outDir }), /include, share/)
})

test('fails when a declared meta dir is missing from the artifact', async (t) => {
  const { slicePlatformPackages } = await slicerPromise
  const { root, workdir, outDir } = makeFixture(ALL_HOSTS)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  addMetaDirs(workdir)
  fs.rmSync(path.join(workdir, 'prebuilds', 'share'), { recursive: true })

  assert.throws(
    () => slicePlatformPackages({ workdir, outDir, keepDirs: ['include', 'share'] }),
    /missing the meta package dirs: share/
  )
})

test('links a source build as local platform packages for the built hosts', async (t) => {
  const { linkLocalPlatformPackages, PLATFORM_INDEX_SOURCE } = await slicerPromise
  const { root, workdir } = makeFixture(['linux-x64', 'android-arm64'])
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  addMetaDirs(workdir)

  const linked = linkLocalPlatformPackages({ workdir, keepDirs: ['include', 'share'] })

  const scope = path.join(workdir, 'node_modules', '@qvac')
  assert.deepEqual(linked, [
    path.join(scope, 'fake-ggml-linux-x64'),
    path.join(scope, 'fake-ggml-android-arm64')
  ])
  const pkg = path.join(scope, 'fake-ggml-linux-x64')
  assert.equal(readJson(pkg, 'package.json').addon, true)
  assert.equal(fs.readFileSync(path.join(pkg, 'index.js'), 'utf8'), PLATFORM_INDEX_SOURCE)
  assert.equal(
    fs.readFileSync(path.join(pkg, 'prebuilds', 'linux-x64', 'qvac__fake-ggml-linux-x64.bare'), 'utf8'),
    'binary-linux-x64'
  )
  assert.ok(fs.existsSync(path.join(workdir, 'prebuilds', 'linux-x64')), 'the meta keeps its prebuilds')
  assert.deepEqual(readJson(workdir, 'package.json'), META_MANIFEST, 'the meta manifest is untouched')

  fs.writeFileSync(path.join(workdir, 'prebuilds', 'linux-x64', 'qvac__fake-ggml-linux-x64.bare'), 'rebuilt')
  assert.equal(
    fs.readFileSync(path.join(pkg, 'prebuilds', 'linux-x64', 'qvac__fake-ggml-linux-x64.bare'), 'utf8'),
    'rebuilt',
    'a rebuild is visible without re-linking'
  )
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
