#!/usr/bin/env node
// QVAC-23767: hard merge gate for the linux prebuild dynamic-linking layout.
//
// Scans the linux prebuild artifacts and fails (exit 1) when
//   - the addon (.bare) hard-links a GPU userspace loader or an external C++
//     runtime (either breaks a CPU-only host at addon load, gh#3853), or
//   - the dlopen'd Vulkan backend module is missing, or itself depends on an
//     external C++ runtime (its dlopen would fail silently on stock distros).
//   - the Linux CUDA backend module is missing or links an external
//     C++ runtime. CUDA stays isolated in that module for CPU-only hosts.
//
// This is the blocking twin of test/integration/prebuild-dynamic-linking.
// test.js: the integration legs are continue-on-error (a signal, not a
// gate), so this script runs in the non-soft verify-prebuild-linking job of
// on-pr-nx.yml, whose result feeds the prebuild status Merge Guard requires.
// The prebuild workflow also runs it before merging release artifacts.
// Plain Node, no dependencies.
//
// Usage: node verify-prebuild-linking.mjs <prebuilds-dir>

import fs from 'node:fs'
import path from 'node:path'

const TARGETS = ['linux-x64', 'linux-arm64']

// Platform-package module name. Every iOS host shares `ios`; desktop and
// Android use the host triple. Keep in sync with CMakeLists.txt and
// SLICE_DEFINITIONS in scripts/ci/slice-platform-packages.mjs.
function moduleNameForHost(host) {
  const suffix = host.startsWith('ios-') ? 'ios' : host
  return `qvac__diffusion-cpp-${suffix}`
}
const FORBIDDEN_NEEDED = [
  'libvulkan.',
  'libOpenCL.',
  'libcuda.',
  'libcudart.',
  'libcublas.',
  'libcublasLt.'
]
const FORBIDDEN_RUNTIME = ['libc++.', 'libc++abi.', 'libstdc++.']

// 32-bit-pair read of a little-endian u64 (offsets here are far below 2^53).
function readU64(buffer, off) {
  return buffer.readUInt32LE(off) + buffer.readUInt32LE(off + 4) * 0x100000000
}

// Minimal ELF64 reader for dependencies and required C++ runtime symbols.
function elfInfo(buffer) {
  const isElf =
    buffer.length > 0x40 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  if (!isElf) throw new Error('not an ELF file')
  if (buffer[4] !== 2) throw new Error('only ELF64 is supported')
  if (buffer[5] !== 1) throw new Error('only little-endian ELF is supported')

  const shoff = readU64(buffer, 0x28)
  const shentsize = buffer.readUInt16LE(0x3a)
  const shnum = buffer.readUInt16LE(0x3c)

  const sections = []
  for (let i = 0; i < shnum; i++) {
    const off = shoff + i * shentsize
    sections.push({
      type: buffer.readUInt32LE(off + 4),
      offset: readU64(buffer, off + 0x18),
      size: readU64(buffer, off + 0x20),
      link: buffer.readUInt32LE(off + 0x28),
      entrySize: readU64(buffer, off + 0x38)
    })
  }

  const SHT_DYNAMIC = 6
  const dynamic = sections.find((s) => s.type === SHT_DYNAMIC)
  if (!dynamic) throw new Error('no .dynamic section')
  const strtab = sections[dynamic.link]
  if (!strtab) throw new Error('no dynamic string table')

  const DT_NEEDED = 1
  const needed = []
  for (let off = dynamic.offset; off < dynamic.offset + dynamic.size; off += 16) {
    const tag = readU64(buffer, off)
    if (tag === 0) break
    if (tag !== DT_NEEDED) continue
    const strOff = strtab.offset + readU64(buffer, off + 8)
    const end = buffer.indexOf(0, strOff)
    needed.push(buffer.toString('utf8', strOff, end))
  }

  // Strong undefined C++ runtime symbols still break dlopen when no runtime
  // appears in DT_NEEDED. Node can mask this by already loading libstdc++.
  // Weak references may legitimately remain unresolved. These three __cxa
  // entry points belong to glibc, not to a separately shipped C++ runtime.
  const glibcCxa = new Set(['__cxa_atexit', '__cxa_finalize', '__cxa_thread_atexit_impl'])
  const cxxRuntime =
    /^(?:_Z(?:N[KVR]*(?:St|S[a-z]|10__cxxabiv1)|St|T[ISV](?:St|N10__cxxabiv1)|n[aw]|d[al])|__cxa_|__gxx_personality_v0)/
  const symbols = sections.find((section) => section.type === 11) // SHT_DYNSYM
  if (!symbols || symbols.entrySize !== 24 || symbols.size % 24 !== 0) {
    throw new Error('missing or invalid .dynsym section')
  }
  const symbolNames = sections[symbols.link]
  if (!symbolNames) throw new Error('no dynamic symbol string table')
  const unresolvedCxx = []
  for (let off = symbols.offset; off < symbols.offset + symbols.size; off += 24) {
    const binding = buffer[off + 4] >> 4
    const sectionIndex = buffer.readUInt16LE(off + 6)
    if (binding !== 1 || sectionIndex !== 0) continue // STB_GLOBAL, SHN_UNDEF
    const nameOffset = symbolNames.offset + buffer.readUInt32LE(off)
    const end = buffer.indexOf(0, nameOffset)
    if (end < nameOffset || end >= symbolNames.offset + symbolNames.size) {
      throw new Error('invalid dynamic symbol name')
    }
    const name = buffer.toString('utf8', nameOffset, end)
    if (!cxxRuntime.test(name)) continue
    if (glibcCxa.has(name) && needed.includes('libc.so.6')) continue
    unresolvedCxx.push(name)
  }
  return { needed, unresolvedCxx }
}

