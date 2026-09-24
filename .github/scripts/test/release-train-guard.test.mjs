// The release train branch carries one version for a whole train, so the guard
// has to decide which mismatches are releases in progress and which are
// mistakes. These lock that line, against a fixture catalog rather than the
// real one — adding a package to a train must not need a test edit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkReleaseTrain } from '../lib/release-train-guard.mjs'
import { parseBranch } from '../lib/release-trains.mjs'

const CATALOG = {
  trains: {
    sdk: {
      anchorGroup: 'engine',
      groups: {
        engine: {
          projectsRelationship: 'fixed',
          projects: [
            { name: '@qvac/inference', slug: 'inference', dir: 'packages/inference' },
            { name: '@qvac/sdk', slug: 'sdk', dir: 'packages/sdk' },
          ],
        },
        agentstack: {
          projectsRelationship: 'independent',
          projects: [{ name: '@qvac/cli', slug: 'cli', dir: 'packages/cli' }],
        },
      },
    },
  },
  nx: { version: {}, releaseTagPattern: '{projectName}-v{version}' },
}

const AT_0_21_0 = {
  'packages/inference/package.json': '0.21.0',
  'packages/sdk/package.json': '0.21.0',
  'packages/cli/package.json': '0.15.0',
}

function io(versions, changed = []) {
  return {
    readManifest: (path) => {
      const version = versions[path]
      if (!version) throw new Error(`no fixture for ${path}`)
      return JSON.stringify({ version })
    },
    changedFiles: () => changed,
  }
}

const INITIAL_PUSH = ''

function check(ref, baseSha, ioImpl) {
  return checkReleaseTrain(ref, baseSha, ioImpl, CATALOG)
}

test('parses the train name and version out of the branch', () => {
  assert.deepEqual(parseBranch('release-train-sdk-0.21.0'), { train: 'sdk', version: '0.21.0' })
  assert.deepEqual(parseBranch('release-train-docs-1.2.0'), { train: 'docs', version: '1.2.0' })
  assert.equal(parseBranch('release-train-sdk-0.21.0-rc1'), null)
  assert.equal(parseBranch('release-sdk-0.21.0'), null)
  assert.equal(parseBranch('release-train-0.21.0'), null)
})

test('accepts a train at the branch version', () => {
  assert.deepEqual(check('release-train-sdk-0.21.0', INITIAL_PUSH, io(AT_0_21_0)), [])
})

test('rejects a branch name that is not release-train-<train>-x.y.z', () => {
  const errors = check('release-train-sdk', INITIAL_PUSH, io(AT_0_21_0))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Invalid release train branch name/)
})

test('rejects a train the catalog does not declare', () => {
  const errors = check('release-train-nosuch-0.21.0', INITIAL_PUSH, io(AT_0_21_0))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Unknown release train 'nosuch'/)
})

test('rejects an anchor package that is not at the branch version', () => {
  const versions = { ...AT_0_21_0, 'packages/sdk/package.json': '0.21.1' }
  const errors = check('release-train-sdk-0.21.0', INITIAL_PUSH, io(versions))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /branch says 0\.21\.0, sdk package\.json says 0\.21\.1/)
})

test('rejects an anchor group split across a minor', () => {
  const split = {
    ...AT_0_21_0,
    'packages/inference/package.json': '0.22.0',
    'packages/sdk/package.json': '0.21.0',
  }
  const errors = check('release-train-sdk-0.22.0', INITIAL_PUSH, io(split))
  assert.equal(errors.length, 2)
  assert.match(errors[1], /must share a major and minor/)
})

test('does not ask a non-anchor group to match the branch version', () => {
  // cli 0.15.0 on a 0.21.0 branch is the normal case, not a mismatch.
  assert.deepEqual(check('release-train-sdk-0.21.0', INITIAL_PUSH, io(AT_0_21_0)), [])
})

test('requires a changelog from every package whose manifest moved', () => {
  const changed = [
    'packages/inference/package.json',
    'packages/inference/CHANGELOG.md',
    'packages/cli/package.json',
  ]
  const errors = check('release-train-sdk-0.21.0', 'abc123', io(AT_0_21_0, changed))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /cli changed version but not its changelog/)
})

test('asks no changelog of a package the release did not touch', () => {
  const changed = ['packages/inference/package.json', 'packages/inference/CHANGELOG.md']
  assert.deepEqual(check('release-train-sdk-0.21.0', 'abc123', io(AT_0_21_0, changed)), [])
})

test('skips the changelog check on the initial branch push', () => {
  const zero = '0000000000000000000000000000000000000000'
  assert.deepEqual(check('release-train-sdk-0.21.0', zero, io(AT_0_21_0, [])), [])
})
