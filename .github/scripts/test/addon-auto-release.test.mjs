import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, diffBase, releaseRun, pendingBranches, plan, qvacRanges, scanReports, summary, versionBumps } from '../addon-auto-release.mjs'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const addon = { tags: ['ci:addons'], targets: { publish: {} } }

function repo(files) {
  return (path) => (path in files ? JSON.stringify(files[path]) : null)
}

const llm = (version, deps = {}) => ({
  dir: 'llm-llamacpp',
  name: '@qvac/llm-llamacpp',
  from: '0.72.0',
  version,
  manifest: { name: '@qvac/llm-llamacpp', version, ...deps },
})

const lookups = (over = {}) => ({
  sha: SHA,
  mainVersion: () => null,
  isPublished: () => false,
  rangeAvailable: () => true,
  branchSha: () => null,
  publishRun: () => null,
  onMain: () => true,
  branchOrigin: () => ({ actor: 'github-actions[bot]', sha: OTHER, minutes: 60 }),
  ...over,
})

test('versionBumps: only public ci:addons packages with a publish target whose version changed', () => {
  const base = repo({
    'packages/llm-llamacpp/package.json': { name: '@qvac/llm-llamacpp', version: '0.72.0' },
    'packages/sdk/package.json': { name: '@qvac/sdk', version: '0.24.0' },
    'packages/ocr-ggml/package.json': { name: '@qvac/ocr-ggml', version: '0.35.0' },
    'packages/private-addon/package.json': { name: '@qvac/private-addon', version: '1.0.0', private: true },
  })
  const head = repo({
    'packages/llm-llamacpp/package.json': { name: '@qvac/llm-llamacpp', version: '0.72.1' },
    'packages/llm-llamacpp/project.json': addon,
    'packages/sdk/package.json': { name: '@qvac/sdk', version: '0.25.0' },
    'packages/sdk/project.json': { tags: ['ci:sdk'], targets: { publish: {} } },
    'packages/ocr-ggml/package.json': { name: '@qvac/ocr-ggml', version: '0.35.0', description: 'dep bump only' },
    'packages/ocr-ggml/project.json': addon,
    'packages/private-addon/package.json': { name: '@qvac/private-addon', version: '1.0.1', private: true },
    'packages/private-addon/project.json': addon,
    'packages/no-publish/package.json': { name: '@qvac/no-publish', version: '0.1.0' },
    'packages/no-publish/project.json': { tags: ['ci:addons'], targets: {} },
  })
  const changed = [
    'packages/llm-llamacpp/package.json',
    'packages/sdk/package.json',
    'packages/ocr-ggml/package.json',
    'packages/private-addon/package.json',
    'packages/no-publish/package.json',
    'packages/llm-llamacpp/test/fixtures/package.json',
  ]
  const bumps = versionBumps({ changed, readBase: base, readHead: head })
  assert.deepEqual(
    bumps.map(({ dir, from, version }) => ({ dir, from, version })),
    [{ dir: 'llm-llamacpp', from: '0.72.0', version: '0.72.1' }]
  )
})

test('versionBumps: a new addon counts as a bump', () => {
  const head = repo({
    'packages/decision-ggml/package.json': { name: '@qvac/decision-ggml', version: '0.1.0' },
    'packages/decision-ggml/project.json': addon,
  })
  const bumps = versionBumps({ changed: ['packages/decision-ggml/package.json'], readBase: repo({}), readHead: head })
  assert.equal(bumps[0].from, null)
})

test('pendingBranches: only addon branches at the version main still carries', () => {
  const main = repo({
    'packages/llm-llamacpp/package.json': { name: '@qvac/llm-llamacpp', version: '0.73.0' },
    'packages/llm-llamacpp/project.json': addon,
    'packages/sdk/package.json': { name: '@qvac/sdk', version: '0.25.0' },
    'packages/sdk/project.json': { tags: ['ci:sdk'], targets: { publish: {} } },
  })
  const heads = [
    { branch: 'release-llm-llamacpp-0.73.0', sha: SHA },
    { branch: 'release-llm-llamacpp-0.72.1', sha: OTHER },
    { branch: 'release-sdk-0.25.0', sha: OTHER },
    { branch: 'release-train-sdk-0.25.0', sha: OTHER },
    { branch: 'release-llm-0.36.4', sha: OTHER },
    { branch: 'release-gone-1.0.0', sha: OTHER },
  ]
  assert.deepEqual(pendingBranches({ heads, readMain: main }), [{ dir: 'llm-llamacpp', name: '@qvac/llm-llamacpp', version: '0.73.0', sha: SHA }])
})

