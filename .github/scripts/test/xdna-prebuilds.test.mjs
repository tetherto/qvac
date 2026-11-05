import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(root, '.github/workflows/reusable-prebuilds.yml'), 'utf8')
const step = workflow.split('        name: Verify Linux x64 XDNA module\n')[1].split('        run: |\n')[1].split('\n      - ')[0]
const script = step.split('\n').map(line => line.slice(10)).join('\n')

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