const prebuildsDir = process.argv[2]
if (!prebuildsDir) {
  console.error('usage: verify-prebuild-linking.mjs <prebuilds-dir>')
  process.exit(2)
}

let failures = 0
let checkedTargets = 0
const fail = (msg) => {
  failures++
  console.error(`FAIL: ${msg}`)
}

for (const target of TARGETS) {
  const moduleName = moduleNameForHost(target)
  const addonPath = path.join(prebuildsDir, target, `${moduleName}.bare`)
  if (!fs.existsSync(addonPath)) {
    console.log(`SKIP ${target}: no prebuild at ${addonPath}`)
    continue
  }
  checkedTargets++

  const { needed: addonNeeded, unresolvedCxx: addonUnresolvedCxx } = elfInfo(
    fs.readFileSync(addonPath)
  )
  if (addonUnresolvedCxx.length > 0) {
    fail(target + ': addon has unresolved C++ runtime symbols: ' + addonUnresolvedCxx.join(', '))
  }
  console.log(`${target}/${moduleName}.bare NEEDED: ${addonNeeded.join(', ')}`)
  for (const lib of [...FORBIDDEN_NEEDED, ...FORBIDDEN_RUNTIME]) {
    if (addonNeeded.some((n) => n.startsWith(lib))) {
      fail(`${target}: addon hard-links ${lib}* (breaks CPU-only hosts)`)
    }
  }

  const modulePath = path.join(prebuildsDir, target, moduleName, 'libqvac-diffusion-ggml-vulkan.so')
  if (!fs.existsSync(modulePath)) {
    fail(`${target}: Vulkan DL backend module missing at ${modulePath}`)
    continue
  }

  const { needed: moduleNeeded, unresolvedCxx: moduleUnresolvedCxx } = elfInfo(
    fs.readFileSync(modulePath)
  )
  if (moduleUnresolvedCxx.length > 0) {
    fail(
      target +
        ': Vulkan module has unresolved C++ runtime symbols: ' +
        moduleUnresolvedCxx.join(', ')
    )
  }
  console.log(`${target}/libqvac-diffusion-ggml-vulkan.so NEEDED: ${moduleNeeded.join(', ')}`)
  if (!moduleNeeded.some((n) => n.startsWith('libvulkan.'))) {
    fail(`${target}: Vulkan module does not link libvulkan (broken module)`)
  }
  for (const lib of FORBIDDEN_RUNTIME) {
    if (moduleNeeded.some((n) => n.startsWith(lib))) {
      fail(`${target}: Vulkan module depends on ${lib}* (dlopen fails on stock distros)`)
    }
  }

  const cudaPath = path.join(prebuildsDir, target, moduleName, 'libqvac-diffusion-ggml-cuda.so')
  if (!fs.existsSync(cudaPath)) {
    fail(`${target}: CUDA DL backend module missing at ${cudaPath}`)
    continue
  }
  const { needed: cudaNeeded, unresolvedCxx: cudaUnresolvedCxx } = elfInfo(
    fs.readFileSync(cudaPath)
  )
  if (cudaUnresolvedCxx.length > 0) {
    fail(
      target + ': CUDA module has unresolved C++ runtime symbols: ' + cudaUnresolvedCxx.join(', ')
    )
  }
  console.log(`${target}/libqvac-diffusion-ggml-cuda.so NEEDED: ${cudaNeeded.join(', ')}`)
  if (!cudaNeeded.some((n) => n.startsWith('libcudart.'))) {
    fail(`${target}: CUDA module does not link libcudart (broken module)`)
  }
  for (const lib of FORBIDDEN_RUNTIME) {
    if (cudaNeeded.some((n) => n.startsWith(lib))) {
      fail(`${target}: CUDA module depends on ${lib}* (dlopen fails on stock distros)`)
    }
  }
}

if (checkedTargets === 0) {
  console.error('FAIL: no linux prebuilds found to verify (artifact download broken?)')
  process.exit(1)
}
if (failures > 0) {
  console.error(`${failures} dynamic-linking violation(s); see FAIL lines above`)
  process.exit(1)
}
console.log(`OK: ${checkedTargets} linux target(s) verified`)
