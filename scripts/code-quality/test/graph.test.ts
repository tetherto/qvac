import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalDirectedCycle } from '../fingerprint.js'
import { analyzeWorkspaceCycles } from '../graph.js'

test('workspace manifest analysis finds deterministic package cycles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-workspace-cycle-'))
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n\nminimumReleaseAgeExclude:\n  - "@example/not-a-workspace@1.0.0"\n',
  )
  await writePackage(root, 'packages/a', '@example/a', { '@example/b': '1.0.0' })
  await writePackage(root, 'packages/b', '@example/b', { '@example/c': '1.0.0' })
  await writePackage(root, 'packages/c', '@example/c', { '@example/a': '1.0.0' })
  await writePackage(root, 'packages/unrelated', '@example/unrelated', {})

  const result = await analyzeWorkspaceCycles(root)

  assert.equal(result.diagnostics.length, 0)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0]?.rule, 'package-cycle')
  assert.equal(result.findings[0]?.severity, 'high')
  assert.deepEqual(result.findings[0]?.subject, {
    kind: 'cycle',
    members: ['@example/a', '@example/b', '@example/c'],
  })
})

test('workspace diagnostics do not expose checkout-specific absolute paths', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'quality-workspace-error-a-'))
  const secondRoot = await mkdtemp(join(tmpdir(), 'quality-workspace-error-b-'))

  const first = await analyzeWorkspaceCycles(firstRoot)
  const second = await analyzeWorkspaceCycles(secondRoot)
  const firstMessage = first.diagnostics[0]?.message ?? ''
  const secondMessage = second.diagnostics[0]?.message ?? ''

  assert.equal(firstMessage, secondMessage)
  assert.doesNotMatch(firstMessage, new RegExp(firstRoot))
  assert.doesNotMatch(secondMessage, new RegExp(secondRoot))
  assert.match(firstMessage, /<repository>\/pnpm-workspace\.yaml/)
})

test('directed cycle canonicalization preserves edge direction', () => {
  assert.deepEqual(
    canonicalDirectedCycle(['b', 'c', 'a']),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    canonicalDirectedCycle(['b', 'a', 'c']),
    ['a', 'c', 'b'],
  )
})

async function writePackage(
  root: string,
  directory: string,
  name: string,
  dependencies: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(
    join(root, directory, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', dependencies }, undefined, 2)}\n`,
  )
}
