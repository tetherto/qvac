import test from 'node:test'
import assert from 'node:assert/strict'
import { docsPackages, isDocsOnly, isDocsPath } from '../lib/docs-only.mjs'

test('a change under one documentation root is documentation-only', () => {
  assert.equal(isDocsOnly(['packages/sdk/docs/users/ai-capabilities/translation.mdx']), true)
})

test('documentation roots of several packages, generated data and lock included, are documentation-only', () => {
  assert.equal(
    isDocsOnly([
      'packages/sdk/docs/users/index.mdx',
      'packages/sdk/docs/users/_generated/js-api.json',
      'packages/sdk/docs/users/api-bindings.lock.json',
      'packages/cli/docs/users/http-server/index.mdx',
    ]),
    true,
  )
})

test('a mixed change is not documentation-only', () => {
  assert.equal(isDocsOnly(['packages/sdk/docs/users/index.mdx', 'packages/sdk/src/client/api/translate.ts']), false)
})

test('examples, contracts, contributor docs and the site are not documentation', () => {
  for (const path of [
    'packages/sdk/examples/translation/translation-stream.ts',
    'packages/sdk/contract/schema.json',
    'packages/sdk/docs/contributors/system-resources-support-matrix.md',
    'docs/website/versions/sdk.json',
    'packages/sdk/docs/users-old/index.mdx',
  ]) {
    assert.equal(isDocsPath(path), false, path)
  }
})

test('an empty change is not documentation-only', () => {
  assert.equal(isDocsOnly([]), false)
  assert.equal(isDocsOnly(['', '  ']), false)
})

test('names each package whose documentation a change touches', () => {
  assert.deepEqual(
    docsPackages(['packages/cli/docs/users/index.mdx', 'packages/sdk/docs/users/a.mdx', 'packages/sdk/src/x.ts', 'packages/sdk/docs/users/b.mdx']),
    ['cli', 'sdk'],
  )
})