test('plan: a fresh bump creates the release branch and starts publish', () => {
  const [row] = plan([llm('0.72.1')], lookups())
  assert.equal(row.action, 'release')
  assert.equal(row.branch, 'release-llm-llamacpp-0.72.1')
  assert.equal(row.sha, SHA)
})

test('plan: a version already on npm is skipped, so backmerges and re-runs never publish twice', () => {
  const [row] = plan([llm('0.72.1')], lookups({ isPublished: () => true }))
  assert.deepEqual([row.action, row.reason], ['skip', 'already on npm'])
})

test('plan: a branch someone cut at another commit is left alone', () => {
  const [row] = plan([llm('0.72.1')], lookups({ branchSha: () => OTHER }))
  assert.equal(row.action, 'skip')
  assert.match(row.reason, /already exists at bbbbbbbbb/)
})

test('plan: a branch at this commit with no publish run is started; with a run it is skipped and names the run', () => {
  assert.equal(plan([llm('0.72.1')], lookups({ branchSha: () => SHA }))[0].action, 'dispatch')
  const run = { status: 'completed', conclusion: 'failure', url: 'https://example.test/runs/1' }
  const [row] = plan([llm('0.72.1')], lookups({ branchSha: () => SHA, publishRun: () => run }))
  assert.deepEqual([row.action, row.reason], ['skip', 'publish run already exists (failure): https://example.test/runs/1'])
})

test('plan: a publish run counts only for the commit the branch points at', () => {
  const asked = []
  const publishRun = (branch, head) => (asked.push([branch, head]), null)
  plan([llm('0.72.1')], lookups({ branchSha: () => SHA, publishRun }))
  assert.deepEqual(asked, [['release-llm-llamacpp-0.72.1', SHA]])
})

test('plan: a scan starts only a branch the auto-release cut, still where it cut it, on main, and not just now', () => {
  const bump = { ...llm('0.73.0'), from: null, sha: OTHER }
  const scan = (over) => plan([bump], lookups({ sha: null, branchSha: () => OTHER, ...over }))[0]
  assert.deepEqual([scan({}).action], ['dispatch'])
  assert.deepEqual([scan({ onMain: () => false }).reason], ['branch commit is not on main'])
  const notOurs = 'not cut by the auto-release, or moved since'
  assert.equal(scan({ branchOrigin: () => ({ actor: 'someone', sha: OTHER, minutes: 60 }) }).reason, notOurs)
  assert.equal(scan({ branchOrigin: () => ({ actor: 'github-actions[bot]', sha: SHA, minutes: 60 }) }).reason, notOurs)
  assert.equal(scan({ branchOrigin: () => null }).reason, notOurs)
  const fresh = scan({ branchOrigin: () => ({ actor: 'github-actions[bot]', sha: OTHER, minutes: 2 }) })
  assert.deepEqual([fresh.action, fresh.reason], ['skip', 'cut moments ago; the run that cut it starts it'])
  const never = () => assert.fail('a bump run does not check the branch origin')
  assert.equal(plan([llm('0.72.1')], lookups({ onMain: never, branchOrigin: never }))[0].action, 'release')
})

test('plan: any publish run that ended without success is flagged for a re-run; queued or waiting ones are not', () => {
  const state = (run) => plan([llm('0.72.1')], lookups({ branchSha: () => SHA, publishRun: () => ({ url: 'u', ...run }) }))[0]
  assert.equal(state({ status: 'completed', conclusion: 'timed_out' }).rerun, true)
  assert.equal(state({ status: 'completed', conclusion: 'startup_failure' }).rerun, true)
  assert.equal(state({ status: 'completed', conclusion: 'success' }).rerun, false)
  assert.equal(state({ status: 'waiting', conclusion: '' }).rerun, false)
})

test('summary: a backslash cannot un-escape a pipe', () => {
  const text = summary([{ name: 'a\\|b', version: '1.0.0', action: 'skip' }], { title: 't', dryRun: false })
  assert.ok(text.includes('| a\\\\\\|b | 1.0.0 |'))
})

test('summary: branch-sourced text cannot break the table', () => {
  const text = summary([{ name: 'a|b', version: '1.0.0', action: 'failed', reason: 'x\n::notice::y' }], { title: 't', dryRun: false })
  assert.match(text, /\| a\\\|b \| 1\.0\.0 \| not started: x ::notice::y \|/)
})

