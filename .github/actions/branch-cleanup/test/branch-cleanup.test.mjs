// Release train branches (release-train-<train>-<x.y.z>) carry a train's anchor
// version rather than one package's, so they keep their own retention window
// and the latest published anchor version protects its train branch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyBranch,
  eligibleReleaseBranches,
  latestPublishedByPackage,
  latestTrainBranchNames,
  processBranchCleanup
} from '../branch-cleanup.mjs'

const MONO = { singlePackage: false, keepMajors: 2, keepMinors: 3, keepPatches: 1 }

const CATALOG = {
  trains: {
    sdk: {
      anchorGroup: 'engine',
      groups: {
        engine: { projects: [{ slug: 'inference' }, { slug: 'sdk' }] },
        agentstack: { projects: [{ slug: 'cli' }] }
      }
    }
  }
}

test('a train branch gets its own retention key, apart from the package branches', () => {
  const train = classifyBranch('release-train-sdk-0.21.0', MONO)
  assert.equal(train.type, 'release')
  assert.equal(train.package, 'train:sdk')
  assert.equal(train.version.raw, '0.21.0')
  assert.equal(classifyBranch('release-sdk-0.21.0', MONO).package, 'sdk')

  const releases = ['release-sdk-0.21.0', 'release-sdk-0.21.1', 'release-train-sdk-0.21.0'].map((name) => {
    const info = classifyBranch(name, MONO)
    return { name, package: info.package, version: info.version }
  })
  assert.deepEqual([...eligibleReleaseBranches(releases, MONO)], ['release-sdk-0.21.0'])
})

test('the latest published anchor version names the train branch to keep', () => {
  const latest = latestPublishedByPackage(
    [{ name: 'sdk-v0.21.0' }, { name: 'inference-v0.21.0' }, { name: 'cli-v0.15.0' }, { name: 'sdk-v0.20.3' }],
    MONO
  )
  assert.deepEqual([...latestTrainBranchNames(CATALOG, latest)], ['release-train-sdk-0.21.0'])
  assert.deepEqual([...latestTrainBranchNames(null, latest)], [])
})

function fakeGithub ({ branches, tags }) {
  const rest = {
    repos: {
      listBranches: () => {},
      listTags: () => {},
      get: async () => ({ data: { has_issues: false } })
    },
    pulls: { list: () => {} }
  }
  const pages = new Map([
    [rest.repos.listBranches, branches.map((name) => ({ name, commit: { sha: name }, protected: true }))],
    [rest.repos.listTags, tags.map((name) => ({ name }))],
    [rest.pulls.list, []]
  ])
  return { rest, paginate: async (fn) => pages.get(fn) }
}

function fakeCore () {
  const summary = { addHeading: () => summary, addRaw: () => summary, write: async () => {} }
  return { info: () => {}, warning: () => {}, summary }
}

async function candidates (env) {
  const github = fakeGithub({
    // 0.21.1 is cut but not published yet; 0.21.0 is what npm serves.
    branches: ['main', 'release-train-sdk-0.21.0', 'release-train-sdk-0.21.1'],
    tags: ['sdk-v0.21.0', 'inference-v0.21.0']
  })
  const context = { repo: { owner: 'tetherto', repo: 'qvac' }, payload: {} }
  const result = await processBranchCleanup({ github, context, core: fakeCore(), env })
  return result.candidates
}

test('keeps the train branch behind the latest published version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'branch-cleanup-'))
  try {
    const file = join(dir, 'release-trains.json')
    writeFileSync(file, JSON.stringify(CATALOG))
    assert.deepEqual(await candidates({ RELEASE_TRAINS_FILE: file }), [])
    // Without a catalog the newer, unpublished patch wins the window.
    assert.deepEqual(await candidates({ RELEASE_TRAINS_FILE: join(dir, 'missing.json') }), ['release-train-sdk-0.21.0'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
