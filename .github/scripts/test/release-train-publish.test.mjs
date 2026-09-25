// A train publish must name exactly one package per nx call, in dependency
// order, and stop at the first failure. These lock that against a fixture
// catalog and a fake runner; the last test checks the real sdk train order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { planPublish, publishTrain, readLatest, resolveDistTag } from '../lib/release-train-publish.mjs'
import { readRepoFile } from '../lib/release-trains.mjs'

// Catalog order deliberately lists dependents before their dependencies.
const CATALOG = {
  trains: {
    sdk: {
      anchorGroup: 'engine',
      groups: {
        agentstack: {
          projectsRelationship: 'independent',
          projects: [
            { name: '@qvac/cli', slug: 'cli', dir: 'packages/cli' },
            { name: '@qvac/plugin', slug: 'plugin', dir: 'plugins/plugin' },
          ],
        },
        engine: {
          projectsRelationship: 'fixed',
          projects: [
            { name: '@qvac/sdk', slug: 'sdk', dir: 'packages/sdk' },
            { name: '@qvac/inference', slug: 'inference', dir: 'packages/inference' },
          ],
        },
      },
    },
    empty: { anchorGroup: 'none', groups: {} },
  },
}

const MANIFESTS = {
  'packages/inference/package.json': { name: '@qvac/inference', version: '0.21.0', dependencies: { '@qvac/tts-ggml': '^0.9.0' } },
  'packages/sdk/package.json': { name: '@qvac/sdk', version: '0.21.0', dependencies: { '@qvac/inference': '^0.21.0' } },
  'packages/cli/package.json': { name: '@qvac/cli', version: '0.15.0', dependencies: { '@qvac/sdk': '^0.21.0' } },
  'plugins/plugin/package.json': { name: '@qvac/plugin', version: '0.4.0', peerDependencies: { '@qvac/cli': '^0.15.0' } },
}

function readManifest (manifests = MANIFESTS) {
  return (path) => {
    if (!manifests[path]) throw new Error(`no fixture for ${path}`)
    return JSON.stringify(manifests[path])
  }
}

