// A clang binary run directly (nvcc's -ccbin) reads etc/clang/*.cfg, which points at its resources and lld packages
// as siblings. pnpm-workspace.yaml's packageExtensions makes them siblings under pnpm; this keeps every clang package
// covered, each clang version with siblings of that version, so a bump cannot silently drop CUDA's headers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')

// packageExtensions' entries: { 'llvm-runtime-clang-linux-x64@23.1.5': { 'llvm-runtime-resources-linux': '23.1.5', ... } }
function extensions() {
  const block = workspace.split(/^packageExtensions:\n/m)[1]?.split(/^\S/m)[0] ?? ''
  const out = {}
  let current = null
  for (const line of block.split('\n')) {
    const pkg = line.match(/^ {2}(llvm-runtime-clang-[\w-]+@[\w.-]+):$/)
    if (pkg) out[(current = pkg[1])] = {}
    const dep = line.match(/^ {6}([\w-]+): "([^"]+)"$/)
    if (dep && current) out[current][dep[1]] = dep[2]
  }
  return out
}

test('every clang package version depends on its resources and lld of the same version', () => {
  const clang = [...lock.matchAll(/^ {2}(llvm-runtime-clang-(\w+)-(\w+))@([\w.-]+?):$/gm)]
  assert.ok(clang.length >= 6, `expected the six clang platform packages, found ${clang.length}`)
  const ext = extensions()
  for (const [, name, os, arch, version] of clang) {
    assert.deepEqual(
      ext[`${name}@${version}`],
      { [`llvm-runtime-resources-${os}`]: version, [`llvm-runtime-lld-${os}-${arch}`]: version },
      `${name}@${version} in pnpm-workspace.yaml packageExtensions`
    )
  }
})
