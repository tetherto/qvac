import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { classifySourceFile, discoverSourceFiles } from '../files.js'

const execFileAsync = promisify(execFile)

test('source discovery includes tracked and untracked sources and excludes generated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-files-'))
  await execFileAsync('git', ['init', '--quiet'], { cwd: root })
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(root, 'third-party'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'ignored.ts\n')
  await writeFile(join(root, 'src', 'tracked.ts'), 'export const tracked = true\n')
  await writeFile(join(root, 'src', 'untracked.tsx'), 'export const untracked = <div />\n')
  await writeFile(join(root, 'src', 'types.d.ts'), 'export interface Value {}\n')
  await writeFile(join(root, 'src', 'client.generated.ts'), 'export const generated = true\n')
  await writeFile(join(root, 'src', 'catalog.ts'), '// THIS FILE IS AUTO-GENERATED\nexport const catalog = []\n')
  await writeFile(join(root, 'dist', 'bundle.js'), 'module.exports = true\n')
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = true\n')
  await writeFile(join(root, 'third-party', 'vendored.js'), 'module.exports = true\n')
  await writeFile(join(root, 'ignored.ts'), 'export const ignored = true\n')
  await execFileAsync(
    'git',
    ['add', '.gitignore', 'src/tracked.ts', 'third-party/vendored.js'],
    { cwd: root },
  )

  assert.deepEqual(await discoverSourceFiles(root), [
    'src/tracked.ts',
    'src/untracked.tsx',
  ])
})

test('source discovery excludes compiled mirrors when the TypeScript source exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-compiled-mirror-'))
  await execFileAsync('git', ['init', '--quiet'], { cwd: root })
  await mkdir(join(root, 'packages/addon/src'), { recursive: true })
  await writeFile(join(root, 'packages/addon/package.json'), '{"name":"addon"}\n')
  await writeFile(join(root, 'packages/addon/index.js'), '"use strict"\nmodule.exports = true\n')
  await writeFile(join(root, 'packages/addon/src/index.ts'), 'export const value = true\n')

  assert.deepEqual(await discoverSourceFiles(root), [
    'packages/addon/src/index.ts',
  ])
})

test('source classification assigns looser thresholds to auxiliary code', () => {
  assert.equal(classifySourceFile('packages/api/src/server.ts'), 'production')
  assert.equal(classifySourceFile('packages/api/test/server.test.ts'), 'auxiliary')
  assert.equal(classifySourceFile('packages/api/src/__tests__/server.ts'), 'auxiliary')
  assert.equal(classifySourceFile('scripts/release.ts'), 'auxiliary')
  assert.equal(classifySourceFile('packages/api/eslint.config.js'), 'auxiliary')
})
