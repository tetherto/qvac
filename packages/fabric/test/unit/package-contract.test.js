'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { evaluate, packageRoot } = require('./helpers')
const packageJson = require('../../package.json')
const projectJson = require('../../project.json')
const vcpkgJson = require('../../vcpkg.json')

const ADDON_UNAVAILABLE = './addon-unavailable.js'
const slicerUrl = pathToFileURL(
  path.resolve(packageRoot, '../../scripts/ci/slice-platform-packages.mjs')
).href

function read(file) {
  return fs.readFileSync(path.join(packageRoot, file), 'utf8')
}

// Walk the conditional map the way Bare does: the first key that is `default`
// or one of the host's platform/arch conditions wins, recursively.
function importsTargetForHost(host) {
  const conditions = host.split('-')
  let target = packageJson.imports['#host-addon']
  while (target && typeof target === 'object' && !Array.isArray(target)) {
    const matched = Object.keys(target).find(
      (condition) => condition === 'default' || conditions.includes(condition)
    )
    target = target[matched]
  }
  return target
}

function loadUnavailable(host) {
  try {
    evaluate('addon-unavailable.js', () => {
      const fakeRequire = () => {
        throw new Error('addon-unavailable.js must not require anything')
      }
      fakeRequire.addon = { host }
      return fakeRequire
    })
  } catch (err) {
    return err
  }
  throw new Error('addon-unavailable.js must throw on load')
}

// Evaluates cmake/qvac-fabric-hosts.cmake, the mapping the native build names
// its module with, so it cannot drift from the imports map and the slicer.
function cmakeModuleNames(hosts) {
  const script = [
    `include("${path.join(packageRoot, 'cmake/qvac-fabric-hosts.cmake').replace(/\\/g, '/')}")`,
    ...hosts.flatMap((host) => [
      `qvac_fabric_module_name("${host}" name)`,
      `qvac_fabric_platform_package("${host}" package)`,
      `message(STATUS "${host} \${name} \${package}")`
    ])
  ].join('\n')
  const file = path.join(require('node:os').tmpdir(), `qvac-fabric-hosts-${process.pid}.cmake`)
  fs.writeFileSync(file, script)
  try {
    const result = spawnSync('cmake', ['-P', file], { encoding: 'utf8' })
    if (result.error && result.error.code === 'ENOENT') return null
    assert.equal(result.status, 0, result.stderr)
    const names = {}
    for (const line of result.stdout.split('\n')) {
      const match = /^-- (\S+) (\S+) (\S+)$/.exec(line.trim())
      if (match) names[match[1]] = { module: match[2], package: match[3] }
    }
    return names
  } finally {
    fs.rmSync(file, { force: true })
  }
}

test('binding.js is the one-line literal the module lexer can follow', () => {
  assert.equal(read('binding.js'), "module.exports = require('#host-addon')\n")
})

test('the meta is JavaScript only: no addon flag, no backends helper', () => {
  assert.equal(packageJson.addon, undefined, 'the runtime lives in the platform packages')
  assert.deepEqual(Object.keys(packageJson.exports).sort(), ['.', './package'])
  assert.equal(packageJson.exports['.'], './binding.js')
  for (const file of ['backends.js', 'backends.d.ts']) {
    assert.ok(!fs.existsSync(path.join(packageRoot, file)), file + ' is gone')
    assert.ok(!packageJson.files.includes(file), file)
  }
})

test('the imports map routes every published host straight to its platform package', async () => {
  const { SLICE_DEFINITIONS, hostToSliceSuffix } = await import(slicerUrl)
  for (const host of SLICE_DEFINITIONS.flatMap((definition) => definition.hosts)) {
    // A fallback array would hide a missing platform package from bare-pack,
    // which takes the first target it finds and bundles addon-unavailable.js.
    assert.equal(importsTargetForHost(host), '@qvac/fabric-' + hostToSliceSuffix(host), host)
  }
})

test('the imports map routes unpublished hosts to the actionable error', () => {
  for (const host of [
    'android-x64',
    'android-arm',
    'linux-riscv64',
    'darwin-ppc64',
    'freebsd-x64'
  ]) {
    assert.equal(importsTargetForHost(host), ADDON_UNAVAILABLE, host)
  }
})

test('the native module is named after the platform package that ships it', async (t) => {
  const { SLICE_DEFINITIONS, expectedAddonFile, slicePackageName } = await import(slicerUrl)
  const hosts = SLICE_DEFINITIONS.flatMap((definition) => definition.hosts)
  const names = cmakeModuleNames(hosts)
  if (!names) return t.skip('cmake is not on PATH')
  for (const definition of SLICE_DEFINITIONS) {
    for (const host of definition.hosts) {
      assert.equal(names[host].package, slicePackageName(packageJson.name, definition), host)
      assert.equal(names[host].module + '.bare', expectedAddonFile(packageJson.name, host), host)
    }
  }
  assert.match(
    read('CMakeLists.txt'),
    /add_bare_module\(qvac-fabric NAME \$\{_fabric_module_name\}/
  )
})

test('fabric exports its own C API on every platform', () => {
  const header = read('include/qvac-fabric.h')
  for (const symbol of ['qvac_fabric_load_backends', 'qvac_fabric_backends_dir']) {
    assert.match(header, new RegExp(`QVAC_FABRIC_API [^;(]+\\b${symbol}\\(void\\);`), symbol)
  }
  assert.match(read('symbols.map'), /^\s*qvac_fabric_\*;/m)
  assert.match(read('exports.txt'), /^_qvac_fabric_\*$/m)
  assert.match(
    read('CMakeLists.txt'),
    /install\(FILES include\/qvac-fabric\.h DESTINATION include\)/
  )
})

test('optionalDependencies are injected at publish, not declared in the source manifest', () => {
  assert.equal(packageJson.optionalDependencies, undefined)
  assert.equal(packageJson.peerDependencies, undefined)
})

test('Linux prebuilds enable RDMA and install its build dependency', () => {
  const fabric = vcpkgJson.dependencies.find((dependency) => dependency.name === 'qvac-fabric')
  assert.ok(fabric)
  assert.ok(
    fabric.features.some((feature) => feature.name === 'rpc-rdma' && feature.platform === 'linux')
  )
  assert.match(
    projectJson.targets.build.options.ci.linuxExtraPackages,
    /(?:^|\s)libibverbs-dev(?:\s|$)/
  )
})

test('the meta package publishes the loader and the C++ SDK', () => {
  for (const file of ['binding.js', 'addon-unavailable.js']) {
    assert.ok(packageJson.files.includes(file), file)
  }
  for (const dir of ['prebuilds/include', 'prebuilds/share/qvac-fabric']) {
    assert.ok(packageJson.files.includes(dir), dir)
  }
})

test('an unpublished host is told which hosts have a runtime and to build from source', () => {
  const err = loadUnavailable('linux-riscv64')
  assert.match(err.message, /no prebuilt runtime for host linux-riscv64/)
  assert.match(
    err.message,
    /linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64, android-arm64 and ios/
  )
  assert.match(err.message, /bare-make/)
})
