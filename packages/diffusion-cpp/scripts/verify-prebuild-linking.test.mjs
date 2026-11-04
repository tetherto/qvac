import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  SLICE_DEFINITIONS,
  expectedAddonFile,
  slicePlatformPackages
} from '../../../scripts/ci/slice-platform-packages.mjs'

const checker = fileURLToPath(new URL('./verify-prebuild-linking.mjs', import.meta.url))

test('CUDA is opt-in for source builds and enabled for Linux release prebuilds', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../vcpkg.json', import.meta.url), 'utf8'))
  const project = JSON.parse(fs.readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
  const dependency = manifest.dependencies.find((entry) => entry.name === 'stable-diffusion-cpp')
  assert.equal(dependency.features, undefined, 'ordinary source builds must not request CUDA')
  assert.ok(
    manifest.features.cuda.dependencies.some(
      (entry) => entry.name === 'stable-diffusion-cpp' && entry.features.includes('cuda')
    )
  )
  const cmake = fs.readFileSync(new URL('../CMakeLists.txt', import.meta.url), 'utf8')
  assert.ok(cmake.includes('include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/ConfigureCuda.cmake)'))
  const cudaConfig = fs.readFileSync(
    new URL('../cmake/ConfigureCuda.cmake', import.meta.url),
    'utf8'
  )
  assert.match(cudaConfig, /if\(SD_CUDA\)\s+list\(APPEND VCPKG_MANIFEST_FEATURES "cuda"\)/)
  assert.equal(project.targets.build.options.ci.includeCuda, true)
  assert.equal(project.targets.build.options.ci.includeCudaArm64, true)
  assert.equal(project.targets.build.options.ci.platformCmakeDefines, 'linux: -D SD_CUDA=ON')
})

// Real ELF64 section and symbol layouts, including symbol binding/definition.
// The dependency-only fixtures missed the CUDA module's unresolved std symbols.
function elf(dependencies, symbols = []) {
  const names = Buffer.from(
    '\0' + [...dependencies, ...symbols.map((s) => s.name)].join('\0') + '\0'
  )
  const dynamicOffset = 0x180
  const dynamicSize = (dependencies.length + 1) * 16
  const symbolsOffset = dynamicOffset + dynamicSize
  const symbolsSize = (symbols.length + 1) * 24
  const stringsOffset = symbolsOffset + symbolsSize
  const buffer = Buffer.alloc(stringsOffset + names.length)
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buffer.writeBigUInt64LE(0x80n, 0x28)
  buffer.writeUInt16LE(64, 0x3a)
  buffer.writeUInt16LE(4, 0x3c)
  function section(index, type, offset, size, link = 0, entrySize = 0) {
    const start = 0x80 + index * 64
    buffer.writeUInt32LE(type, start + 4)
    buffer.writeBigUInt64LE(BigInt(offset), start + 0x18)
    buffer.writeBigUInt64LE(BigInt(size), start + 0x20)
    buffer.writeUInt32LE(link, start + 0x28)
    buffer.writeBigUInt64LE(BigInt(entrySize), start + 0x38)
  }
  section(1, 6, dynamicOffset, dynamicSize, 2, 16)
  section(2, 3, stringsOffset, names.length)
  section(3, 11, symbolsOffset, symbolsSize, 2, 24)
  let offset = 1
  dependencies.forEach((name, index) => {
    buffer.writeBigUInt64LE(1n, dynamicOffset + index * 16)
    buffer.writeBigUInt64LE(BigInt(offset), dynamicOffset + index * 16 + 8)
    offset += Buffer.byteLength(name) + 1
  })
  symbols.forEach((symbol, index) => {
    const start = symbolsOffset + (index + 1) * 24
    buffer.writeUInt32LE(offset, start)
    buffer[start + 4] = (symbol.weak ? 2 : 1) << 4
    buffer.writeUInt16LE(symbol.defined ? 1 : 0, start + 6)
    offset += Buffer.byteLength(symbol.name) + 1
  })
  names.copy(buffer, stringsOffset)
  return buffer
}

function fixture(
  t,
  { arch = 'arm64', cuda = ['libcudart.so.13'], addon = ['libc.so.6'], symbols = [] } = {}
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-prebuild-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const moduleName = `qvac__diffusion-cpp-linux-${arch}`
  const target = path.join(directory, `linux-${arch}`)
  const backends = path.join(target, moduleName)
  fs.mkdirSync(backends, { recursive: true })
  fs.writeFileSync(path.join(target, `${moduleName}.bare`), elf(addon))
  fs.writeFileSync(path.join(backends, 'libqvac-diffusion-ggml-vulkan.so'), elf(['libvulkan.so.1']))
  if (cuda)
    fs.writeFileSync(path.join(backends, 'libqvac-diffusion-ggml-cuda.so'), elf(cuda, symbols))
  const result = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })
  return { status: result.status, output: result.stdout + result.stderr }
}

