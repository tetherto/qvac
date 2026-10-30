#!/usr/bin/env node
// QVAC-23767, QVAC-25560: hard merge gate for the linux and win32 prebuild
// dynamic-linking layout.
//
// Scans the linux and win32 prebuild artifacts and fails (exit 1) when
//   - the addon (.bare) hard-links a GPU userspace loader or an external C++
//     runtime (either breaks a CPU-only host at addon load, gh#3853), or
//   - the runtime-loaded Vulkan backend module is missing, or itself depends
//     on an external C++ runtime (its load would fail silently on stock
//     hosts).
//
// This is the blocking twin of test/integration/prebuild-dynamic-linking.
// test.js: the integration legs are continue-on-error (a signal, not a
// gate), so this script runs in the non-soft verify-prebuild-linking job of
// on-pr-diffusion-cpp.yml, whose result feeds the qvac/prebuild-diffusion-cpp
// commit status that Merge Guard requires. Plain Node, no dependencies.
//
// Usage: node verify-prebuild-linking.mjs <prebuilds-dir>

import fs from 'node:fs'
import path from 'node:path'

const TARGETS = ['linux-x64', 'linux-arm64']
const WIN_TARGETS = ['win32-x64']

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

// Minimal ELF64 dynamic-section reader: DT_NEEDED entries of a shared object.
function elfNeeded(buffer) {
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
      link: buffer.readUInt32LE(off + 0x28)
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
  return needed
}

// Windows twin of the ELF reader: the DLL names in a PE32+ import table and
// delay-load import table. Keep in sync with peImports in
// test/integration/prebuild-dynamic-linking.test.js.
function peImports(buffer) {
  const isMz = buffer.length > 0x40 && buffer[0] === 0x4d && buffer[1] === 0x5a
  if (!isMz) throw new Error('not a PE file')
  const pe = buffer.readUInt32LE(0x3c)
  if (buffer.readUInt32LE(pe) !== 0x00004550) throw new Error('missing PE signature')
  const numberOfSections = buffer.readUInt16LE(pe + 6)
  const sizeOfOptionalHeader = buffer.readUInt16LE(pe + 20)
  const optional = pe + 24
  if (buffer.readUInt16LE(optional) !== 0x20b) throw new Error('only PE32+ is supported')

  const sections = []
  for (let i = 0; i < numberOfSections; i++) {
    const off = optional + sizeOfOptionalHeader + i * 40
    sections.push({
      virtualAddress: buffer.readUInt32LE(off + 12),
      sizeOfRawData: buffer.readUInt32LE(off + 16),
      pointerToRawData: buffer.readUInt32LE(off + 20)
    })
  }
  const rvaToOffset = (rva) => {
    const s = sections.find(
      (sec) => rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.sizeOfRawData
    )
    if (!s) throw new Error('RVA outside every section: ' + rva)
    return rva - s.virtualAddress + s.pointerToRawData
  }

  const imports = []
  const readNames = (dirRva, descriptorSize, nameField) => {
    if (dirRva === 0) return
    for (let pos = rvaToOffset(dirRva); ; pos += descriptorSize) {
      const nameRva = buffer.readUInt32LE(pos + nameField)
      if (nameRva === 0) break
      const nameOff = rvaToOffset(nameRva)
      const end = buffer.indexOf(0, nameOff)
      imports.push(buffer.toString('utf8', nameOff, end).toLowerCase())
    }
  }

  // Data directory at optional header offset 112, entry count at 108. Entry 1
  // is the import table (20-byte descriptors, name at +12), entry 13 the
  // delay-load import table (32-byte descriptors, name at +4).
  const numberOfRvaAndSizes = buffer.readUInt32LE(optional + 108)
  const dirRva = (index) =>
    index < numberOfRvaAndSizes ? buffer.readUInt32LE(optional + 112 + index * 8) : 0
  readNames(dirRva(1), 20, 12)
  readNames(dirRva(13), 32, 4)
  return imports
}

