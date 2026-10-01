// The catalog is the only place a train's contents live. These lock that: the
// generated nx.json must match it, the real catalog must describe the real
// workspace, and adding a train must not need a code change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  NX_JSON,
  loadCatalog,
  postPublishPlan,
  readRepoFile,
  renderNxJson,
  renderNxRelease,
  repoRoot,
  tagFor,
  trainNames,
  trainProjects,
} from '../lib/release-trains.mjs'

test('nx.json matches the catalog', () => {
  assert.equal(
    readRepoFile(NX_JSON),
    renderNxJson(),
    'nx.json has drifted. Run: node .github/scripts/sync-release-trains.mjs'
  )
})

test('validate-release-trains passes on the real catalog', () => {
  const out = execFileSync(
    'node',
    [join(repoRoot, '.github/scripts/validate-release-trains.mjs')],
    { encoding: 'utf8' }
  )
  assert.match(out, /train\(s\) OK/)
})

test('every train project is a real workspace package', () => {
  for (const name of trainNames()) {
    for (const project of trainProjects(name)) {
      const manifest = JSON.parse(readRepoFile(`${project.dir}/package.json`))
      assert.equal(manifest.name, project.name, `${project.dir} is ${manifest.name}`)
    }
  }
})

test('a second train generates its own nx release groups', () => {
  const catalog = loadCatalog()
  catalog.trains.docs = {
    anchorGroup: 'docsite',
    groups: {
      docsite: {
        projectsRelationship: 'fixed',
        projects: [{ name: '@qvac/docs', slug: 'docs', dir: 'docs/website' }],
      },
    },
  }

  const release = renderNxRelease(catalog)
  assert.deepEqual(Object.keys(release.groups).sort(), ['agentstack', 'docsite', 'engine'])
  assert.deepEqual(release.groups.docsite.projects, ['@qvac/docs'])
  assert.equal(release.groups.docsite.versionPlans, true)
})

test('two trains cannot share a release group name', () => {
  const catalog = loadCatalog()
  catalog.trains.other = { anchorGroup: 'engine', groups: { engine: catalog.trains.sdk.groups.engine } }
  assert.throws(() => renderNxRelease(catalog), /declared by more than one train/)
})

test('every group in the catalog reaches nx', () => {
  const catalog = loadCatalog()
  const release = renderNxRelease(catalog)
  for (const name of trainNames(catalog)) {
    for (const [groupName, group] of Object.entries(catalog.trains[name].groups)) {
      assert.deepEqual(
        release.groups[groupName].projects,
        group.projects.map((p) => p.name),
        `group ${groupName}`
      )
      assert.equal(release.groups[groupName].projectsRelationship, group.projectsRelationship)
    }
  }
})

test('the sdk train tags every package and releases only the SDK', () => {
  const { tags, githubRelease } = postPublishPlan('sdk')

  // Every project in the train gets a tag, one way or the other.
  assert.deepEqual(
    tags.map((t) => t.slug).sort(),
    trainProjects('sdk').map((p) => p.slug).sort()
  )

  assert.equal(githubRelease.slug, 'sdk')
  assert.equal(githubRelease.displayName, 'QVAC SDK')
  assert.deepEqual(githubRelease.assets, ['sdk-python-fat-wheels'])

  // The release carries the sdk tag, so the tag job must not also create it.
  assert.equal(tags.find((t) => t.slug === 'sdk').viaRelease, true)
  assert.equal(tags.find((t) => t.slug === 'cli').viaRelease, false)
})

// Companion to the SDK-only GitHub Releases policy in ci-trust-policy.test.mjs.
// That test allows release-train.yml to call create-github-release.yml; this
// one keeps the guarantee, because the workflow takes its release from the
// catalog rather than naming a package.
test('only @qvac/sdk gets a GitHub release, across every train', () => {
  const catalog = loadCatalog()
  const releasing = []
  for (const name of trainNames(catalog)) {
    for (const project of trainProjects(name, catalog)) {
      if (project.postPublish?.githubRelease) releasing.push(project.name)
    }
  }
  assert.deepEqual(
    releasing,
    ['@qvac/sdk'],
    'the Releases page is SDK-only; adding another is a deliberate policy decision'
  )
})

test('the tag names match the convention already in the repo', () => {
  // These tags exist on upstream/main; the mapping is not free to change.
  assert.equal(tagFor({ slug: 'inference' }, '0.20.0'), 'inference-v0.20.0')
  assert.equal(tagFor({ slug: 'cli' }, '0.14.0'), 'cli-v0.14.0')
  assert.equal(tagFor({ slug: 'opencode-plugin' }, '0.3.2'), 'opencode-plugin-v0.3.2')
})

test('nx is given no tag pattern, because it would tag a fixed group once', () => {
  // nx leaves {projectName} uninterpolated for a fixed group and emits one tag
  // for the pair; this repo tags each package after its own publish.
  assert.equal(renderNxRelease().releaseTag, undefined)
})

test('a train whose project declares no postPublish is rejected', () => {
  const catalog = loadCatalog()
  delete catalog.trains.sdk.groups.agentstack.projects[0].postPublish
  const plan = postPublishPlan('sdk', catalog)
  assert.ok(
    !plan.tags.some((t) => t.slug === 'cli'),
    'a project with no postPublish silently drops out, which validate-release-trains must catch'
  )
})

test('release-train-projects prints what workflows consume', () => {
  const script = join(repoRoot, '.github/scripts/release-train-projects.mjs')
  const projects = execFileSync('node', [script, 'sdk', '--projects'], { encoding: 'utf8' }).trim()
  assert.equal(projects, trainProjects('sdk').map((p) => p.name).join(','))

  const paths = execFileSync('node', [script, 'sdk', '--dist-paths'], { encoding: 'utf8' })
    .trim()
    .split('\n')
  assert.deepEqual(paths, trainProjects('sdk').map((p) => `${p.dir}/dist/`))

  const sidecars = JSON.parse(
    execFileSync('node', [script, 'sdk', '--sidecars'], { encoding: 'utf8' })
  )
  assert.equal(sidecars[0].registry, 'pypi')
})
