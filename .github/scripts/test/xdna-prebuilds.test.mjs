import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
// fabric's linux-x64 build runs this check after bare-make install.
const script = readFileSync(join(root, 'packages/fabric/ci/verify-xdna-module.sh'), 'utf8')

function checkPackage(t, includeInstructions) {
  const cwd = mkdtempSync(join(tmpdir(), 'qvac-xdna-package-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const dir = join(cwd, 'prebuilds/linux-x64/qvac__fabric-linux-x64')
  const bin = join(cwd, 'bin')
  mkdirSync(dir, { recursive: true })
  mkdirSync(bin)
  // Isolate packaging from ABI validation; these tools supply a valid XRT ABI.
  writeFileSync(join(bin, 'readelf'), '#!/bin/sh\nprintf \'  (NEEDED) Shared library: [libstdc++.so.6]\\n  (NEEDED) Shared library: [libxrt_coreutil.so.2]\\n\'\n', { mode: 0o755 })
  writeFileSync(join(bin, 'nm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  for (const name of ['libqvac-ggml-xdna.so', 'fused_layer_test.xclbin', 'gemv_n32_r4_c8_test.xclbin', 'conv_prefill_test.xclbin']) {
    writeFileSync(join(dir, name), '')
  }
  if (includeInstructions) writeFileSync(join(dir, 'conv_prefill_test.insts.bin'), '')
  return spawnSync('bash', ['--noprofile', '--norc', '-c', script], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH },
  })
}

test('XDNA packaging rejects missing instructions even when kernels exist', t => {
  const result = checkPackage(t, false)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /::error::no \*\.insts\.bin next to/)
})

test('XDNA packaging accepts kernels with their instruction file', t => {
  const result = checkPackage(t, true)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
