import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  changelogSection,
  checkRelease,
  compareVersions,
  excludeFromWorkspace,
  linkedOutsideTrain,
  loadTrain,
  movedProjects,
  outsideTrain,
  parseBranch,
  parseLsRemote,
  parseNpmView,
  planTags,
  publishedCommit,
  publishedElsewhere,
  rangeErrors,
  readRepoJson,
  repoRoot,
  satisfies,
  shasumMismatches,
  stageManifest,
  workspaceDirs,
  workspaceEntries,
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
  cli: { groups: ['agentstack'], anchorProject: '@qvac/cli' },
}
const TRAIN = loadTrain('sdk', CATALOG, NX_JSON)
const CLI_TRAIN = loadTrain('cli', CATALOG, NX_JSON)

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
  const withTools = { release: { groups: { ...NX_JSON.release.groups, tools: { projects: ['@qvac/rag'], projectsRelationship: 'fixed' } } } }
  assert.throws(
    () => loadTrain('sdk', { ...CATALOG, other: { groups: ['agentstack', 'tools'], anchorGroup: 'tools' } }, withTools),
    /'sdk' and 'other' share release group 'agentstack', so one must hold every group of the other/,
  )
  assert.throws(
    () => loadTrain('sdk', { sdk: { ...CATALOG.sdk, anchorGroup: 'agentstack' } }, NX_JSON),
    /must be one of its groups and "fixed"/,
  )
  assert.throws(
    () => loadTrain('cli', { cli: { ...CATALOG.cli, anchorProject: '@qvac/sdk' } }, NX_JSON),
    /anchorProject @qvac\/sdk must be in the train/,
  )
  assert.throws(
    () => loadTrain('cli', { cli: { ...CATALOG.cli, anchorGroup: 'agentstack' } }, NX_JSON),
    /replaces anchorGroup/,
  )
})

