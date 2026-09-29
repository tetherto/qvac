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

const E404 = { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' }

// `onNpm` lists the exact versions npm already has, as "name@version". A
// package the fake publishes is served after `servedAfter[name]` version
// lookups (default 1, the first one), or never when it is in `neverServed`.
function fakeRun ({ latest = {}, onNpm = [], failPublishOf = null, viewFails = false, servedAfter = {}, neverServed = [] } = {}) {
  const calls = []
  const pending = new Map()
  const served = new Set(onNpm.map((spec) => spec.slice(0, spec.lastIndexOf('@'))))
  const run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'npm') {
      if (viewFails) return { status: 1, stdout: '{"error":{"code":"ETIMEDOUT"}}', stderr: 'timeout' }
      const [, spec, field] = args
      if (field === 'version') {
        const name = spec.slice(0, spec.lastIndexOf('@'))
        if (pending.has(name)) {
          const left = pending.get(name) - 1
          if (left <= 0) {
            pending.delete(name)
            served.add(name)
          } else {
            pending.set(name, left)
          }
        }
        if (!served.has(name)) return E404
        return { status: 0, stdout: JSON.stringify(spec.slice(spec.lastIndexOf('@') + 1)), stderr: '' }
      }
      if (!(spec in latest)) return E404
      return { status: 0, stdout: JSON.stringify(latest[spec]), stderr: '' }
    }
    const project = args.find((a) => a.startsWith('--projects=')).slice('--projects='.length)
    if (project === failPublishOf) return { status: 1, stdout: '', stderr: '' }
    if (!args.includes('--dry-run') && !served.has(project) && !neverServed.includes(project)) {
      pending.set(project, servedAfter[project] ?? 1)
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const NO_WAIT = { attempts: 3, intervalMs: 0 }

function versionLookups (calls, name) {
  return calls.filter(([command, , spec, field]) => command === 'npm' && field === 'version' && spec.startsWith(`${name}@`)).length
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

  assert.deepEqual(result.completed.map((p) => p.name), ['@qvac/inference'])
  assert.equal(result.failed.name, '@qvac/sdk')
  assert.deepEqual(result.notAttempted.map((p) => p.name), ['@qvac/cli', '@qvac/plugin'])
  assert.equal(publishCalls(calls).length, 2)
})

test('marks a version npm already has, and still hands it to nx', () => {
  const { run, calls } = fakeRun({ latest: { '@qvac/inference': '0.21.0' }, onNpm: ['@qvac/inference@0.21.0'] })
  const result = publishTrain({ train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG })

  assert.deepEqual(
    result.completed.map((p) => [p.name, p.alreadyPublished]),
    [['@qvac/inference', true], ['@qvac/sdk', false], ['@qvac/cli', false], ['@qvac/plugin', false]],
  )
  assert.equal(publishCalls(calls).length, 4)
})

test('publishes the next package only after npm serves the previous one', () => {
  const { run, calls } = fakeRun({ servedAfter: { '@qvac/inference': 3 } })
  const result = publishTrain({ train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG, serveWait: NO_WAIT, sleep: () => {} })

  assert.equal(result.failed, null)
  const sdkPublish = calls.findIndex((c) => c[0] === 'pnpm' && c.includes('--projects=@qvac/sdk'))
  // One lookup while planning, then three polls until the third one answers.
  assert.equal(versionLookups(calls.slice(0, sdkPublish), '@qvac/inference'), 4)
})

test('stops when npm never serves a version it accepted', () => {
  const sleeps = []
  const { run, calls } = fakeRun({ neverServed: ['@qvac/sdk'] })
  const result = publishTrain({
    train: 'sdk', readManifest: readManifest(), run, log: () => {}, catalog: CATALOG,
    serveWait: { attempts: 3, intervalMs: 5 }, sleep: (ms) => sleeps.push(ms),
  })

  assert.equal(result.failed.name, '@qvac/sdk')
  assert.equal(result.failed.reason, 'not-served')
  assert.deepEqual(result.completed.map((p) => p.name), ['@qvac/inference'])
  assert.deepEqual(result.notAttempted.map((p) => p.name), ['@qvac/cli', '@qvac/plugin'])
  assert.equal(publishCalls(calls).length, 2)
  assert.deepEqual(sleeps, [5, 5])
})

test('does not wait for a version already on npm, nor on a dry run', () => {
  const onNpm = ['@qvac/inference@0.21.0', '@qvac/sdk@0.21.0', '@qvac/cli@0.15.0', '@qvac/plugin@0.4.0']
  const already = fakeRun({ onNpm })
  publishTrain({ train: 'sdk', readManifest: readManifest(), run: already.run, log: () => {}, catalog: CATALOG, serveWait: NO_WAIT, sleep: () => {} })
  assert.equal(versionLookups(already.calls, '@qvac/sdk'), 1)

  const dry = fakeRun()
  const result = publishTrain({ train: 'sdk', dryRun: true, readManifest: readManifest(), run: dry.run, log: () => {}, catalog: CATALOG, serveWait: NO_WAIT, sleep: () => {} })
  assert.equal(result.failed, null)
  assert.equal(versionLookups(dry.calls, '@qvac/sdk'), 1)
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