for (const arch of ['arm64', 'x64']) {
  test(`${arch} release ships CUDA and Vulkan without hard addon GPU dependencies`, (t) => {
    const result = fixture(t, { arch })
    assert.equal(result.status, 0, result.output)
  })

  test(`${arch} release fails when the CUDA module is missing`, (t) => {
    const result = fixture(t, { arch, cuda: null })
    assert.equal(result.status, 1)
    assert.match(result.output, /CUDA DL backend module missing/)
  })

  test(`${arch} release fails when the CUDA module does not link its runtime`, (t) => {
    const result = fixture(t, { arch, cuda: ['libc.so.6'] })
    assert.equal(result.status, 1)
    assert.match(result.output, /CUDA module does not link libcudart/)
  })

  test(`${arch} release fails when CUDA depends on an external C++ runtime`, (t) => {
    const result = fixture(t, { arch, cuda: ['libcudart.so.13', 'libstdc++.so.6'] })
    assert.equal(result.status, 1)
    assert.match(result.output, /CUDA module depends on libstdc\+\+/)
  })

  test(`${arch} addon must stay loadable without CUDA installed`, (t) => {
    const result = fixture(t, { arch, addon: ['libc.so.6', 'libcudart.so.13'] })
    assert.equal(result.status, 1)
    assert.match(result.output, /addon hard-links libcudart/)
  })
}

test('split publication retains CUDA and Vulkan in both Linux platform packages', (t) => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-slices-'))
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }))
  const meta = { name: '@qvac/diffusion-cpp', version: '0.30.0' }
  fs.writeFileSync(path.join(workdir, 'package.json'), JSON.stringify(meta))
  for (const definition of SLICE_DEFINITIONS) {
    for (const host of definition.hosts) {
      const hostDir = path.join(workdir, 'prebuilds', host)
      fs.mkdirSync(hostDir, { recursive: true })
      const addonName = expectedAddonFile(meta.name, host)
      fs.writeFileSync(path.join(hostDir, addonName), elf(['libc.so.6']))
      if (!host.startsWith('linux-')) continue
      const backends = path.join(hostDir, addonName.replace(/\.bare$/, ''))
      fs.mkdirSync(backends)
      fs.writeFileSync(
        path.join(backends, 'libqvac-diffusion-ggml-vulkan.so'),
        elf(['libvulkan.so.1'])
      )
      fs.writeFileSync(
        path.join(backends, 'libqvac-diffusion-ggml-cuda.so'),
        elf(['libcudart.so.13'])
      )
    }
  }
  const slices = slicePlatformPackages({ workdir, outDir: path.join(workdir, 'slices') })
  for (const arch of ['x64', 'arm64']) {
    const directory = slices.find((slice) => slice.endsWith(`-linux-${arch}`))
    assert.ok(directory, `linux-${arch} platform package exists`)
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `@qvac/diffusion-cpp-linux-${arch}`)
    assert.equal(manifest.version, meta.version)
    const result = spawnSync(process.execPath, [checker, path.join(directory, 'prebuilds')], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
})

for (const name of [
  '_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE10_M_replaceEmmPKcm',
  '_ZSt21ios_base_library_initv',
  '_ZNKSt8__detail20_Prime_rehash_policy11_M_next_bktEm',
  '__cxa_throw',
  '__gxx_personality_v0',
  '_Znwm',
  '_ZdlPv'
]) {
  test('rejects unresolved C++ runtime symbol ' + name, (t) => {
    const result = fixture(t, { symbols: [{ name }] })
    assert.equal(result.status, 1, result.output)
    assert.ok(result.output.includes(name), result.output)
    assert.match(result.output, /CUDA module has unresolved C\+\+ runtime symbols/)
  })
}

test('accepts statically defined runtime symbols and optional weak references', (t) => {
  const result = fixture(t, {
    symbols: [
      { name: '_ZSt21ios_base_library_initv', defined: true },
      { name: '__cxa_pure_virtual', weak: true }
    ]
  })
  assert.equal(result.status, 0, result.output)
})

test('accepts glibc-provided __cxa entry points', (t) => {
  const result = fixture(t, {
    cuda: ['libcudart.so.13', 'libc.so.6'],
    symbols: ['__cxa_atexit', '__cxa_finalize', '__cxa_thread_atexit_impl'].map((name) => ({
      name
    }))
  })
  assert.equal(result.status, 0, result.output)
})

test('requires libc for its __cxa entry points', (t) => {
  const result = fixture(t, { symbols: [{ name: '__cxa_finalize' }] })
  assert.equal(result.status, 1, result.output)
})