function fakeRun ({ latest = {}, failPublishOf = null, viewFails = false } = {}) {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'npm') {
      if (viewFails) return { status: 1, stdout: '{"error":{"code":"ETIMEDOUT"}}', stderr: 'timeout' }
      const name = args[1]
      if (!(name in latest)) return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' }
      return { status: 0, stdout: JSON.stringify(latest[name]), stderr: '' }
    }
    const project = args.find((a) => a.startsWith('--projects=')).slice('--projects='.length)
    return { status: project === failPublishOf ? 1 : 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

function publishCalls (calls) {
  return calls.filter(([command]) => command === 'pnpm')
}

test('orders every package after the train packages it depends on', () => {
  const plan = planPublish('sdk', readManifest(), CATALOG)
  assert.deepEqual(plan.map((p) => p.name), ['@qvac/inference', '@qvac/sdk', '@qvac/cli', '@qvac/plugin'])
})

test('refuses a dependency cycle inside the train', () => {
  const manifests = {
    ...MANIFESTS,
    'packages/inference/package.json': { name: '@qvac/inference', version: '0.21.0', dependencies: { '@qvac/sdk': '0.21.0' } },
  }
  assert.throws(() => planPublish('sdk', readManifest(manifests), CATALOG), /Dependency cycle between .*@qvac\/sdk, @qvac\/inference/)
})

test('refuses a train with no projects, a private package, or a name mismatch', () => {
  assert.throws(() => planPublish('empty', readManifest(), CATALOG), /has no projects/)
  assert.throws(() => planPublish('nosuch', readManifest(), CATALOG), /Unknown release train 'nosuch'/)

  const privateCli = { ...MANIFESTS, 'packages/cli/package.json': { ...MANIFESTS['packages/cli/package.json'], private: true } }
  assert.throws(() => planPublish('sdk', readManifest(privateCli), CATALOG), /@qvac\/cli is private/)

  const renamed = { ...MANIFESTS, 'packages/cli/package.json': { ...MANIFESTS['packages/cli/package.json'], name: '@qvac/other' } }
  assert.throws(() => planPublish('sdk', readManifest(renamed), CATALOG), /is @qvac\/other, the catalog says @qvac\/cli/)
})

test('picks dist-tags with the same rule as the single-package releases', () => {
  assert.equal(resolveDistTag({ version: '0.21.0', latest: '0.20.3', requested: '' }), 'latest')
  assert.equal(resolveDistTag({ version: '0.21.0', latest: '0.21.0', requested: '' }), 'latest')
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0', requested: '' }), 'release-0.20')
  assert.equal(resolveDistTag({ version: '0.22.0-rc.1', latest: '0.21.0', requested: '' }), 'release-0.22')
  assert.equal(resolveDistTag({ version: '0.1.0', latest: '0.0.0', requested: '' }), 'latest')
  // "latest" is not a force: an older line still does not take it.
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0', requested: 'latest' }), 'release-0.20')
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0', requested: 'next' }), 'next')
})

test('reads npm latest, treating a never-published package as 0.0.0', () => {
  const { run } = fakeRun({ latest: { '@qvac/sdk': '0.20.3' } })
  assert.equal(readLatest('@qvac/sdk', run), '0.20.3')
  assert.equal(readLatest('@qvac/new', run), '0.0.0')
  assert.throws(() => readLatest('@qvac/sdk', fakeRun({ viewFails: true }).run), /npm view @qvac\/sdk failed/)
})

test('publishes one named package per nx call, each with its own tag', () => {
  const latest = { '@qvac/inference': '0.20.3', '@qvac/sdk': '0.20.3', '@qvac/cli': '0.16.0', '@qvac/plugin': '0.3.9' }
  const { run, calls } = fakeRun({ latest })
  const result = publishTrain({ train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG })

  const nx = (project, tag) => [
    'pnpm', 'exec', 'nx', 'run-many', '-t', 'nx-release-publish',
    `--projects=${project}`, '--exclude-task-dependencies', `--tag=${tag}`,
  ]
  assert.equal(result.failed, null)
  assert.deepEqual(publishCalls(calls), [
    nx('@qvac/inference', 'latest'),
    nx('@qvac/sdk', 'latest'),
    nx('@qvac/cli', 'release-0.15'),
    nx('@qvac/plugin', 'latest'),
  ])
})

test('an explicit tag applies to every package, and --dry-run reaches nx', () => {
  const { run, calls } = fakeRun()
  publishTrain({ train: 'sdk', requestedTag: 'next', dryRun: true, readManifest: readManifest(), run, log: () => {}, catalog: CATALOG })
  for (const call of publishCalls(calls)) {
    assert.ok(call.includes('--tag=next'), call.join(' '))
    assert.ok(call.includes('--dry-run'), call.join(' '))
  }
})

test('stops at the first failure and reports what was not attempted', () => {
  const { run, calls } = fakeRun({ failPublishOf: '@qvac/sdk' })
  const result = publishTrain({ train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG })

  assert.deepEqual(result.published.map((p) => p.name), ['@qvac/inference'])
  assert.equal(result.failed.name, '@qvac/sdk')
  assert.deepEqual(result.notAttempted.map((p) => p.name), ['@qvac/cli', '@qvac/plugin'])
  assert.equal(publishCalls(calls).length, 2)
})

test('a registry error stops the run before anything is published', () => {
  const { run, calls } = fakeRun({ viewFails: true })
  assert.throws(() => publishTrain({ train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG }), /npm view/)
  assert.equal(publishCalls(calls).length, 0)
})

test('the real sdk train publishes each package after its train dependencies', () => {
  const order = planPublish('sdk', readRepoFile).map((p) => p.name)
  const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b} in ${order.join(', ')}`)
  before('@qvac/inference', '@qvac/sdk')
  before('@qvac/sdk', '@qvac/cli')
  before('@qvac/cli', '@qvac/ai-sdk-provider')
  before('@qvac/ai-sdk-provider', '@qvac/opencode-plugin')
  before('@qvac/ai-sdk-provider', '@qvac/openclaw-plugin')
})
