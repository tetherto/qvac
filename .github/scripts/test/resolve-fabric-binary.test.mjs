import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFabricCore } from '../lib/resolve-fabric-binary.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fabric-resolution-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function install(base, name) {
  const dir = join(base, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, exports: { './package': './package.json' } })
  )
  return dir
}

function binary(base, host) {
  const dir = install(base, `@qvac/fabric-${host}`)
  const prebuilds = join(dir, 'prebuilds', host, `qvac__fabric-${host}`)
  mkdirSync(prebuilds, { recursive: true })
  const path = join(prebuilds, 'libqvac-ggml-base-1.so')
  writeFileSync(path, '')
  return path
}

test('resolves the published shared core beside the consumer', (t) => {
  const root = fixture(t)
  install(root, '@qvac/fabric')
  const expected = binary(root, 'linux-arm64')
  assert.equal(resolveFabricCore(root, 'linux-arm64'), expected)
})

test('prefers the platform linked by workspace Fabric over an older consumer platform', (t) => {
  const root = fixture(t)
  const consumer = join(root, 'consumer')
  const fabric = install(join(root, 'workspace'), '@qvac/fabric')
  const expected = binary(fabric, 'linux-x64')
  binary(consumer, 'linux-x64')
  symlinkSync(fabric, join(consumer, 'node_modules/@qvac/fabric'), 'junction')
  assert.equal(resolveFabricCore(consumer, 'linux-x64'), expected)
})

test('falls back to the consumer platform when workspace Fabric has none', (t) => {
  const root = fixture(t)
  const consumer = join(root, 'consumer')
  const fabric = install(join(root, 'workspace'), '@qvac/fabric')
  const expected = binary(consumer, 'linux-x64')
  symlinkSync(fabric, join(consumer, 'node_modules/@qvac/fabric'), 'junction')
  assert.equal(resolveFabricCore(consumer, 'linux-x64'), expected)
})

test('fails closed for a missing provider binary and invalid target', (t) => {
  const root = fixture(t)
  install(root, '@qvac/fabric')
  const old = install(root, '@qvac/fabric-linux-x64')
  mkdirSync(join(old, 'prebuilds/linux-x64'), { recursive: true })
  writeFileSync(join(old, 'prebuilds/linux-x64/qvac__fabric-linux-x64.bare'), '')
  assert.throws(() => resolveFabricCore(root, 'linux-x64'), /ENOENT/)
  assert.throws(() => resolveFabricCore(root, '../linux-x64'), /requires linux/)
})
