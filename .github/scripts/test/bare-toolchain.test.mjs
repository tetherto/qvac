import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ISSUE_LABEL,
  ISSUE_TITLE,
  WATCHED,
  compareVersions,
  driftKey,
  findDrift,
  findOnPath,
  issueBody,
  keyFromIssueBody,
  lockedVersions,
  pathMismatches,
  reportedVersion,
  syncDriftIssue,
} from '../lib/bare-toolchain.mjs'

const lockfile = JSON.parse(
  readFileSync(new URL('../../bare-toolchain/package-lock.json', import.meta.url), 'utf8'),
)
const manifest = JSON.parse(
  readFileSync(new URL('../../bare-toolchain/package.json', import.meta.url), 'utf8'),
)

test('the lockfile pins every watched package', () => {
  const locked = lockedVersions(lockfile)
  assert.deepEqual(Object.keys(locked), WATCHED)
})

test('bare-make is pinned to one exact version, and the lockfile agrees', () => {
  const pin = manifest.dependencies['bare-make']
  assert.match(pin, /^\d+\.\d+\.\d+$/, 'a range would let a fresh install move without a lockfile change')
  assert.equal(lockfile.packages['']?.dependencies?.['bare-make'], pin)
  assert.equal(lockedVersions(lockfile)['bare-make'], pin)
})

test('no locked package runs an install script', () => {
  const scripted = Object.entries(lockfile.packages)
    .filter(([, entry]) => entry.hasInstallScript)
    .map(([path]) => path)
  assert.deepEqual(scripted, [])
})

test('a lockfile without a watched package is rejected', () => {
  const packages = { ...lockfile.packages }
  delete packages['node_modules/llvm-runtime']
  assert.throws(() => lockedVersions({ packages }), /llvm-runtime is missing/)
})

test('versions compare numerically, and a release sorts after its prerelease', () => {
  assert.ok(compareVersions('23.1.10', '23.1.9') > 0)
  assert.ok(compareVersions('2.1.1', '2.10.0') < 0)
  assert.equal(compareVersions('v2.1.1', '2.1.1'), 0)
  assert.ok(compareVersions('24.0.0', '24.0.0-rc.1') > 0)
  assert.ok(compareVersions('24.0.0-rc.1', '23.1.3') > 0)
})

test('only newer releases are drift', () => {
  const locked = lockedVersions(lockfile)
  assert.deepEqual(findDrift(locked, { ...locked }), [])

  const drift = findDrift(locked, { ...locked, 'llvm-runtime': '23.2.0', 'bare-make': '2.0.0' })
  assert.deepEqual(drift, [{ name: 'llvm-runtime', locked: locked['llvm-runtime'], latest: '23.2.0' }])
})

test('the issue body carries its drift key, so an unchanged drift is not re-posted', () => {
  const drift = [
    { name: 'bare-make', locked: '2.1.1', latest: '2.2.0' },
    { name: 'llvm-runtime', locked: '23.1.3', latest: '24.1.0' },
  ]
  const body = issueBody(drift)
  assert.equal(driftKey(drift), 'bare-make@2.2.0,llvm-runtime@24.1.0')
  assert.equal(keyFromIssueBody(body), driftKey(drift))
  assert.match(body, /\| `llvm-runtime` \| 23\.1\.3 \| 24\.1\.0 \|/)
  assert.equal(keyFromIssueBody('an issue edited by hand'), null)
})

test('tool versions are read from their --version banners', () => {
  assert.equal(reportedVersion('v2.1.1\n'), '2.1.1')
  assert.equal(
    reportedVersion('clang version 23.1.3 (https://github.com/llvm/llvm-project.git 0d261d1ca552)\nTarget: x86_64-unknown-linux-gnu'),
    '23.1.3',
  )
  assert.equal(reportedVersion('LLVM (http://llvm.org/):\n  LLVM version 23.1.3\n  Optimized build.'), '23.1.3')
  assert.equal(reportedVersion(''), null)
})

test('a host clang or a missing tool on PATH is a mismatch', () => {
  const bin = '/w/.github/bare-toolchain/node_modules/.bin'
  assert.deepEqual(
    pathMismatches(bin, { 'bare-make': `${bin}/bare-make`, clang: `${bin}/clang`, 'llvm-profdata': `${bin}/llvm-profdata` }, 'linux'),
    [],
  )
  assert.deepEqual(
    pathMismatches(bin, { 'bare-make': `${bin}/bare-make`, clang: '/usr/bin/clang', 'llvm-profdata': null }, 'linux'),
    [
      { tool: 'clang', actual: '/usr/bin/clang' },
      { tool: 'llvm-profdata', actual: null },
    ],
  )
})

