import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { runCli } from '../helpers/cli.js'

// New coverage: `verify deps` real diff. The bats suite only hit validation
// paths; this drives the actual lockfile-at-ref read → native classification →
// diff → exit-code pipeline (native = a package.json with `addon: true`).
function git (cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}
function headSha (cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim()
}
async function makeRepo (t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-verify-deps-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.invalid'])
  git(dir, ['config', 'user.name', 'e2e'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}
function lock (packages: Record<string, { version?: string }>): string {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } })
}

describe('cli: verify deps (real diff)', () => {
  it('reports no native changes (exit 0) when no native package changed', async (t) => {
    const dir = await makeRepo(t)
    await writeFile(join(dir, 'package-lock.json'), lock({}))
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base'])
    const base = headSha(dir)
    await writeFile(join(dir, 'readme.md'), 'x') // unrelated change
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'head'])
    const head = headSha(dir)

    const r = await runCli(['verify', 'deps', '--base', base, '--head', head, '--lockfile', 'package-lock.json'], { cwd: dir })
    assert.equal(r.code, 0)
    assert.match(r.output, /No native addon changes/)
  })

  it('detects an added native package (exit 1) and names it', async (t) => {
    const dir = await makeRepo(t)
    // The classifier reads node_modules/<pkg>/package.json from disk; addon:true => native.
    await mkdir(join(dir, 'node_modules', 'native-foo'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'native-foo', 'package.json'), JSON.stringify({ name: 'native-foo', version: '1.0.0', addon: true }))

    await writeFile(join(dir, 'package-lock.json'), lock({}))
    git(dir, ['add', 'package-lock.json']); git(dir, ['commit', '-q', '-m', 'base'])
    const base = headSha(dir)

    await writeFile(join(dir, 'package-lock.json'), lock({ 'node_modules/native-foo': { version: '1.0.0' } }))
    git(dir, ['add', 'package-lock.json']); git(dir, ['commit', '-q', '-m', 'head'])
    const head = headSha(dir)

    const r = await runCli(['verify', 'deps', '--base', base, '--head', head, '--lockfile', 'package-lock.json'], { cwd: dir })
    assert.equal(r.code, 1)
    assert.match(r.output, /Native addon changes/)
    assert.match(r.output, /native-foo@1\.0\.0/)
  })
})
