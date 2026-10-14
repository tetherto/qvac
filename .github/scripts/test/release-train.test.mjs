import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changelogSection,
  checkRelease,
  compareVersions,
  linkedOutsideTrain,
  loadTrain,
  movedProjects,
  parseBranch,
  parseLsRemote,
  planTags,
  publishedElsewhere,
  rangeErrors,
  readRepoJson,
  satisfies,
  stageManifest,
} from '../lib/release-train.mjs'

const NX_JSON = {
  release: {
    groups: {
      engine: { projects: ['@qvac/inference', '@qvac/sdk'], projectsRelationship: 'fixed' },
      agentstack: { projects: ['@qvac/cli'], projectsRelationship: 'independent' },
    },
  },
}
const CATALOG = {
  sdk: { groups: ['engine', 'agentstack'], anchorGroup: 'engine', githubRelease: { project: '@qvac/sdk', name: 'QVAC SDK' } },
}
const TRAIN = loadTrain('sdk', CATALOG, NX_JSON)

// The Releases page is SDK-only (ci-trust-policy.test.mjs); release-train.yml
// cuts a release for whichever package the catalog names.
test('every train in the repo loads, and only @qvac/sdk gets a GitHub release', () => {
  const catalog = readRepoJson('.github/release-trains.json')
  const nxJson = readRepoJson('nx.json')
  for (const name of Object.keys(catalog)) {
    const release = loadTrain(name, catalog, nxJson).githubRelease
    if (release) assert.equal(release.project, '@qvac/sdk', `train '${name}'`)
  }
})

test('rejects a train the config cannot release', () => {
  assert.throws(() => loadTrain('docs', CATALOG, NX_JSON), /Unknown release train 'docs'/)
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, groups: ['engine', 'tools'] } }, NX_JSON),
    /'tools', which nx.json does not declare/,
  )
  assert.throws(
    () => loadTrain('sdk', { ...CATALOG, other: { groups: ['agentstack'], anchorGroup: 'agentstack' } }, NX_JSON),
    /'agentstack' is in both 'sdk' and 'other'/,
  )
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, anchorGroup: 'agentstack' } }, NX_JSON),
    /must be one of its groups and "fixed"/,
  )
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, githubRelease: { project: '@qvac/rag' } } }, NX_JSON),
    /@qvac\/rag is not in the train/,
  )
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, checks: ['lint-everything'] } }, NX_JSON),
    /unknown checks lint-everything/,
  )
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, checks: ['package-checks'] } }, NX_JSON),
    /package-checks needs packageChecks/,
  )
})

test('reads the train and anchor version from the branch name', () => {
  assert.deepEqual(parseBranch('release-train-sdk-0.21.0'), { train: 'sdk', version: '0.21.0' })
  assert.equal(parseBranch('release-train-sdk-0.21.0-rc1'), null)
  assert.equal(parseBranch('release-train-0.21.0'), null)
  assert.equal(parseBranch('release-sdk-0.21.0'), null)
})

test('a package moved when its version differs from the base or it is new', () => {
  const base = { inference: '0.20.3', sdk: '0.20.3', cli: '0.15.0' }
  const head = { inference: '0.21.0', sdk: '0.21.0', cli: '0.15.0', plugin: '0.1.0' }
  const projects = ['inference', 'sdk', 'cli', 'plugin'].map((dir) => ({ name: `@qvac/${dir}`, dir }))
  const moved = movedProjects(projects, { base: (p) => base[p.dir] ?? null, head: (p) => head[p.dir] })
  assert.deepEqual(moved, [
    { name: '@qvac/inference', slug: 'inference', dir: 'inference', version: '0.21.0' },
    { name: '@qvac/sdk', slug: 'sdk', dir: 'sdk', version: '0.21.0' },
    { name: '@qvac/plugin', slug: 'plugin', dir: 'plugin', version: '0.1.0' },
  ])
})

