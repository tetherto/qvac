import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('a file moved from a package into its documentation root is not documentation-only', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs-only.mjs')
  const repo = mkdtempSync(join(tmpdir(), 'docs-only-'))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf-8' }).trim()
  try {
    git('init', '--quiet')
    mkdirSync(join(repo, 'packages/sdk/src'), { recursive: true })
    writeFileSync(join(repo, 'packages/sdk/src/guide.md'), 'A file shipped with the package.\n'.repeat(20))
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    mkdirSync(join(repo, 'packages/sdk/docs/users'), { recursive: true })
    git('mv', 'packages/sdk/src/guide.md', 'packages/sdk/docs/users/guide.md')
    git('commit', '--quiet', '-m', 'move')
    const head = git('rev-parse', 'HEAD')

    const env = { ...process.env }
    delete env.GITHUB_OUTPUT
    const output = execFileSync('node', [script, base, head], { cwd: repo, encoding: 'utf-8', env })
    assert.match(output, /^Not documentation-only: 2 changed path\(s\)/)
    assert.match(output, /packages\/sdk\/src\/guide\.md/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
