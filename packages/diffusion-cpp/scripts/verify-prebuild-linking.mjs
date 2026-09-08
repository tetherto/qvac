#!/usr/bin/env node
// QVAC-23767: hard merge gate for the linux prebuild dynamic-linking layout.
//
// Scans the linux prebuild artifacts and fails (exit 1) when
//   - the addon (.bare) hard-links a GPU userspace loader or an external C++
//     runtime (either breaks a CPU-only host at addon load, gh#3853), or
//   - the dlopen'd Vulkan backend module is missing, or itself depends on an
//     external C++ runtime (its dlopen would fail silently on stock distros).
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

const MODULE_NAME = 'qvac__diffusion-cpp'
const TARGETS = ['linux-x64', 'linux-arm64']
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
  const addonPath = path.join(prebuildsDir, target, `${MODULE_NAME}.bare`)
  if (!fs.existsSync(addonPath)) {
    console.log(`SKIP ${target}: no prebuild at ${addonPath}`)
    continue
  }
  checkedTargets++

  const addonNeeded = elfNeeded(fs.readFileSync(addonPath))
  console.log(`${target}/${MODULE_NAME}.bare NEEDED: ${addonNeeded.join(', ')}`)
  for (const lib of [...FORBIDDEN_NEEDED, ...FORBIDDEN_RUNTIME]) {
    if (addonNeeded.some((n) => n.startsWith(lib))) {
      fail(`${target}: addon hard-links ${lib}* (breaks CPU-only hosts)`)
    }
  }

  const modulePath = path.join(
    prebuildsDir,
    target,
    MODULE_NAME,
    'libqvac-diffusion-ggml-vulkan.so'
  )
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

if (checkedTargets === 0) {
  console.error('FAIL: no linux prebuilds found to verify (artifact download broken?)')
  process.exit(1)
}
if (failures > 0) {
  console.error(`${failures} dynamic-linking violation(s); see FAIL lines above`)
  process.exit(1)
}
console.log(`OK: ${checkedTargets} linux target(s) verified`)
