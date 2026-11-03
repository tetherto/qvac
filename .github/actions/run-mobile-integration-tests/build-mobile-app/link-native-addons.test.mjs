// Exercise the action's shell so the linker's targets match the app we build.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8')
const step = action.split('    - name: Link native addons\n')[1].split('\n    #')[0]
const script = step.split('      run: |\n')[1].split('\n').map((line) => line.slice(8)).join('\n')

function runLink(t, platform, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-link-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const calls = join(dir, 'calls.jsonl')
  const npx = join(bin, 'npx')
  writeFileSync(npx, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n')
if (args.includes('--version')) { process.exitCode = args.at(-1) === '--version' ? 1 : 0; console.log('v4.2.0'); return }
if (Number(process.env.LINK_EXIT)) process.exit(Number(process.env.LINK_EXIT))
fs.mkdirSync(args[args.indexOf('--out') + 1], { recursive: true })
`)
  chmodSync(npx, 0o755)
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLATFORM: platform, CALLS: calls, LINK_EXIT: String(exitCode) },
    encoding: 'utf8',
  })
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) }
}

test('Android links only the arm64 host built by Gradle', (t) => {
  const result = runLink(t, 'Android')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls, [
    ['--no-install', 'bare-link', '--version', 'backend/backend.cjs'],
    ['--no-install', 'bare-link', '--host', 'android-arm64', '--out', 'node_modules/react-native-bare-kit/android/src/main/addons', 'backend/backend.cjs'],
  ])
  assert.match(action, /-PreactNativeArchitectures=arm64-v8a/)
})

test('iOS keeps its device and simulator preset', (t) => {
  const result = runLink(t, 'iOS')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls[1], [
    '--no-install', 'bare-link', '--preset', 'ios', '--out', 'node_modules/react-native-bare-kit/ios/addons', 'backend/backend.cjs',
  ])
})

test('a missing required addon still fails the build', (t) => {
  const result = runLink(t, 'Android', 1)
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stdout, /Linked addons in/)
})
