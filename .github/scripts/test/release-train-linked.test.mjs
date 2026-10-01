// The train builds from the workspace, so it can link a sibling it does not
// publish at a version only this checkout has. These lock that the check reads
// pnpm's own resolution rather than re-deriving it from the range.
import test from 'node:test'
import assert from 'node:assert/strict'
import { linkedOutsideTrain, unpublishedLinks } from '../lib/release-train-linked.mjs'

const CATALOG = {
  trains: {
    sdk: {
      anchorGroup: 'engine',
      groups: {
        engine: {
          projectsRelationship: 'fixed',
          projects: [
            { name: '@qvac/inference', slug: 'inference', dir: 'packages/inference' },
            { name: '@qvac/sdk', slug: 'sdk', dir: 'packages/sdk' },
          ],
        },
      },
    },
  },
  nx: { version: {} },
}

const WORKSPACE_VERSIONS = {
  '@qvac/decoder-audio': '0.7.1',
  '@qvac/rag': '0.9.0',
}

function linked(depsByProject) {
  return linkedOutsideTrain(
    'sdk',
    (project) => depsByProject[project.name] ?? [],
    (name) => WORKSPACE_VERSIONS[name],
    CATALOG
  )
}

test('reports a sibling pnpm linked, at the workspace version', () => {
  const result = linked({
    '@qvac/sdk': [{ name: '@qvac/decoder-audio', version: 'link:../decoder-audio', range: '^0.7.0' }],
  })
  assert.deepEqual(result, [
    { name: '@qvac/decoder-audio', version: '0.7.1', range: '^0.7.0', dependents: ['@qvac/sdk'] },
  ])
})

test('ignores a sibling pnpm resolved from the registry', () => {
  // An exact range the workspace copy does not satisfy: pnpm fetches 0.14.0
  // rather than linking 0.14.1, so the build matches what consumers install.
  const result = linked({
    '@qvac/inference': [{ name: '@qvac/model-fit', version: '0.14.0', range: '0.14.0' }],
  })
  assert.deepEqual(result, [])
})

test('ignores the train\'s own packages, which it publishes itself', () => {
  const result = linked({
    '@qvac/sdk': [{ name: '@qvac/inference', version: 'link:../inference', range: '^0.21.0' }],
  })
  assert.deepEqual(result, [])
})

test('collects every dependent of the same sibling, once', () => {
  const result = linked({
    '@qvac/inference': [{ name: '@qvac/rag', version: 'link:../rag', range: '^0.9.0' }],
    '@qvac/sdk': [{ name: '@qvac/rag', version: 'link:../rag', range: '^0.9.0' }],
  })
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].dependents, ['@qvac/inference', '@qvac/sdk'])
})

test('fails only the linked versions npm does not have', () => {
  const all = [
    { name: '@qvac/decoder-audio', version: '0.7.1' },
    { name: '@qvac/rag', version: '0.9.0' },
  ]
  const onNpm = new Set(['@qvac/rag@0.9.0'])
  const missing = unpublishedLinks(all, (name, version) => onNpm.has(`${name}@${version}`))
  assert.deepEqual(missing.map((d) => d.name), ['@qvac/decoder-audio'])
})
