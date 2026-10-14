import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const checker = fileURLToPath(new URL('./verify-prebuild-linking.mjs', import.meta.url))
const moduleName = 'qvac__diffusion-cpp'

// Minimal ELF fixture with a dynamic string table and DT_NEEDED records.
// Only dependency names vary between the packaging failure cases.
function elf(dependencies) {
  const names = Buffer.from('\0' + dependencies.join('\0') + '\0')
  const dynamicOffset = 0x140
  const dynamicSize = (dependencies.length + 1) * 16
  const stringsOffset = dynamicOffset + dynamicSize
  const buffer = Buffer.alloc(stringsOffset + names.length)
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  buffer.writeBigUInt64LE(0x80n, 0x28)
  buffer.writeUInt16LE(64, 0x3a)
  buffer.writeUInt16LE(3, 0x3c)
  buffer.writeUInt32LE(6, 0xc0 + 4)
  buffer.writeBigUInt64LE(BigInt(dynamicOffset), 0xc0 + 0x18)
  buffer.writeBigUInt64LE(BigInt(dynamicSize), 0xc0 + 0x20)
  buffer.writeUInt32LE(2, 0xc0 + 0x28)
  buffer.writeUInt32LE(3, 0x100 + 4)
  buffer.writeBigUInt64LE(BigInt(stringsOffset), 0x100 + 0x18)
  buffer.writeBigUInt64LE(BigInt(names.length), 0x100 + 0x20)
  let offset = 1
  dependencies.forEach((name, index) => {
    buffer.writeBigUInt64LE(1n, dynamicOffset + index * 16)
    buffer.writeBigUInt64LE(BigInt(offset), dynamicOffset + index * 16 + 8)
    offset += Buffer.byteLength(name) + 1
  })
  names.copy(buffer, stringsOffset)
  return buffer
}

function fixture(t, { arch = 'arm64', cuda = ['libcudart.so.13'], addon = ['libc.so.6'] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-prebuild-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, `linux-${arch}`)
  const backends = path.join(target, moduleName)
  fs.mkdirSync(backends, { recursive: true })
  fs.writeFileSync(path.join(target, `${moduleName}.bare`), elf(addon))
  fs.writeFileSync(path.join(backends, 'libqvac-diffusion-ggml-vulkan.so'), elf(['libvulkan.so.1']))
  if (cuda) fs.writeFileSync(path.join(backends, 'libqvac-diffusion-ggml-cuda.so'), elf(cuda))
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
