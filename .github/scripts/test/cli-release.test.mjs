import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { archivePath, packsArchive, validateArchive, withArchiveTarget, withArchiveTargets } from '../lib/cli-release.mjs'

const script = fileURLToPath(new URL('../release-train.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
function fixture (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-cli-release-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('the CLI and duck pack their own archives; the rest pack with pnpm', () => {
  assert.equal(packsArchive(repoRoot, 'packages/cli'), true)
  assert.equal(packsArchive(repoRoot, 'packages/duck'), true)
  assert.equal(packsArchive(repoRoot, 'packages/sdk'), false)
})

test('archive identity and confinement are checked before publication', () => {
  assert.equal(archivePath('/tmp/build', { '@qvac/cli': 'qvac-cli-1.0.0.tgz' }, '@qvac/cli'), '/tmp/build/qvac-cli-1.0.0.tgz')
  assert.equal(archivePath('/tmp/build', { '@qvac/duck': 'qvac-duck-0.1.0.tgz' }, '@qvac/duck'), '/tmp/build/qvac-duck-0.1.0.tgz')
  for (const file of [undefined, '../outside.tgz', '/outside.tgz', 'manifest.json']) {
    assert.throws(() => archivePath('/tmp/build', { '@qvac/cli': file }, '@qvac/cli'), /validated train tarball/)
  }
  assert.throws(() => archivePath('/tmp/build', { '@qvac/cli': 'qvac-cli-1.0.0.tgz' }, '@qvac/duck'), /@qvac\/duck release requires/)
  const manifest = { name: '@qvac/cli', version: '1.0.0', gitHead: 'commit' }
  validateArchive(manifest, { name: '@qvac/cli', version: '1.0.0', head: 'commit' })
  for (const changed of [{ name: '@qvac/duck' }, { version: '2.0.0' }, { gitHead: 'other' }]) {
    assert.throws(() => validateArchive({ ...manifest, ...changed }, { name: '@qvac/cli', version: '1.0.0', head: 'commit' }), /does not match/)
  }
})

test('a package stays in the Nx graph and its temporary target is restored on failure', (t) => {
  const root = fixture(t)
  const original = JSON.stringify({ name: '@qvac/cli', targets: { build: { executor: 'original' } } })
  fs.writeFileSync(path.join(root, 'project.json'), original)
  assert.throws(() => withArchiveTarget(root, '.', () => {
    const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json')))
    assert.equal(project.targets.build.executor, 'original')
    assert.equal(project.targets['nx-release-publish'].cache, false)
    assert.deepEqual(project.targets['nx-release-publish'].dependsOn, ['^nx-release-publish'])
    assert.equal(project.targets['nx-release-publish'].options.commands[0].forwardAllArgs, false)
    throw new Error('simulated publish failure')
  }), /simulated/)
  assert.equal(fs.readFileSync(path.join(root, 'project.json'), 'utf8'), original)
})

test('every archive package gets the target for one publish, and none without', (t) => {
  const root = fixture(t)
  const originals = {}
  for (const dir of ['cli', 'duck']) {
    fs.mkdirSync(path.join(root, dir))
    originals[dir] = JSON.stringify({ name: `@qvac/${dir}`, targets: {} })
    fs.writeFileSync(path.join(root, dir, 'project.json'), originals[dir])
  }
  const seen = withArchiveTargets(root, ['cli', 'duck'], () =>
    ['cli', 'duck'].map((dir) => JSON.parse(fs.readFileSync(path.join(root, dir, 'project.json'))).targets['nx-release-publish'].options.commands[0].command))
  assert.deepEqual(seen, Array(2).fill('node .github/scripts/release-train.mjs publish-archive'))
  for (const dir of ['cli', 'duck']) {
    assert.equal(fs.readFileSync(path.join(root, dir, 'project.json'), 'utf8'), originals[dir])
  }
  assert.equal(withArchiveTargets(root, [], () => 'ran'), 'ran')
})

test('archive publishing uses the exact checked tarball of the project nx names, suppresses lifecycle and forwards dry-run/provenance', (t) => {
  const root = fixture(t)
  const packageDir = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(packageDir)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@qvac/duck', version: '1.0.0', gitHead: 'commit' }))
  const archive = path.join(root, 'duck.tgz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, 'package']).status, 0)
  const trace = path.join(root, 'npm-arguments.json')
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.TEST_NPM_TRACE, JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 })
  const archives = JSON.stringify({ '@qvac/duck': { archive, version: '1.0.0' } })
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_NPM_TRACE: trace, NX_TASK_TARGET_PROJECT: '@qvac/duck', QVAC_RELEASE_ARCHIVES: archives, QVAC_RELEASE_HEAD: 'commit', PNPM_CONFIG_PROVENANCE: 'true' }
  for (const dryRun of [true, false]) {
    const result = spawnSync(process.execPath, [script, 'publish-archive'], { env: { ...env, QVAC_RELEASE_DRY_RUN: String(dryRun) }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(trace)), ['publish', archive, '--ignore-scripts', '--tag=latest', '--access=public', dryRun ? '--dry-run' : '--provenance'])
  }
  fs.unlinkSync(trace)
  for (const wrong of [{ QVAC_RELEASE_HEAD: 'wrong' }, { NX_TASK_TARGET_PROJECT: '@qvac/cli' }]) {
    const result = spawnSync(process.execPath, [script, 'publish-archive'], { env: { ...env, ...wrong }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(fs.existsSync(trace), false, 'a mismatched archive never invokes npm')
  }
})
