import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changelogSection,
  checkRelease,
  linkedOutsideTrain,
  loadTrain,
  movedProjects,
  parseBranch,
  parseLsRemote,
  planTags,
  readRepoJson,
  resolveDistTag,
  singleDistTag,
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

function check ({ versions = { '@qvac/inference': '0.21.0', '@qvac/sdk': '0.21.0' }, moved, changelogs = {}, affected = [] }) {
  return checkRelease({
    branch: { train: 'sdk', version: '0.21.0' },
    train: TRAIN,
    moved,
    versionAtHead: (name) => versions[name],
    changelogAt: (project) => changelogs[project.name] ?? `## [${project.version}]\n\n- notes\n`,
    affected,
  })
}

const ENGINE = [
  { name: '@qvac/inference', dir: 'packages/inference', version: '0.21.0' },
  { name: '@qvac/sdk', dir: 'packages/sdk', version: '0.21.0' },
]

test('accepts a release that moves everything affected, with notes for each', () => {
  assert.deepEqual(check({ moved: ENGINE, affected: ['@qvac/inference', '@qvac/sdk', '@qvac/rag'] }), [])
})

test('rejects an anchor package that is not at the branch version', () => {
  assert.deepEqual(check({ versions: { '@qvac/inference': '0.21.0', '@qvac/sdk': '0.21.1' }, moved: ENGINE }), [
    '@qvac/sdk is at 0.21.1, the branch says 0.21.0',
  ])
})

test('rejects a moved package without notes for its new version', () => {
  const errors = check({ moved: ENGINE, changelogs: { '@qvac/sdk': '## [0.20.3]\n\n- fix\n' } })
  assert.deepEqual(errors, ['packages/sdk/CHANGELOG.md has no notes under "## [0.21.0]"'])
})

test('rejects a release that leaves out a train package nx counts as affected', () => {
  const errors = check({ moved: ENGINE, affected: ['@qvac/inference', '@qvac/sdk', '@qvac/cli'] })
  assert.deepEqual(errors, ['@qvac/cli changed since the last train release but this release does not move it'])
})

test('rejects a committed version plan, which nx would apply to the next train', () => {
  const errors = checkRelease({
    branch: { train: 'sdk', version: '0.21.0' },
    train: TRAIN,
    moved: ENGINE,
    versionAtHead: () => '0.21.0',
    changelogAt: (project) => `## [${project.version}]\n\n- notes\n`,
    affected: [],
    versionPlans: ['.nx/version-plans/qvac-1.md'],
  })
  assert.deepEqual(errors, ['.nx/version-plans/qvac-1.md is committed; delete it, nx would apply it again'])
})

test('picks dist-tags by the npm-dist-tag-determination rule', () => {
  assert.equal(resolveDistTag({ version: '0.21.0', latest: '0.20.3' }), 'latest')
  assert.equal(resolveDistTag({ version: '0.21.0', latest: '0.21.0' }), 'latest')
  assert.equal(resolveDistTag({ version: '0.1.0', latest: null }), 'latest')
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0' }), 'release-0.20')
  assert.equal(resolveDistTag({ version: '0.22.0-rc.1', latest: '0.21.0' }), 'release-0.22')
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0', requested: 'latest' }), 'release-0.20')
  assert.equal(resolveDistTag({ version: '0.20.4', latest: '0.21.0', requested: 'next' }), 'next')
})

test('refuses to publish packages that need different dist-tags in one run', () => {
  assert.equal(singleDistTag([{ tag: 'latest' }, { tag: 'latest' }]), 'latest')
  assert.throws(
    () => singleDistTag([{ name: '@qvac/sdk', version: '0.21.0', tag: 'latest' }, { name: '@qvac/cli', version: '0.14.2', tag: 'release-0.14' }]),
    /@qvac\/cli@0\.14\.2 -> release-0\.14\); pass npm_tag/,
  )
})

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

test('reads the commit a remote tag points at', () => {
  const annotated = `${'c'.repeat(40)}\trefs/tags/cli-v0.15.0\n${HEAD}\trefs/tags/cli-v0.15.0^{}\n`
  assert.equal(parseLsRemote(annotated, 'cli-v0.15.0'), HEAD)
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.0\n`, 'cli-v0.15.0'), HEAD)
  assert.equal(parseLsRemote(`${HEAD}\trefs/tags/cli-v0.15.00\n`, 'cli-v0.15.0'), null)
  assert.equal(parseLsRemote('', 'cli-v0.15.0'), null)
})

test('tags moved packages once, and fails on a tag at another commit', () => {
  const moved = [
    { name: '@qvac/inference', version: '0.21.0' },
    { name: '@qvac/sdk', version: '0.21.0' },
    { name: '@qvac/cli', version: '0.16.0' },
    { name: '@qvac/ai-sdk-provider', version: '0.10.0' },
  ]
  const onOrigin = { 'cli-v0.16.0': HEAD, 'ai-sdk-provider-v0.10.0': OTHER }
  const plan = planTags(moved, { releaseProject: '@qvac/sdk', remoteCommit: (tag) => onOrigin[tag] ?? null, head: HEAD })
  assert.deepEqual(plan, {
    create: ['inference-v0.21.0'],
    existing: ['cli-v0.16.0'],
    conflicts: [{ tag: 'ai-sdk-provider-v0.10.0', commit: OTHER }],
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
