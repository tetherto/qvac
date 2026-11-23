import test from 'node:test'
import assert from 'node:assert/strict'
import { pendingBranches, plan, qvacRanges, summary, versionBumps } from '../addon-auto-release.mjs'

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
  assert.deepEqual(pendingBranches({ heads, readMain: main }), [{ dir: 'llm-llamacpp', version: '0.73.0', sha: SHA }])
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
    optionalDependencies: { '@qvac/asr-ggml-linux-x64': '0.13.2', '@qvac/fabric-linux-x64': '^0.32.0' },
    peerDependencies: { '@qvac/fabric-ios': '^0.32.0' },
    devDependencies: { '@qvac/test-suite': '^0.15.0' },
  })
  assert.deepEqual(
    ranges.map((r) => r.name),
    ['@qvac/fabric', '@qvac/fabric-ios', '@qvac/fabric-linux-x64']
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
  const rows = [{ name: '@qvac/ocr-ggml', version: '0.36.0', action: 'skip', reason: 'publish run already exists (failure): u' }]
  assert.match(summary(rows, { title: 't', dryRun: false }), /re-run it from its run page/)
})