test('on Windows the lock bin directory matches regardless of case and separators', () => {
  const bin = 'D:\\a\\qvac\\.github\\bare-toolchain\\node_modules\\.bin'
  const found = {
    'bare-make': 'd:\\a\\qvac\\.github\\bare-toolchain\\node_modules\\.bin\\bare-make.cmd',
    clang: 'D:/a/qvac/.github/bare-toolchain/node_modules/.bin/clang.cmd',
    'llvm-profdata': 'C:\\Program Files\\LLVM\\bin\\llvm-profdata.exe',
  }
  assert.deepEqual(pathMismatches(bin, found, 'win32'), [
    { tool: 'llvm-profdata', actual: found['llvm-profdata'] },
  ])
})

test('a tool resolves to the first PATH entry that has it', () => {
  const files = new Set(['/lock/.bin/clang', '/usr/bin/clang', '/usr/bin/llvm-profdata'])
  const exists = (file) => files.has(file)
  assert.equal(findOnPath('clang', { path: '/lock/.bin::/usr/bin', platform: 'linux', exists }), '/lock/.bin/clang')
  assert.equal(findOnPath('llvm-profdata', { path: '/lock/.bin:/usr/bin', platform: 'linux', exists }), '/usr/bin/llvm-profdata')
  assert.equal(findOnPath('bare-make', { path: '/lock/.bin:/usr/bin', platform: 'linux', exists }), null)
})

test('on Windows a tool resolves through PATHEXT, not its bare name', () => {
  const files = new Set(['C:\\lock\\.bin\\clang', 'C:\\lock\\.bin\\clang.cmd', 'C:\\LLVM\\bin\\clang.exe'])
  const exists = (file) => files.has(file)
  const options = { path: 'C:\\lock\\.bin;C:\\LLVM\\bin', pathext: '.COM;.EXE;.CMD', platform: 'win32', exists }
  assert.equal(findOnPath('clang', options), 'C:\\lock\\.bin\\clang.cmd')
  assert.equal(findOnPath('clang', { ...options, path: 'C:\\LLVM\\bin;C:\\lock\\.bin' }), 'C:\\LLVM\\bin\\clang.exe')
})

function fakeGitHub(issues) {
  const calls = []
  const record = (name) => async (args) => {
    calls.push({ name, ...args })
    return { data: { number: 99 } }
  }
  const github = {
    paginate: async (_method, args) => {
      calls.push({ name: 'list', ...args })
      return issues
    },
    rest: {
      issues: {
        listForRepo: {},
        createComment: record('comment'),
        update: record('update'),
        create: record('create'),
        getLabel: record('getLabel'),
        createLabel: record('createLabel'),
      },
    },
  }
  return { github, calls }
}

const drifted = [{ name: 'llvm-runtime', locked: '23.1.3', latest: '24.1.0' }]
const issue = (number, state, drift) => ({
  number, state, title: ISSUE_TITLE, body: issueBody(drift),
})
const sync = (github, drift) =>
  syncDriftIssue({
    github, owner: 'o', repo: 'r', runUrl: 'u',
    drift: drift.length > 0, key: driftKey(drift), body: drift.length > 0 ? issueBody(drift) : '',
  })

test('a new drift opens the tracking issue, and searches closed issues too', async () => {
  const { github, calls } = fakeGitHub([])
  await sync(github, drifted)
  assert.equal(calls[0].state, 'all')
  assert.equal(calls[0].labels, ISSUE_LABEL)
  const created = calls.find((call) => call.name === 'create')
  assert.equal(created.title, ISSUE_TITLE)
  assert.deepEqual(created.labels, [ISSUE_LABEL])
})

test('an issue closed by hand puts its drift off until a newer release', async () => {
  const deferred = fakeGitHub([issue(7, 'closed', drifted)])
  await sync(deferred.github, drifted)
  assert.deepEqual(deferred.calls.map((call) => call.name), ['list'])

  const newer = [{ name: 'llvm-runtime', locked: '23.1.3', latest: '24.2.0' }]
  const reopened = fakeGitHub([issue(7, 'closed', drifted)])
  await sync(reopened.github, newer)
  assert.ok(reopened.calls.some((call) => call.name === 'create'))
})

test('an open issue is updated only when the drift changes, and closed when it is gone', async () => {
  const same = fakeGitHub([issue(5, 'open', drifted)])
  await sync(same.github, drifted)
  assert.deepEqual(same.calls.map((call) => call.name), ['list'])

  const newer = [{ name: 'llvm-runtime', locked: '23.1.3', latest: '24.2.0' }]
  const updated = fakeGitHub([issue(5, 'open', drifted)])
  await sync(updated.github, newer)
  assert.deepEqual(updated.calls.map((call) => call.name), ['list', 'update', 'comment'])
  assert.equal(keyFromIssueBody(updated.calls[1].body), driftKey(newer))

  const caughtUp = fakeGitHub([issue(5, 'open', drifted), issue(3, 'closed', drifted)])
  await sync(caughtUp.github, [])
  assert.deepEqual(caughtUp.calls.map((call) => [call.name, call.issue_number]), [
    ['list', undefined],
    ['comment', 5],
    ['update', 5],
  ])
})

test('the issue says to move the setup-bare-tooling pins after the bump', () => {
  assert.match(issueBody(drifted), /setup-bare-tooling.*SHA pin/)
})