test('reads the notes under a version heading, up to the next heading', () => {
  const changelog = '# Changelog\n\n## [0.21.0]\n\n- streaming\n\n## [0.20.3]\n\n- fix\n'
  assert.equal(changelogSection(changelog, '0.21.0'), '- streaming')
  assert.equal(changelogSection(changelog, '0.20.3'), '- fix')
  assert.equal(changelogSection('## [0.21.0]\n\n## [0.20.3]\n- fix\n', '0.21.0'), '')
  assert.equal(changelogSection(changelog, '0.22.0'), null)
})

test('matches exact, ^ and ~ ranges the way semver does', () => {
  assert.equal(satisfies('0.22.0', '^0.22.0'), true)
  assert.equal(satisfies('0.22.4', '^0.22.0'), true)
  assert.equal(satisfies('0.23.0', '^0.22.0'), false)
  assert.equal(satisfies('0.21.9', '^0.22.0'), false)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  assert.equal(satisfies('1.4.0', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('1.2.9', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('0.1.0', '0.1.0'), true)
  assert.equal(satisfies('0.1.1', '0.1.0'), false)
  assert.equal(satisfies('0.1.0', '>=0.1.0'), null)
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
})

const VERSIONS = { '@qvac/inference': '0.22.0', '@qvac/sdk': '0.22.0', '@qvac/cli': '0.16.0' }
const MANIFESTS = {
  '@qvac/inference': { version: '0.22.0' },
  '@qvac/sdk': { version: '0.22.0', dependencies: { '@qvac/inference': '^0.22.0', zod: '^4.0.0' } },
  '@qvac/cli': { version: '0.16.0', dependencies: { '@qvac/sdk': '^0.22.0' } },
}

test('flags a range between train packages that misses the new version', () => {
  assert.deepEqual(rangeErrors(MANIFESTS, VERSIONS), [])
  const stale = { ...MANIFESTS, '@qvac/cli': { peerDependencies: { '@qvac/sdk': '^0.21.0' }, devDependencies: { '@qvac/inference': '>=0.1' } } }
  assert.deepEqual(rangeErrors(stale, VERSIONS), [
    '@qvac/cli devDependencies: @qvac/inference@">=0.1" is not an exact, ^ or ~ range',
    '@qvac/cli peerDependencies: @qvac/sdk@"^0.21.0" does not accept 0.22.0',
  ])
})

function check ({ versions = VERSIONS, moved = MOVED, changelogs = {}, manifests = MANIFESTS, versionPlans }) {
  return checkRelease({
    branch: { train: 'sdk', version: '0.22.0' },
    train: TRAIN,
    moved,
    versionAtHead: (name) => versions[name],
    changelogAt: (project) => changelogs[project.name] ?? `## [${project.version}]\n\n- notes\n`,
    manifests,
    versionPlans,
  })
}

const MOVED = [
  { name: '@qvac/inference', dir: 'packages/inference', version: '0.22.0' },
  { name: '@qvac/sdk', dir: 'packages/sdk', version: '0.22.0' },
  { name: '@qvac/cli', dir: 'packages/cli', version: '0.16.0' },
]

test('accepts a release that moves every package, with notes and matching ranges', () => {
  assert.deepEqual(check({}), [])
})

test('rejects a release that leaves a train package where it was', () => {
  assert.deepEqual(check({ moved: MOVED.slice(0, 2) }), ['@qvac/cli does not move; a train releases every package in it'])
})

test('rejects an anchor package that is not at the branch version', () => {
  assert.deepEqual(check({ versions: { ...VERSIONS, '@qvac/sdk': '0.22.1' } }), [
    '@qvac/sdk is at 0.22.1, the branch says 0.22.0',
  ])
})

test('rejects a moved package without notes for its new version', () => {
  const errors = check({ changelogs: { '@qvac/sdk': '## [0.21.0]\n\n- fix\n' } })
  assert.deepEqual(errors, ['packages/sdk/CHANGELOG.md has no notes under "## [0.22.0]"'])
})

test('rejects a committed version plan, which nx would apply to the next train', () => {
  assert.deepEqual(check({ versionPlans: ['.nx/version-plans/qvac-1.md'] }), [
    '.nx/version-plans/qvac-1.md is committed; delete it, nx would apply it again',
  ])
})

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

test('refuses to publish the rest of a train from another commit', () => {
  const gitHeads = { '@qvac/inference': OTHER, '@qvac/sdk': HEAD }
  assert.deepEqual(publishedElsewhere(MOVED, (project) => gitHeads[project.name] ?? null, HEAD), [
    `@qvac/inference@0.22.0 was published from ${OTHER}, not ${HEAD}; cut a new train branch`,
  ])
})

test('points every train dependency, direct or not, at its tarball', () => {
  const staged = stageManifest(
    { name: '@qvac/opencode-plugin', dependencies: { '@qvac/cli': '^0.16.0', ai: '^7.0.0' }, overrides: { tar: '^7.0.0' } },
    { '@qvac/cli': '/t/cli.tgz', '@qvac/sdk': '/t/sdk.tgz', '@qvac/opencode-plugin': '/t/opencode.tgz' },
  )
  assert.deepEqual(staged, {
    name: '@qvac/opencode-plugin',
    dependencies: { '@qvac/cli': 'file:/t/cli.tgz', ai: '^7.0.0' },
    overrides: { tar: '^7.0.0', '@qvac/cli': 'file:/t/cli.tgz', '@qvac/sdk': 'file:/t/sdk.tgz' },
  })
})

test('reads the commit a remote tag points at', () => {
  const annotated = `${'c'.repeat(40)}\trefs/tags/cli-v0.15.0\n${HEAD}\trefs/tags/cli-v0.15.0^{}\n`
  assert.equal(parseLsRemote(annotated, 'cli-v0.15.0'), HEAD)
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.0\n`, 'cli-v0.15.0'), HEAD)
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.00\n`, 'cli-v0.15.0'), null)
  assert.equal(parseLsRemote('', 'cli-v0.15.0'), null)
})

