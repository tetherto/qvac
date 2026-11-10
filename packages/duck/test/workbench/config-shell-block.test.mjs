import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bare = createRequire(import.meta.url)('bare-runtime')()
const fixture = new URL('./fixtures/config-shell-block.mjs', import.meta.url).pathname

test('a sandbox that fails to start refuses every run', (t) => {
  const { status, runs, events } = configure(t)

  assert.deepEqual(status.shell, {
    blocked: true,
    reason: 'sandbox-macos: sandbox-exec is missing'
  })
  const sandbox = status.plugins.find((p) => p.id === 'sandbox-macos')
  assert.equal(sandbox.state, 'failed')
  assert.equal(sandbox.shellBlocked, true)

  assert.deepEqual(runs, [])
  assert.equal(events.length, 4)
  for (const event of events) {
    assert.equal(event.type, 'error')
    assert.match(event.message, /sandbox did not start \(sandbox-macos: sandbox-exec is missing\)/)
  }
})

test('maxToolRounds goes on top-level runs that set none', (t) => {
  const [top, own, child] = configure(t, 'allow').runs

  assert.equal(top.maxToolRounds, 40)
  assert.equal(own.maxToolRounds, 3)
  assert.equal(child.maxToolRounds, undefined, 'a delegated run keeps what its parent gave it')
})

test('reasoningBudget and thinking shape every new run, and a resumed run keeps its own', (t) => {
  const [top, own, child, resumed] = configure(t, 'allow').runs

  for (const run of [top, own, child]) {
    assert.deepEqual(run.generationParams, { reasoning_budget: 512, reasoning_rounds: 'plan' })
  }

  assert.equal(resumed.generationParams.reasoning_budget, -1)
})

test('wording words every run, and a run that words a key itself keeps its own', (t) => {
  const [top, own, child] = configure(t, 'allow').runs
  const guidelines = { 'one-action-at-a-time': false }

  assert.deepEqual(top.wording, { toolRepeated: 'Once is enough.', guidelines })
  assert.deepEqual(child.wording, top.wording)
  assert.deepEqual(own.wording, { toolRepeated: 'Mine.', guidelines })
})

test('allowUnsandboxedShell runs without the sandbox', (t) => {
  const { status, runs } = configure(t, 'allow')

  assert.equal(status.shell.blocked, false)
  assert.equal(status.shell.unsandboxed, true)
  assert.equal(runs[0].agent.disabledToolsets, undefined)
  assert.equal(runs[0].policy.network.mode, 'hosts')
})

test('allowUnsandboxedShell gives coding an unconfined shell when its sandbox fails', (t) => {
  const { status, order, shell } = configure(t, 'allow')

  assert.equal(status.plugins.find((p) => p.id === 'host-shell').state, 'ready')
  assert.ok(order.indexOf('host-shell') < order.indexOf('coding'), 'before coding needs it')
  assert.deepEqual(shell.ran, { stdout: `out\n${status.dir}\n`, stderr: 'err\n', exitCode: 3 })
  assert.equal(shell.slow, 124, 'a line past its timeout is killed')
  assert.equal(shell.stopped, true)
})

test('without allowUnsandboxedShell no unconfined shell stands in', (t) => {
  const { status, shell } = configure(t)

  assert.equal(
    status.plugins.some((p) => p.id === 'host-shell'),
    false
  )
  assert.equal(shell, null)
})

function configure(t, allow = '') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-shell-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.chmodSync(bare, 0o755)

  const run = spawnSync(bare, [fixture, dir, allow], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)

  const out = JSON.parse(run.stdout)
  out.status.dir = dir
  return out
}