test('plan: a scanned branch is judged against its own commit, not the run commit', () => {
  const bump = { ...llm('0.73.0'), from: null, sha: OTHER }
  const [row] = plan([bump], lookups({ sha: null, branchSha: () => OTHER }))
  assert.deepEqual([row.action, row.sha], ['dispatch', OTHER])
})

test('plan: a bump main has already moved past is not released', () => {
  const [row] = plan([llm('0.72.1')], lookups({ mainVersion: () => '0.73.0' }))
  assert.deepEqual([row.action, row.reason], ['skip', 'main has moved on to 0.73.0'])
})

test('plan: waits while a @qvac dependency range has no version on npm, and says whether the branch exists', () => {
  const bump = llm('0.73.0', { dependencies: { '@qvac/fabric': '^0.33.0', '@qvac/logging': '^0.1.0', bare: '^1.0.0' } })
  const asked = []
  const rangeAvailable = (name, range) => (asked.push(`${name}@${range}`), name !== '@qvac/fabric')
  const [row] = plan([bump], lookups({ rangeAvailable }))
  assert.deepEqual([row.action, row.exists], ['wait', false])
  assert.equal(row.reason, 'needs @qvac/fabric@^0.33.0 on npm first')
  assert.deepEqual(asked, ['@qvac/fabric@^0.33.0', '@qvac/logging@^0.1.0'])
  assert.equal(plan([bump], lookups({ rangeAvailable, branchSha: () => SHA }))[0].exists, true)
})

test('plan: a failed lookup fails only its own row', () => {
  const ocr = { dir: 'ocr-ggml', name: '@qvac/ocr-ggml', from: '0.35.0', version: '0.36.0', manifest: { name: '@qvac/ocr-ggml' } }
  const isPublished = (name) => {
    if (name === '@qvac/llm-llamacpp') throw new Error('npm view @qvac/llm-llamacpp@0.72.1 failed (exit 1: 503)\nmore')
    return false
  }
  const rows = plan([llm('0.72.1'), ocr], lookups({ isPublished }))
  assert.deepEqual(
    rows.map((r) => [r.dir, r.action]),
    [['llm-llamacpp', 'failed'], ['ocr-ggml', 'release']]
  )
  assert.equal(rows[0].reason, 'npm view @qvac/llm-llamacpp@0.72.1 failed (exit 1: 503)')
})

test('qvacRanges: own platform packages and non-semver ranges are not prerequisites', () => {
  const ranges = qvacRanges({
    name: '@qvac/asr-ggml',
    dependencies: { '@qvac/fabric': '^0.32.0', '@qvac/infer-base': 'workspace:*' },
    optionalDependencies: {
      '@qvac/asr-ggml-linux-x64': '0.13.2',
      '@qvac/asr-ggml-ios-arm64': '0.13.2',
      '@qvac/asr-ggml-tools': '^0.2.0',
      '@qvac/fabric-linux-x64': '^0.32.0',
    },
    peerDependencies: { '@qvac/fabric-ios': '^0.32.0' },
    devDependencies: { '@qvac/test-suite': '^0.15.0' },
  })
  assert.deepEqual(
    ranges.map((r) => r.name),
    ['@qvac/fabric', '@qvac/fabric-ios', '@qvac/asr-ggml-tools', '@qvac/fabric-linux-x64']
  )
})

test('plan: prereleases and downgrades are skipped', () => {
  assert.equal(plan([llm('0.73.0-rc.1')], lookups())[0].action, 'skip')
  const [row] = plan([{ ...llm('0.71.0'), from: '0.72.0' }], lookups())
  assert.deepEqual([row.action, row.reason], ['skip', 'version went down from 0.72.0'])
})

test('summary: says what happened, and only what would happen on a dry run', () => {
  const rows = [
    { name: '@qvac/fabric', version: '0.33.0', action: 'release' },
    { name: '@qvac/llm-llamacpp', version: '0.73.0', action: 'wait', reason: 'needs @qvac/fabric@^0.33.0 on npm first' },
  ]
  const live = summary(rows, { title: 'Addon auto-release for aaaaaaaaa', dryRun: false })
  assert.match(live, /\| @qvac\/fabric \| 0\.33\.0 \| branch cut, publish started, waiting for npm approval \|/)
  assert.match(live, /\| @qvac\/llm-llamacpp \| 0\.73\.0 \| branch cut, publish starts once the dependency is on npm: needs/)
  assert.match(live, /start on their own/)
  const dry = summary(rows, { title: 'Addon auto-release for aaaaaaaaa', dryRun: true })
  assert.match(dry, /\(dry run\)/)
  assert.match(dry, /would cut the branch and start publish/)
  assert.doesNotMatch(dry, /publish started/)
  assert.match(summary([], { title: 'Waiting addon releases', dryRun: false }), /Nothing to release/)
})

