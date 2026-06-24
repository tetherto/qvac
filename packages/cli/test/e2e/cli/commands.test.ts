import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { runCli } from '../helpers/cli.js'
import { tempDir } from '../helpers/tmp.js'

// lunte-disable-next-line require-await
async function tmpProject(t: TestContext): Promise<string> {
  return tempDir(t, 'qvac-cli-cmd-')
}

describe('cli: version & help', () => {
  it('--version prints semver', async () => {
    const r = await runCli(['--version'])
    assert.equal(r.code, 0)
    assert.match(r.output, /^\d+\.\d+\.\d+/)
  })

  it('--help lists commands', async () => {
    const r = await runCli(['--help'])
    assert.equal(r.code, 0)
    for (const cmd of ['bundle', 'verify', 'serve']) {
      assert.ok(r.output.includes(cmd), `missing ${cmd}`)
    }
  })

  it('serve openai --help shows options', async () => {
    const r = await runCli(['serve', 'openai', '--help'])
    assert.equal(r.code, 0)
    for (const s of ['--port', '--api-key', '--cors', 'OpenAI-compatible']) {
      assert.ok(r.output.includes(s), `missing ${s}`)
    }
  })

  it('bundle sdk --help shows options', async () => {
    const r = await runCli(['bundle', 'sdk', '--help'])
    assert.equal(r.code, 0)
    assert.ok(r.output.includes('--config') && r.output.includes('--sdk-path'))
  })
})

describe('cli: verify deps', () => {
  it('--help shows options', async () => {
    const r = await runCli(['verify', 'deps', '--help'])
    assert.equal(r.code, 0)
    for (const s of ['--base', '--head', '--lockfile']) {
      assert.ok(r.output.includes(s), `missing ${s}`)
    }
  })

  it('requires base and head', async () => {
    const r = await runCli(['verify', 'deps', '--base', 'HEAD'])
    assert.equal(r.code, 2)
    assert.ok(r.output.includes('--head'))
  })

  it('rejects unsupported lockfiles', async () => {
    const r = await runCli([
      'verify',
      'deps',
      '--base',
      'HEAD',
      '--head',
      'HEAD',
      '--lockfile',
      'bun.lock'
    ])
    assert.equal(r.code, 2)
    assert.ok(r.output.includes('Unsupported lockfile') && r.output.includes('package-lock.json'))
  })
})

describe('cli: verify bundle', () => {
  it('--help shows options', async () => {
    const r = await runCli(['verify', 'bundle', '--help'])
    assert.equal(r.code, 0)
    for (const s of ['--addons-source', '--host', '--bare-runtime-version', '--config']) {
      assert.ok(r.output.includes(s), `missing ${s}`)
    }
  })

  it('requires --addons-source', async () => {
    const r = await runCli(['verify', 'bundle', '--host', 'android-arm64'])
    assert.equal(r.code, 1)
    assert.ok(r.output.includes('--addons-source'))
  })

  it('rejects missing --addons-source path', async () => {
    const r = await runCli([
      'verify',
      'bundle',
      '--addons-source',
      '/nonexistent/path',
      '--host',
      'android-arm64'
    ])
    assert.equal(r.code, 1)
    assert.ok(r.output.includes('not a readable file or directory'))
  })

  it('rejects empty --host list', async (t) => {
    const dir = await tmpProject(t)
    await mkdir(join(dir, 'node_modules'))
    const r = await runCli(['verify', 'bundle', '--addons-source', join(dir, 'node_modules')])
    assert.equal(r.code, 1)
    assert.ok(r.output.includes('host is required'))
  })

  it('passes on empty node_modules', async (t) => {
    const dir = await tmpProject(t)
    await mkdir(join(dir, 'node_modules'))
    const r = await runCli([
      'verify',
      'bundle',
      '--addons-source',
      join(dir, 'node_modules'),
      '--host',
      'darwin-arm64'
    ])
    assert.equal(r.code, 0)
    assert.ok(r.output.includes('verification passed'))
  })

  it('rejects malformed --bare-runtime-version', async (t) => {
    const dir = await tmpProject(t)
    await mkdir(join(dir, 'node_modules'))
    const r = await runCli([
      'verify',
      'bundle',
      '--addons-source',
      join(dir, 'node_modules'),
      '--host',
      'darwin-arm64',
      '--bare-runtime-version',
      'not-a-version'
    ])
    assert.equal(r.code, 1)
    assert.ok(
      r.output.includes('Invalid Bare runtime version') && r.output.includes('not-a-version')
    )
  })

  it('rejects malformed bareRuntimeVersion in qvac.config.json', async (t) => {
    const dir = await tmpProject(t)
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'qvac.config.json'), '{"bareRuntimeVersion": "garbage"}')
    const r = await runCli([
      'verify',
      'bundle',
      '--addons-source',
      join(dir, 'node_modules'),
      '--host',
      'darwin-arm64',
      '--project-root',
      dir
    ])
    assert.equal(r.code, 1)
    assert.ok(r.output.includes('Invalid Bare runtime version') && r.output.includes('garbage'))
  })
})

describe('cli: doctor', () => {
  it('--help shows options', async () => {
    const r = await runCli(['doctor', '--help'])
    assert.equal(r.code, 0)
    assert.ok(r.output.includes('--json') && r.output.includes('QVAC SDK system requirements'))
  })

  it('--json emits valid JSON with ok boolean', async () => {
    const r = await runCli(['doctor', '--json'])
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}`)
    const doc = JSON.parse(r.stdout) as { ok: unknown; sections: unknown[] }
    assert.equal(typeof doc.ok, 'boolean')
    assert.ok(Array.isArray(doc.sections) && doc.sections.length >= 1)
  })
})

describe('cli: config errors', () => {
  it('missing config file exits 1', async () => {
    const r = await runCli(['serve', 'openai', '-c', 'nonexistent.json'])
    assert.equal(r.code, 1)
    assert.ok(r.output.includes('Config file not found'))
  })

  it('invalid config file exits 1', async (t) => {
    const dir = await tmpProject(t)
    await writeFile(join(dir, 'qvac.config.json'), 'not json')
    const r = await runCli(['serve', 'openai'], { cwd: dir })
    assert.equal(r.code, 1)
  })
})
