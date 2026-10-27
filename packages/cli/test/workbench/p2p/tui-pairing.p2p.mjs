// The TUI's onboarding pairs with a `qvac serve` device on the test DHT, named as the user left it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { network } from './harness.mjs'
import { terminal } from '../helpers/pty.mjs'

const CTRL_U = '\x15'

// what core-host names a machine: the Computer Name on macOS, the hostname elsewhere
function machineName() {
  const mac = process.platform === 'darwin' && spawnSync('scutil', ['--get', 'ComputerName'])
  return (mac?.status === 0 && mac.stdout.toString().trim()) || os.hostname()
}

async function until(check, what, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(`timed out waiting for ${what}`)
}

function tui(t, bootstrap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-p2p-tui-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const args = ['--data-dir', dir, '--bootstrap', bootstrap, '--fake-models', '--no-default-models']

  return terminal(t, args, { rows: 40, cols: 140 })
}

test('TUI onboarding pairs with a serve device, offering the machine name and taking an edit', async (t) => {
  const { device, bootstrap } = await network(t)
  const a = device('a')
  const link = (await a.start([])).invites.device
  const term = tui(t, bootstrap)

  await term.waitFor(/Join my other device/, 180000)
  term.keys('\r')
  await term.waitFor(/One link brings it all together/)
  term.keys(link + '\r')
  await term.waitFor(/Pair this device/, 180000)
  term.keys('\r')

  await term.waitFor(/03 \/ 04\s+JOIN YOUR DEVICE/)
  await term.waitFor(/Give this device a name/)
  assert.ok(term.screen.text().includes(`❯ ${machineName()}`), term.screen.text())
  term.keys(CTRL_U + 'tui-box\r')

  // onboarding ends by itself once the pairing lands, with no key to press
  await term.waitFor(/Ask QV\.AC anything/, 180000)
  const names = () => (a.status()?.devices ?? []).map((d) => d.name)
  await until(() => names().includes('tui-box'), `a to list tui-box, it lists ${names()}`)
})