test('standalone and integration ELF readers reject the same runtime-symbol failures', () => {
  for (const [file, endMarker] of [
    ['./verify-prebuild-linking.mjs', 'const prebuildsDir ='],
    ['../test/integration/prebuild-dynamic-linking.test.js', "test('linux prebuild"]
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    const start = source.indexOf('function readU64(')
    const end = source.indexOf(endMarker, start)
    assert.ok(start >= 0 && end > start, file)
    const read = vm.runInNewContext(source.slice(start, end) + '\nelfInfo', { Buffer })
    const cases = [
      { name: '_ZSt21ios_base_library_initv', expected: ['_ZSt21ios_base_library_initv'] },
      { name: '_ZSt21ios_base_library_initv', defined: true, expected: [] },
      { name: '__cxa_throw', expected: ['__cxa_throw'] },
      { name: '__cxa_pure_virtual', weak: true, expected: [] },
      { name: '__cxa_finalize', expected: [] },
      { name: 'cudaGetDevice', expected: [] }
    ]
    for (const { expected, ...symbol } of cases) {
      const result = read(elf(['libcudart.so.13', 'libc.so.6'], [symbol]))
      assert.deepEqual(Array.from(result.unresolvedCxx), expected, file + ': ' + symbol.name)
    }
    const missingSymbols = elf(['libcudart.so.13'])
    missingSymbols.writeUInt32LE(0, 0x140 + 4)
    assert.throws(() => read(missingSymbols), /missing or invalid .dynsym/)
  }
})

async function integrationLayout({
  arch = 'x64',
  env = {},
  cuda = null,
  addon = ['libc.so.6'],
  vulkan = ['libvulkan.so.1']
} = {}) {
  const file = new URL('../test/integration/prebuild-dynamic-linking.test.js', import.meta.url)
  const directory = path.dirname(fileURLToPath(file))
  const target = path.resolve(directory, '../../prebuilds', `linux-${arch}`)
  const moduleName = `qvac__diffusion-cpp-linux-${arch}`
  const addonPath = path.join(target, `${moduleName}.bare`)
  const vulkanPath = path.join(target, moduleName, 'libqvac-diffusion-ggml-vulkan.so')
  const cudaPath = path.join(target, moduleName, 'libqvac-diffusion-ggml-cuda.so')
  const files = new Map([
    [addonPath, elf(addon)],
    [vulkanPath, elf(vulkan)]
  ])
  if (cuda) files.set(cudaPath, elf(cuda))
  const reads = []
  const comments = []
  const failures = []
  const tests = new Map()
  const modules = {
    'bare-path': path,
    'bare-os': { platform: () => 'linux', arch: () => arch },
    'bare-process': { env },
    'bare-fs': {
      existsSync: (file) => files.has(file),
      readFileSync(file) {
        reads.push(file)
        assert.ok(files.has(file), `must not read a missing module: ${file}`)
        return files.get(file)
      }
    },
    brittle: (name, ...args) => tests.set(name, args.at(-1))
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    __dirname: directory,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected module: ${name}`)
      return modules[name]
    }
  })
  const layout = tests.get(
    'linux prebuild has no hard GPU-loader deps and ships DL backend modules'
  )
  assert.equal(typeof layout, 'function')
  await layout({
    ok: (value, message) => assert.ok(value, message),
    absent: (value, message) => assert.ok(!value, message),
    alike: (actual, expected, message) =>
      assert.deepEqual(Array.from(actual), Array.from(expected), message),
    fail: (message) => failures.push(message),
    pass() {},
    comment: (message) => comments.push(message)
  })
  return { reads, comments, failures, addonPath, vulkanPath, cudaPath }
}

for (const arch of ['x64', 'arm64']) {
  test(`${arch} local integration checks addon and Vulkan without requiring CUDA`, async () => {
    const result = await integrationLayout({ arch })
    assert.deepEqual(result.reads, [result.addonPath, result.vulkanPath])
    assert.deepEqual(result.failures, [])
    assert.ok(result.comments.some((message) => message.includes('skipping CUDA checks')))
  })

  for (const env of [{ CI: 'true' }, { QVAC_REQUIRE_CUDA_MODULE: 'true' }]) {
    test(`${arch} integration reports missing CUDA cleanly with ${JSON.stringify(env)}`, async () => {
      const result = await integrationLayout({ arch, env })
      assert.deepEqual(result.reads, [result.addonPath, result.vulkanPath])
      assert.equal(result.failures.length, 1)
      assert.match(result.failures[0], /CUDA DL backend module missing/)
    })
  }

  test(`${arch} local integration validates CUDA whenever it is present`, async () => {
    const result = await integrationLayout({ arch, cuda: ['libcudart.so.13'] })
    assert.deepEqual(result.reads, [result.addonPath, result.vulkanPath, result.cudaPath])
    assert.deepEqual(result.failures, [])
    await assert.rejects(
      integrationLayout({ arch, cuda: ['libcudart.so.13', 'libstdc++.so.6'] }),
      /CUDA module must not depend on/
    )
  })
}

test('local integration still rejects broken addon or Vulkan linkage without CUDA', async () => {
  await assert.rejects(
    integrationLayout({ addon: ['libc.so.6', 'libcudart.so.13'] }),
    /addon must not hard-link/
  )
  await assert.rejects(
    integrationLayout({ vulkan: ['libvulkan.so.1', 'libstdc++.so.6'] }),
    /Vulkan module must not depend on/
  )
})
