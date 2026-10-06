'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..')
const PACKAGE_NAME = 'decoder-audio'
const PACKAGE_ROOT = 'packages/' + PACKAGE_NAME
const project = require('../../' + PACKAGE_ROOT + '/project.json')
const packageJson = require('../../' + PACKAGE_ROOT + '/package.json')
const repositoryJson = require('../../package.json')

function readRepositoryFile (filePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, filePath), 'utf8')
}

test('the release package satisfies the publishing identity gate', () => {
  assert.equal(project.name, packageJson.name)
  assert.equal(project.root, PACKAGE_ROOT)
  const ci = project.targets['on-merge'].options.ci
  assert.equal(ci.repoName, PACKAGE_NAME)
  assert.equal(ci.nameTransform, 'none')
  assert.equal(ci.testGateMode, 'pre-publish-integration')
  assert.equal(ci.slicePlatformPackages, undefined)
})

test('the matrix workspace includes only this historical release package', () => {
  assert.equal(repositoryJson.private, true)
  assert.equal(repositoryJson.packageManager, 'pnpm@11.17.0')
  assert.equal(repositoryJson.devDependencies.nx, '23.1.0')
  const workspace = readRepositoryFile('pnpm-workspace.yaml')
  assert.ok(workspace.includes('"' + PACKAGE_ROOT + '"'))
  const lockfile = readRepositoryFile('pnpm-lock.yaml')
  assert.ok(lockfile.includes('  ' + PACKAGE_ROOT + ':'))
  assert.doesNotThrow(() => JSON.parse(readRepositoryFile('nx.json')))
})

test('project targets reference scripts present in the historical release', () => {
  for (const target of Object.values(project.targets)) {
    const match = /^pnpm run (\S+)$/.exec(target.options.command)
    if (!match) continue
    assert.equal(typeof packageJson.scripts[match[1]], 'string', match[1])
    assert.equal(target.options.cwd, PACKAGE_ROOT)
  }
  assert.equal(Boolean(project.targets.build), Boolean(packageJson.addon))
  if (packageJson.addon) assert.ok(packageJson.files.includes('prebuilds'))
})
