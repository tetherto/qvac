// Opt-in integration: npm run pear:build && npm run test:standalone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const binaryName = process.platform === 'win32' ? 'qvac.exe' : 'qvac'
const built = process.env.QVAC_STANDALONE_BINARY || path.join(root, 'out/make', binaryName)

function isolatedCommand(binary) {
  if (process.platform !== 'darwin') return [binary, []]

  // Both the destination monorepo and the original checkout must be unavailable.
  // Seatbelt restrictions also apply to the binary's Core and harness children.
  const denied = [path.resolve(root, '../..'), path.resolve(root, '../../../qvac-cli')]
  const profile = `(version 1)(allow default)${denied
    .map((dir) => `(deny file-read* (subpath ${JSON.stringify(dir)}))`)
    .join('')}`
  const probe = spawnSync(
    '/usr/bin/sandbox-exec',
    ['-p', profile, '/bin/cat', path.join(root, 'package.json')],
    { encoding: 'utf8' }
  )
  assert.notEqual(probe.status, 0, 'repository reads must be denied')
  assert.match(probe.stderr, /Operation not permitted/, 'sandbox must enforce the read denial')
  return ['/usr/bin/sandbox-exec', ['-p', profile, binary]]
}

function complete(binary, cwd, state) {
  const [command, prefix] = isolatedCommand(binary)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('QVAC_') && !key.startsWith('NODE_') && !key.startsWith('npm_')
    )
  )
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      [
        ...prefix,
        '--data-dir',
        state,
        '--fake-models',
        '--skip-setup',
        '--print',
        'Say hello to the standalone runtime.'
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    }, 120_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

test(
  'standalone completes with bundled host extension, plugins and skills outside the repository',
  {
    timeout: 150_000
  },
  async (t) => {
    assert.ok(fs.existsSync(built), 'Build the standalone first with npm run pear:build')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-standalone-test-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const binary = path.join(dir, binaryName)
    fs.copyFileSync(built, binary, fs.constants.COPYFILE_FICLONE)
    fs.chmodSync(binary, 0o755)
    const state = path.join(dir, 'state')
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, 'plugins.json'), JSON.stringify({ enabled: ['quickjs'] }))

    const result = await complete(binary, dir, state)
    assert.equal(result.code, 0, `signal=${result.signal}\n${result.stderr}\n${result.stdout}`)
    assert.match(result.stdout, /quack/, 'completion must come from the real Core/harness stream')
    const status = JSON.parse(fs.readFileSync(path.join(state, 'cli-host-status.json'), 'utf8'))
    assert.ok(status.writtenAt, 'CLI host extension must configure the harness')
    assert.equal(status.plugins.find((plugin) => plugin.id === 'quickjs')?.state, 'ready')
    assert.ok(
      fs.existsSync(path.join(state, 'sdk-home/skills/qvac-plugins/SKILL.md')),
      'standalone must install its shipped CLI skill'
    )
  }
)
