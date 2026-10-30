import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'verify-prebuild-linking.mjs')

// Smallest ELF64 the checker accepts: a dynamic string table and a .dynamic
// section holding one DT_NEEDED per name.
function elfWithNeeded(names) {
  const strtab = Buffer.concat([Buffer.alloc(1), ...names.map((n) => Buffer.from(n + '\0'))])
  const dynamic = Buffer.alloc((names.length + 1) * 16)
  let strOff = 1
  names.forEach((name, i) => {
    dynamic.writeUInt32LE(1, i * 16) // DT_NEEDED
    dynamic.writeUInt32LE(strOff, i * 16 + 8)
    strOff += name.length + 1
  })
  const strtabOff = 0x40
  const dynamicOff = strtabOff + strtab.length
  const shoff = dynamicOff + dynamic.length
  const header = Buffer.alloc(0x40)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  header.writeUInt32LE(shoff, 0x28)
  header.writeUInt16LE(64, 0x3a)
  header.writeUInt16LE(2, 0x3c)
  const sections = Buffer.alloc(2 * 64)
  sections.writeUInt32LE(3, 4) // SHT_STRTAB
  sections.writeUInt32LE(strtabOff, 0x18)
  sections.writeUInt32LE(strtab.length, 0x20)
  sections.writeUInt32LE(6, 64 + 4) // SHT_DYNAMIC
  sections.writeUInt32LE(dynamicOff, 64 + 0x18)
  sections.writeUInt32LE(dynamic.length, 64 + 0x20)
  sections.writeUInt32LE(0, 64 + 0x28) // sh_link -> strtab
  return Buffer.concat([header, strtab, dynamic, sections])
}

// Smallest PE32+ the checker accepts: one section holding an import table
// with one descriptor per DLL name.
function peWithImports(names) {
  const pe = 0x80
  const optional = pe + 24
  const sizeOfOptionalHeader = 112 + 16 * 8
  const sectionTable = optional + sizeOfOptionalHeader
  const rawOff = 0x400
  const rva = 0x1000
  const buffer = Buffer.alloc(rawOff + 0x200)
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(pe, 0x3c)
  buffer.writeUInt32LE(0x00004550, pe)
  buffer.writeUInt16LE(1, pe + 6)
  buffer.writeUInt16LE(sizeOfOptionalHeader, pe + 20)
  buffer.writeUInt16LE(0x20b, optional)
  buffer.writeUInt32LE(16, optional + 108)
  buffer.writeUInt32LE(rva, optional + 112 + 8) // data directory 1: imports
  buffer.writeUInt32LE(rva, sectionTable + 12)
  buffer.writeUInt32LE(0x200, sectionTable + 16)
  buffer.writeUInt32LE(rawOff, sectionTable + 20)
  let nameRva = rva + (names.length + 1) * 20
  names.forEach((name, i) => {
    buffer.writeUInt32LE(nameRva, rawOff + i * 20 + 12)
    buffer.write(name + '\0', rawOff + (nameRva - rva), 'latin1')
    nameRva += name.length + 1
  })
  return buffer
}

function writeFile(root, rel, content) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function stageLinux(root, target) {
  const moduleName = `qvac__diffusion-cpp-${target}`
  writeFile(root, `${target}/${moduleName}.bare`, elfWithNeeded(['libc.so.6']))
  writeFile(
    root,
    `${target}/${moduleName}/libqvac-diffusion-ggml-vulkan.so`,
    elfWithNeeded(['libvulkan.so.1', 'libc.so.6'])
  )
}

function stageWin32(root, addonImports = ['kernel32.dll']) {
  const moduleName = 'qvac__diffusion-cpp-win32-x64'
  writeFile(root, `win32-x64/${moduleName}.bare`, peWithImports(addonImports))
  writeFile(
    root,
    `win32-x64/${moduleName}/qvac-diffusion-ggml-vulkan.dll`,
    peWithImports(['vulkan-1.dll', 'kernel32.dll'])
  )
}

function check(stage) {
  const root = mkdtempSync(join(tmpdir(), 'diffusion-linking-'))
  try {
    stage(root)
    return spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('passes a complete linux and win32 artifact set', () => {
  const result = check((root) => {
    stageLinux(root, 'linux-x64')
    stageLinux(root, 'linux-arm64')
    stageWin32(root)
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('fails when the win32 prebuild is missing', () => {
  const result = check((root) => {
    stageLinux(root, 'linux-x64')
    stageLinux(root, 'linux-arm64')
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /win32-x64: no prebuild/)
})

test('fails when only the win32 prebuild is present', () => {
  const result = check((root) => stageWin32(root))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no linux prebuilds/)
})

test('fails when the win32 addon imports cuBLASLt', () => {
  const result = check((root) => {
    stageLinux(root, 'linux-x64')
    stageWin32(root, ['kernel32.dll', 'cublasLt64_12.dll'])
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /addon imports cublaslt64/)
})