test('a train inside another, versioned by one project', () => {
  assert.deepEqual(CLI_TRAIN.projects, ['@qvac/cli'])
  assert.deepEqual(CLI_TRAIN.anchorProjects, ['@qvac/cli'])
  assert.deepEqual(TRAIN.anchorProjects, ['@qvac/inference', '@qvac/sdk'])
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

const WORKSPACE_YAML = `packages:
  - "packages/*"
  # sdk-kotlin is a Gradle package
  - "!packages/sdk-kotlin"
  - "plugins/*"

linkWorkspacePackages: true
`

function checkCli (workspace) {
  return checkRelease({
    branch: { train: 'cli', version: '0.16.0' },
    train: CLI_TRAIN,
    moved: [MOVED[2]],
    versionAtHead: (name) => VERSIONS[name],
    changelogAt: () => '## [0.16.0]\n\n- notes\n',
    manifests: { '@qvac/cli': MANIFESTS['@qvac/cli'] },
    workspace,
    outside: [{ dir: 'packages/sdk', name: '@qvac/sdk' }],
  })
}

test('a train installs the packages outside it from npm only once they leave the workspace', () => {
  const [error] = checkCli(WORKSPACE_YAML)
  assert.match(error, /^packages\/sdk is in the pnpm workspace, but the 'cli' train installs @qvac\/sdk from npm/)
  assert.deepEqual(checkCli(excludeFromWorkspace(WORKSPACE_YAML, ['packages/sdk'])), [])
})

const DIRS = { packages: ['inference', 'sdk', 'cli', 'rag', 'embed', 'lint-config', 'docs'], plugins: ['opencode'] }
const PACKAGES = [
  { dir: 'packages/inference', manifest: { name: '@qvac/inference', dependencies: { '@qvac/rag': '^0.9.0', zod: '^4.0.0' }, optionalDependencies: { '@qvac/embed': '^0.53.0' } } },
  { dir: 'packages/sdk', manifest: { name: '@qvac/sdk', dependencies: { '@qvac/inference': '^0.22.0', '@qvac/rag': '^0.9.0' }, devDependencies: { '@qvac/lint-config': '^1.0.0' } } },
  { dir: 'packages/cli', manifest: { name: '@qvac/cli', peerDependencies: { '@qvac/sdk': '^0.22.0' } } },
  { dir: 'packages/rag', manifest: { name: '@qvac/rag' } },
  { dir: 'packages/embed', manifest: { name: '@qvac/embed' } },
  { dir: 'packages/lint-config', manifest: { name: '@qvac/lint-config' } },
  { dir: 'packages/docs', manifest: null },
]

test('finds every workspace directory, the ones the workspace leaves out too', () => {
  const yaml = 'packages:\n  - "packages/*"\n  - "!packages/rag"\n  - packages/registry/client\n  - "plugins/*"\n'
  assert.deepEqual(workspaceDirs(yaml, (parent) => DIRS[parent] ?? []), [
    ...DIRS.packages.map((dir) => `packages/${dir}`),
    'packages/registry/client',
    'plugins/opencode',
  ])
  assert.throws(() => workspaceDirs('packages:\n  - "packages/**"\n', () => []), /"packages\/\*\*" is neither a directory nor <dir>\/\*/)
})

test('installs every workspace dependency outside the train from npm, development ones too', () => {
  assert.deepEqual(outsideTrain(['@qvac/inference', '@qvac/sdk', '@qvac/cli'], PACKAGES), [
    { name: '@qvac/embed', dir: 'packages/embed' },
    { name: '@qvac/lint-config', dir: 'packages/lint-config' },
    { name: '@qvac/rag', dir: 'packages/rag' },
  ])
  assert.deepEqual(outsideTrain(['@qvac/cli'], PACKAGES), [{ name: '@qvac/sdk', dir: 'packages/sdk' }])
})

test('rejects a package name two directories share, and a train package the workspace lacks', () => {
  assert.throws(
    () => outsideTrain(['@qvac/cli'], [...PACKAGES, { dir: 'packages/rag-copy', manifest: { name: '@qvac/rag' } }]),
    /@qvac\/rag is the name of both packages\/rag and packages\/rag-copy/,
  )
  assert.throws(() => outsideTrain(['@qvac/gone'], PACKAGES), /No workspace package is named @qvac\/gone/)
})

test('every train in the repo finds its packages and the ones it installs from npm', () => {
  const catalog = readRepoJson('.github/release-trains.json')
  const nxJson = readRepoJson('nx.json')
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const subdirs = (parent) => readdirSync(join(repoRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const packages = workspaceDirs(workspace, subdirs).map((dir) => {
    const path = join(repoRoot, dir, 'package.json')
    return { dir, manifest: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
  })
  for (const name of Object.keys(catalog)) {
    const outside = outsideTrain(loadTrain(name, catalog, nxJson).projects, packages)
    assert.ok(outside.length > 0, `train '${name}'`)
  }
})

test('leaves a package out of the workspace once, after the other entries', () => {
  const excluded = excludeFromWorkspace(WORKSPACE_YAML, ['packages/sdk'])
  assert.deepEqual(workspaceEntries(excluded), ['packages/*', '!packages/sdk-kotlin', 'plugins/*', '!packages/sdk'])
  assert.ok(excluded.endsWith('linkWorkspacePackages: true\n'))
  assert.equal(excludeFromWorkspace(excluded, ['packages/sdk']), excluded)
})

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

test('refuses to publish the rest of a train from another commit', () => {
  const views = { '@qvac/inference': { found: true, value: OTHER }, '@qvac/sdk': { found: true, value: HEAD } }
  assert.deepEqual(publishedElsewhere(MOVED, (project) => views[project.name] ?? { found: false, value: null }, HEAD), [
    `@qvac/inference@0.22.0 was published from ${OTHER}, not ${HEAD}; cut a new train branch`,
  ])
})

test('treats a version npm has without a gitHead as published elsewhere, and one it does not have as unpublished', () => {
  const views = { '@qvac/inference': { found: true, value: null }, '@qvac/sdk': { found: false, value: null } }
  assert.deepEqual(publishedElsewhere(MOVED, (project) => views[project.name] ?? { found: false, value: null }, HEAD), [
    `@qvac/inference@0.22.0 is on npm without a gitHead, so it was not published from ${HEAD}; cut a new train branch`,
  ])
})

test('reads the published commit from the anchor package, and fails until npm has a commit for it', () => {
  const asked = []
  const gitHeadOf = (view) => (name, version) => {
    asked.push(`${name}@${version}`)
    return view
  }
  assert.equal(publishedCommit(TRAIN, '0.22.0', gitHeadOf({ found: true, value: HEAD })), HEAD)
  assert.equal(publishedCommit(CLI_TRAIN, '0.17.0', gitHeadOf({ found: true, value: HEAD })), HEAD)
  assert.deepEqual(asked, ['@qvac/inference@0.22.0', '@qvac/cli@0.17.0'])
  assert.throws(
    () => publishedCommit(CLI_TRAIN, '0.17.0', gitHeadOf({ found: false, value: null })),
    /@qvac\/cli@0\.17\.0 is not on npm; the train has not published yet/,
  )
  assert.throws(
    () => publishedCommit(CLI_TRAIN, '0.17.0', gitHeadOf({ found: true, value: null })),
    /@qvac\/cli@0\.17\.0 has no commit as its gitHead on npm/,
  )
  assert.throws(
    () => publishedCommit(CLI_TRAIN, '0.17.0', gitHeadOf({ found: true, value: 'refs/heads/main' })),
    /has no commit as its gitHead on npm/,
  )
})

test('tells a version npm does not serve apart from a field it does not have', () => {
  const e404 = JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 0.17.0' } })
  assert.deepEqual(parseNpmView({ status: 1, stdout: e404, stderr: '' }), { found: false, value: null })
  assert.deepEqual(parseNpmView({ status: 0, stdout: '', stderr: '' }), { found: true, value: null })
  assert.deepEqual(parseNpmView({ status: 0, stdout: `"${HEAD}"\n`, stderr: '' }), { found: true, value: HEAD })
  assert.throws(
    () => parseNpmView({ status: 1, stdout: JSON.stringify({ error: { code: 'E503' } }), stderr: 'Service Unavailable' }),
    /exit 1: Service Unavailable/,
  )
  assert.throws(() => parseNpmView({ status: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND' }), /ENOTFOUND/)
})

test('compares sha1 only for the versions this run published', () => {
  const served = { '@qvac/inference': 'aaa', '@qvac/sdk': 'bbb', '@qvac/cli': 'ccc' }
  const built = { '@qvac/inference': 'aaa', '@qvac/sdk': 'xxx', '@qvac/cli': 'yyy' }
  const mismatches = (published) => shasumMismatches(MOVED, published, (project) => served[project.name], (project) => built[project.name])
  assert.deepEqual(mismatches(['@qvac/inference', '@qvac/sdk']), [
    '@qvac/sdk@0.22.0 on npm has sha1 bbb; the built tarball has xxx',
  ])
  assert.deepEqual(mismatches([]), [])
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
  const plan = planTags(moved, { remoteCommit: (tag) => onOrigin[tag] ?? null, gitHeadOf: () => HEAD })
  assert.deepEqual(plan, {
    create: [{ tag: 'inference-v0.21.0', commit: HEAD }, { tag: 'sdk-v0.21.0', commit: HEAD }],
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
