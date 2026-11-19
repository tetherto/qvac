import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../../workflows/_build.yml', import.meta.url), 'utf8')

test('build job preserves a published dependency tree when pnpm detects lockfile drift', (t) => {
  const setting = workflow.match(/^      pnpm_config_verify_deps_before_run: "(false)"$/m)
  assert.ok(setting, 'the build job must pass the pnpm guard to nested commands')
  const root = mkdtempSync(join(tmpdir(), 'release-pnpm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'release-fixture', private: true })
  )
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: install\n')
  const run = (args, env = {}) =>
    spawnSync('pnpm', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env }
    })
  const setup = run([
    'install',
    '--lockfile-only',
    '--offline',
    '--ignore-scripts',
    '--store-dir',
    join(root, 'store')
  ])
  assert.equal(setup.status, 0, setup.stdout + setup.stderr)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'release-fixture',
      private: true,
      dependencies: { 'release-only-provider-fixture': '1.0.0' }
    })
  )
  const installed = join(root, 'node_modules', 'release-only-provider-fixture')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'index.js'), 'module.exports = "published-provider"')
  const result = run(['exec', 'node', '-p', 'require("release-only-provider-fixture")'], {
    pnpm_config_verify_deps_before_run: setting[1]
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout.trim(), 'published-provider')
})
