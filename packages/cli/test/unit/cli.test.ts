import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSdkToolsBin } from '../../src/cli.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = join(PACKAGE_ROOT, 'src/index.ts')
const WITH_FIXTURE_BIN = join(PACKAGE_ROOT, 'test/fixtures/run-with-fixture-bin.ts')
const FIXTURE_BIN = join(PACKAGE_ROOT, 'test/fixtures/sdk-tools-bin.mjs')

interface Result {
  stdout: string
  stderr: string
  code: number | null
}

async function qvac(
  script: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<Result> {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += String(d)
  })
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })
  const [code] = (await once(child, 'close')) as [number | null]
  return { stdout, stderr, code }
}

describe('qvac', () => {
  it('runs qvac sdk with the SDK tools binary and its arguments', async () => {
    const r = await qvac(WITH_FIXTURE_BIN, ['sdk', 'doctor', '--json'])
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')
    assert.deepEqual(JSON.parse(r.stdout), { bin: FIXTURE_BIN, args: ['doctor', '--json'] })
  })

  it('returns the exit code of the SDK tools', async () => {
    const r = await qvac(WITH_FIXTURE_BIN, ['sdk', 'verify'], { FIXTURE_EXIT_CODE: '3' })
    assert.equal(r.code, 3)
  })

  it('warns on stderr for an earlier top-level command and keeps stdout clean', async () => {
    const r = await qvac(WITH_FIXTURE_BIN, ['bundle', 'sdk', '--host', 'linux-x64'])
    assert.equal(r.code, 0)
    assert.equal(
      r.stderr,
      "warning: 'qvac bundle sdk' is deprecated. Use 'qvac sdk bundle' instead.\n"
    )
    assert.deepEqual(JSON.parse(r.stdout).args, ['bundle', '--host', 'linux-x64'])
  })

  it('prints its own version', async () => {
    const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const r = await qvac(ENTRY, ['--version'])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, `${version}\n`)
  })

  it('prints help to stdout on --help and to stderr with no command', async () => {
    const help = await qvac(ENTRY, ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^Usage: qvac <command>/)
    assert.match(help.stdout, /sdk <command>/)

    const none = await qvac(ENTRY, [])
    assert.equal(none.code, 1)
    assert.equal(none.stdout, '')
    assert.match(none.stderr, /^Usage: qvac <command>/)
  })

  it('fails on an unknown command', async () => {
    const r = await qvac(ENTRY, ['chat'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /^error: unknown command 'chat'/)
  })

  it('resolves the qvac-sdk binary of the installed @qvac/sdk-tools', () => {
    const manifestPath = createRequire(import.meta.url).resolve('@qvac/sdk-tools/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.name, '@qvac/sdk-tools')
    assert.equal(resolveSdkToolsBin(), resolve(dirname(manifestPath), manifest.bin['qvac-sdk']))
  })
})
