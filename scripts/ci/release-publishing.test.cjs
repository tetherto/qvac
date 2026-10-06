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

const { spawnSync } = require('node:child_process')
const BASH_COMMAND = process.platform === 'win32' ? 'bash.exe' : 'bash'
const DETECTION_PATTERN = /manifest_ref=\$CONFIG_REF[\s\S]*?has_check=\$\([\s\S]*?\|\| echo false\)/
const WRAPPER_MANIFEST = JSON.stringify({ scripts: { 'check:generated': 'tsc' } })
const HANDWRITTEN_MANIFEST = JSON.stringify({ scripts: {} })
const MOCK_GIT = `git() {
  case "$2" in
    trusted:*) printf '%s' "$TRUSTED_MANIFEST" ;;
    release:*) printf '%s' "$RELEASE_MANIFEST" ;;
    *) return 1 ;;
  esac
}`

function detectGeneratedWrappers (branchName, trustedManifest, releaseManifest) {
  const workflow = readRepositoryFile('.github/workflows/on-merge-nx.yml')
  const detection = workflow.match(DETECTION_PATTERN)
  assert.ok(detection, 'generated wrapper detection is present')
  const result = spawnSync(BASH_COMMAND, ['-c',
    'set -euo pipefail\n' + MOCK_GIT + '\n' + detection[0] + '\nprintf "%s" "$has_check"'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REF_NAME: branchName,
      CONFIG_REF: 'trusted',
      GITHUB_SHA: 'release',
      pkg: PACKAGE_NAME,
      TRUSTED_MANIFEST: trustedManifest,
      RELEASE_MANIFEST: releaseManifest
    }
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout
}

test('handwritten releases do not inherit the generated wrapper gate from main', () => {
  assert.equal(detectGeneratedWrappers('release-' + PACKAGE_NAME + '-0.5.1',
    WRAPPER_MANIFEST, HANDWRITTEN_MANIFEST), 'false')
})

test('generated releases verify wrappers even when main has no generated wrapper script', () => {
  assert.equal(detectGeneratedWrappers('release-' + PACKAGE_NAME + '-0.13.2',
    HANDWRITTEN_MANIFEST, WRAPPER_MANIFEST), 'true')
})

test('development branches retain the trusted generated wrapper gate', () => {
  assert.equal(detectGeneratedWrappers('feature-' + PACKAGE_NAME,
    WRAPPER_MANIFEST, HANDWRITTEN_MANIFEST), 'true')
  assert.equal(detectGeneratedWrappers('tmp-' + PACKAGE_NAME,
    HANDWRITTEN_MANIFEST, WRAPPER_MANIFEST), 'false')
})
