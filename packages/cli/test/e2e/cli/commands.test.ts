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

async function installFakeSdk(projectRoot: string, source: string): Promise<void> {
  const sdkDir = join(projectRoot, 'node_modules', '@qvac', 'sdk')
  await mkdir(sdkDir, { recursive: true })
  await writeFile(
    join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': './index.js', './package': './package.json' }
    })
  )
  await writeFile(join(sdkDir, 'index.js'), source)
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

  it('serve --help shows options and one flag per mountable surface', async () => {
    const r = await runCli(['serve', '--help'])
    assert.equal(r.code, 0)
    for (const s of ['--port', '--api-key', '--cors', '--openai', '--no-default']) {
      assert.ok(r.output.includes(s), `missing ${s}`)
    }
  })

  it('serve openai --help shows options and marks the alias deprecated', async () => {
    const r = await runCli(['serve', 'openai', '--help'])
    assert.equal(r.code, 0)
    for (const s of ['--port', '--api-key', '--cors', 'OpenAI-compatible', 'Deprecated']) {
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
    assert.ok(
      r.output.includes('--deep') &&
        r.output.includes('--json') &&
        r.output.includes('QVAC SDK system requirements')
    )
  })

  it('--json emits valid JSON with ok boolean', async () => {
    const r = await runCli(['doctor', '--json'])
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}`)
    const doc = JSON.parse(r.stdout) as { ok: unknown; sections: unknown[] }
    assert.equal(typeof doc.ok, 'boolean')
    assert.ok(Array.isArray(doc.sections) && doc.sections.length >= 1)
  })

  it('--deep fails when the project SDK is missing', async (t) => {
    const dir = await tmpProject(t)
    const r = await runCli(['doctor', '--deep', '--json'], { cwd: dir })
    assert.equal(r.code, 1)
    const doc = JSON.parse(r.stdout) as {
      ok: boolean
      sections: Array<{ id: string; checks: Array<{ status: string }> }>
    }
    assert.equal(doc.ok, false)
    assert.equal(doc.sections.find((section) => section.id === 'deep')?.checks[0]?.status, 'fail')
  })

  it('--deep accepts a structured heartbeat result without corrupting JSON', async (t) => {
    const dir = await tmpProject(t)
    await installFakeSdk(
      dir,
      `
        export async function heartbeat() { console.log('fixture worker log') }
        export async function close() {}
      `
    )
    const r = await runCli(['doctor', '--deep', '--json'], { cwd: dir })
    assert.equal(r.code, 0)
    const doc = JSON.parse(r.stdout) as {
      ok: boolean
      sections: Array<{ id: string; checks: Array<{ status: string }> }>
    }
    assert.equal(doc.ok, true)
    assert.equal(doc.sections.find((section) => section.id === 'deep')?.checks[0]?.status, 'pass')
  })

  it('--deep --quiet returns failure without output', async (t) => {
    const dir = await tmpProject(t)
    await installFakeSdk(
      dir,
      `
        export async function heartbeat() { throw new Error('fixture heartbeat failure') }
        export async function close() {}
      `
    )
    const r = await runCli(['doctor', '--deep', '--quiet'], { cwd: dir })
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
  })

  it('--deep --verbose includes bounded failure diagnostics', async (t) => {
    const dir = await tmpProject(t)
    await installFakeSdk(
      dir,
      `
        export async function heartbeat() { throw new Error('fixture heartbeat failure') }
        export async function close() {}
      `
    )
    const r = await runCli(['doctor', '--deep', '--verbose'], { cwd: dir })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /fixture heartbeat failure/)
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
