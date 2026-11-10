import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cliArchivePath, validateCliArchive, withCliArchiveTarget } from '../lib/cli-release.mjs'

const script = fileURLToPath(new URL('../release-train.mjs', import.meta.url))
function fixture (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-cli-release-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('CLI archive identity and confinement are checked before publication', () => {
  assert.equal(cliArchivePath('/tmp/build', { '@qvac/cli': 'qvac-cli-1.0.0.tgz' }), '/tmp/build/qvac-cli-1.0.0.tgz')
  for (const file of [undefined, '../outside.tgz', '/outside.tgz', 'manifest.json']) {
    assert.throws(() => cliArchivePath('/tmp/build', { '@qvac/cli': file }), /validated train tarball/)
  }
  const manifest = { name: '@qvac/cli', version: '1.0.0', gitHead: 'commit' }
  validateCliArchive(manifest, { version: '1.0.0', head: 'commit' })
  for (const changed of [{ name: '@qvac/sdk' }, { version: '2.0.0' }, { gitHead: 'other' }]) {
    assert.throws(() => validateCliArchive({ ...manifest, ...changed }, { version: '1.0.0', head: 'commit' }), /does not match/)
  }
})

test('CLI remains in the Nx graph and temporary target is restored on failure', (t) => {
  const root = fixture(t)
  const original = JSON.stringify({ name: '@qvac/cli', targets: { build: { executor: 'original' } } })
  fs.writeFileSync(path.join(root, 'project.json'), original)
  assert.throws(() => withCliArchiveTarget(root, '.', () => {
    const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json')))
    assert.equal(project.targets.build.executor, 'original')
    assert.equal(project.targets['nx-release-publish'].cache, false)
    assert.deepEqual(project.targets['nx-release-publish'].dependsOn, ['^nx-release-publish'])
    assert.equal(project.targets['nx-release-publish'].options.commands[0].forwardAllArgs, false)
    throw new Error('simulated publish failure')
  }), /simulated/)
  assert.equal(fs.readFileSync(path.join(root, 'project.json'), 'utf8'), original)
})

test('archive publishing uses exact checked tarball, suppresses lifecycle and forwards dry-run/provenance', (t) => {
  const root = fixture(t)
  const packageDir = path.join(root, 'package')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(packageDir)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@qvac/cli', version: '1.0.0', gitHead: 'commit' }))
  const archive = path.join(root, 'cli.tgz')
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, 'package']).status, 0)
  const trace = path.join(root, 'npm-arguments.json')
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.TEST_NPM_TRACE, JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 })
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_NPM_TRACE: trace, QVAC_RELEASE_CLI_ARCHIVE: archive, QVAC_RELEASE_CLI_VERSION: '1.0.0', QVAC_RELEASE_CLI_HEAD: 'commit', PNPM_CONFIG_PROVENANCE: 'true' }
  for (const dryRun of [true, false]) {
    const result = spawnSync(process.execPath, [script, 'publish-cli-archive'], { env: { ...env, QVAC_RELEASE_CLI_DRY_RUN: String(dryRun) }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(trace)), ['publish', archive, '--ignore-scripts', '--tag=latest', '--access=public', dryRun ? '--dry-run' : '--provenance'])
  }
  fs.unlinkSync(trace)
  const result = spawnSync(process.execPath, [script, 'publish-cli-archive'], { env: { ...env, QVAC_RELEASE_CLI_HEAD: 'wrong' }, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.equal(fs.existsSync(trace), false, 'mismatched archive never invokes npm')
})