test('summary: points a failed publish at its run page', () => {
  const rows = [{ name: '@qvac/ocr-ggml', version: '0.36.0', action: 'skip', rerun: true, reason: 'publish run already exists (timed_out): u' }]
  assert.match(summary(rows, { title: 't', dryRun: false }), /re-run it from its run page/)
})

function recorder(failStart) {
  const calls = []
  return {
    calls,
    create: (row) => calls.push(`create ${row.branch}`),
    start: (row) => {
      if (failStart) throw new Error('HTTP 422\nbody')
      calls.push(`start ${row.branch}`)
    },
  }
}

test('apply: release creates then starts, dispatch only starts, wait only creates a missing branch', () => {
  const rows = [
    { branch: 'release-a-1.0.0', action: 'release' },
    { branch: 'release-b-1.0.0', action: 'dispatch' },
    { branch: 'release-c-1.0.0', action: 'wait', exists: false },
    { branch: 'release-d-1.0.0', action: 'wait', exists: true },
    { branch: 'release-e-1.0.0', action: 'skip' },
    { branch: 'release-f-1.0.0', action: 'failed' },
  ]
  const r = recorder()
  apply(rows, { dryRun: false, ...r })
  assert.deepEqual(r.calls, [
    'create release-a-1.0.0',
    'start release-a-1.0.0',
    'start release-b-1.0.0',
    'create release-c-1.0.0',
  ])
})

test('apply: a dry run writes nothing, and a failed start marks only its row failed', () => {
  const dry = recorder()
  apply([{ branch: 'release-a-1.0.0', action: 'release' }], { dryRun: true, ...dry })
  assert.deepEqual(dry.calls, [])
  const r = recorder(true)
  const rows = apply(
    [{ branch: 'release-a-1.0.0', action: 'release' }, { branch: 'release-c-1.0.0', action: 'wait', exists: false }],
    { dryRun: false, ...r }
  )
  assert.deepEqual(r.calls, ['create release-a-1.0.0', 'create release-c-1.0.0'])
  assert.deepEqual(rows.map((x) => [x.action, x.reason]), [['failed', 'HTTP 422'], ['wait', undefined]])
})

test('scanReports: keeps starts, waits, failures and a publish needing a re-run; drops settled skips', () => {
  const rows = [
    { action: 'skip', reason: 'already on npm' },
    { action: 'skip', reason: 'branch commit is not on main' },
    { action: 'skip', reason: 'publish run already exists (in_progress): u' },
    { action: 'skip', rerun: true, reason: 'publish run already exists (failure): u' },
    { action: 'skip', reason: 'cut moments ago; the run that cut it starts it' },
    { action: 'wait', reason: 'needs x' },
    { action: 'failed', reason: 'npm view failed' },
  ]
  assert.deepEqual(rows.filter(scanReports).map((r) => r.reason), [
    'publish run already exists (failure): u',
    'cut moments ago; the run that cut it starts it',
    'needs x',
    'npm view failed',
  ])
})

test('apply: a publish another run started first is reported as skipped, not started again', () => {
  const calls = []
  const rows = apply([{ branch: 'release-a-1.0.0', action: 'dispatch' }], {
    dryRun: false,
    create: () => calls.push('create'),
    start: () => false,
  })
  assert.deepEqual(calls, [])
  assert.deepEqual([rows[0].action, rows[0].reason], ['skip', 'another auto-release run started its publish first'])
})

test('diffBase: uses the push before-sha, falling back to the parent for new branches and dispatches', () => {
  assert.equal(diffBase(SHA, OTHER), OTHER)
  assert.equal(diffBase(SHA, '0'.repeat(40)), `${SHA}^1`)
  assert.equal(diffBase(SHA, ''), `${SHA}^1`)
  assert.equal(diffBase(SHA, undefined), `${SHA}^1`)
})

test('releaseRun: ignores dry runs and runs of another commit', () => {
  const runs = [
    { headSha: SHA, displayTitle: 'Publish to npm (dry run) on release-a-1.0.0', url: 'dry' },
    { headSha: OTHER, displayTitle: 'Publish to npm on release-a-1.0.0', url: 'old' },
    { headSha: SHA, displayTitle: 'Publish to npm on release-a-1.0.0', url: 'real' },
  ]
  assert.equal(releaseRun(runs, SHA).url, 'real')
  assert.equal(releaseRun(runs.slice(0, 2), SHA), null)
})