test('tags each package at its npm gitHead, once, and fails on a tag elsewhere', () => {
  const moved = [
    { name: '@qvac/inference', version: '0.21.0' },
    { name: '@qvac/sdk', version: '0.21.0' },
    { name: '@qvac/cli', version: '0.16.0' },
    { name: '@qvac/ai-sdk-provider', version: '0.10.0' },
  ]
  const onOrigin = { 'cli-v0.16.0': HEAD, 'ai-sdk-provider-v0.10.0': OTHER }
  const plan = planTags(moved, { releaseProject: '@qvac/sdk', remoteCommit: (tag) => onOrigin[tag] ?? null, gitHeadOf: () => HEAD })
  assert.deepEqual(plan, {
    create: [{ tag: 'inference-v0.21.0', commit: HEAD }],
    existing: ['cli-v0.16.0'],
    conflicts: [{ tag: 'ai-sdk-provider-v0.10.0', commit: OTHER, expected: HEAD }],
  })
})

test('reports workspace links to packages outside the train, once each', () => {
  const deps = {
    '@qvac/inference': [
      { name: '@qvac/rag', version: 'link:../rag' },
      { name: '@qvac/model-fit', version: '0.14.0' },
    ],
    '@qvac/sdk': [
      { name: '@qvac/inference', version: 'link:../inference' },
      { name: '@qvac/rag', version: 'link:../rag' },
    ],
  }
  assert.deepEqual(linkedOutsideTrain(['@qvac/inference', '@qvac/sdk'], (name) => deps[name] ?? []), [
    { name: '@qvac/rag', dependents: ['@qvac/inference', '@qvac/sdk'] },
  ])
})
