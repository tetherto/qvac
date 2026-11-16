import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureDiagnostics } from '../capture-diffusion-ci-diagnostics.mjs'

test('failed suite log and both runtime snapshots survive in the same bundle', (t) => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-diagnostics-'))
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }))
  const modules = path.join(workdir, 'prebuilds/linux-x64/qvac__diffusion-cpp-linux-x64')
  fs.mkdirSync(modules, { recursive: true })
  fs.writeFileSync(path.join(modules, 'libqvac-diffusion-ggml-cuda.so'), 'fixture')
  const run = (file, args) => ({
    status: 0,
    stderr: '',
    stdout: file === 'python3' ? JSON.stringify({ gpu: 'fixture', module: args[1] }) : 'fixture\n'
  })
  const output = captureDiagnostics({ workdir, phase: 'before', run })
  const failure = 'not ok 4 - streamed KV-cache parity\n# asserts = 28/63 pass\n'
  fs.writeFileSync(path.join(workdir, 'test-output.log'), failure)
  captureDiagnostics({ workdir, phase: 'after', run })
  assert.equal(fs.readFileSync(path.join(output, 'integration-test-output.log'), 'utf8'), failure)
  for (const phase of ['before', 'after']) {
    const context = JSON.parse(fs.readFileSync(path.join(output, `${phase}-context.json`)))
    const runtime = JSON.parse(fs.readFileSync(path.join(output, `${phase}-runtime.json`)))
    assert.equal(context.modules.length, 1)
    assert.match(context.modules[0].sha256, /^[a-f0-9]{64}$/)
    assert(runtime.module.endsWith('libqvac-diffusion-ggml-cuda.so'))
  }
})

test('missing GPU modules and a failed collector still preserve the failing test log', (t) => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffusion-diagnostics-'))
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(workdir, 'test-output.log'), 'original test failure\n')
  const output = captureDiagnostics({
    workdir,
    phase: 'after',
    run: () => ({
      status: 1,
      stdout: '',
      stderr: 'collector unavailable'
    })
  })
  const runtime = JSON.parse(fs.readFileSync(path.join(output, 'after-runtime.json')))
  assert.equal(runtime.status, 1)
  assert.equal(runtime.stderr, 'collector unavailable')
  assert.equal(
    fs.readFileSync(path.join(output, 'integration-test-output.log'), 'utf8'),
    'original test failure\n'
  )
  assert.throws(() => captureDiagnostics({ workdir, phase: 'invalid' }))
})