// The prebuild links the static CRT; a dynamic UCRT shows up as the
// api-ms-win-crt-* API sets.
const FORBIDDEN_WIN_IMPORTS = [
  'vulkan-1.dll',
  'opencl.dll',
  'nvcuda.dll',
  'cudart64',
  'cublas64',
  'cublaslt64'
]
const FORBIDDEN_WIN_RUNTIME = ['vcruntime', 'msvcp', 'ucrtbase.dll', 'api-ms-win-crt-']

const prebuildsDir = process.argv[2]
if (!prebuildsDir) {
  console.error('usage: verify-prebuild-linking.mjs <prebuilds-dir>')
  process.exit(2)
}

let failures = 0
let checkedTargets = 0
let linuxCheckedTargets = 0
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
  linuxCheckedTargets++

  const addonNeeded = elfNeeded(fs.readFileSync(addonPath))
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

  const moduleNeeded = elfNeeded(fs.readFileSync(modulePath))
  console.log(`${target}/libqvac-diffusion-ggml-vulkan.so NEEDED: ${moduleNeeded.join(', ')}`)
  if (!moduleNeeded.some((n) => n.startsWith('libvulkan.'))) {
    fail(`${target}: Vulkan module does not link libvulkan (broken module)`)
  }
  for (const lib of FORBIDDEN_RUNTIME) {
    if (moduleNeeded.some((n) => n.startsWith(lib))) {
      fail(`${target}: Vulkan module depends on ${lib}* (dlopen fails on stock distros)`)
    }
  }
}

// CI runs this gate only after every prebuild succeeded, so the merged
// artifact always carries win32-x64; a missing one means it was dropped or
// staged under the wrong name, and skipping it would pass the gate unchecked.
for (const target of WIN_TARGETS) {
  const moduleName = moduleNameForHost(target)
  const addonPath = path.join(prebuildsDir, target, `${moduleName}.bare`)
  if (!fs.existsSync(addonPath)) {
    fail(`${target}: no prebuild at ${addonPath}`)
    continue
  }
  checkedTargets++

  const addonImports = peImports(fs.readFileSync(addonPath))
  console.log(`${target}/${moduleName}.bare imports: ${addonImports.join(', ')}`)
  for (const dll of [...FORBIDDEN_WIN_IMPORTS, ...FORBIDDEN_WIN_RUNTIME]) {
    if (addonImports.some((n) => n.startsWith(dll))) {
      fail(`${target}: addon imports ${dll}* (breaks hosts without it)`)
    }
  }

  const modulePath = path.join(prebuildsDir, target, moduleName, 'qvac-diffusion-ggml-vulkan.dll')
  if (!fs.existsSync(modulePath)) {
    fail(`${target}: Vulkan DL backend module missing at ${modulePath}`)
    continue
  }

  const moduleImports = peImports(fs.readFileSync(modulePath))
  console.log(`${target}/qvac-diffusion-ggml-vulkan.dll imports: ${moduleImports.join(', ')}`)
  if (!moduleImports.includes('vulkan-1.dll')) {
    fail(`${target}: Vulkan module does not import vulkan-1.dll (broken module)`)
  }
  for (const dll of FORBIDDEN_WIN_RUNTIME) {
    if (moduleImports.some((n) => n.startsWith(dll))) {
      fail(`${target}: Vulkan module imports ${dll}* (LoadLibrary fails on stock hosts)`)
    }
  }
}

// A present win32 prebuild must not hide missing linux ones.
if (linuxCheckedTargets === 0) {
  console.error('FAIL: no linux prebuilds found to verify (artifact download broken?)')
  process.exit(1)
}
if (failures > 0) {
  console.error(`${failures} dynamic-linking violation(s); see FAIL lines above`)
  process.exit(1)
}
console.log(`OK: ${checkedTargets} target(s) verified`)
