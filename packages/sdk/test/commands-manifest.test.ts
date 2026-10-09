import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Bundle from 'bare-bundle'
import { buildNestedPathIndex } from '@/commands/bundle/manifest'
import { readBundle } from '@/commands/bundle/read-bundle'

describe('readBundle', () => {
  function sampleBundle() {
    const bundle = new Bundle()
    bundle.write('/index.js', 'module.exports = 1', { main: true })
    bundle.id = 'sample'
    bundle.resolutions = { '/index.js': { '#package': '/package.json' } }
    return bundle
  }

  async function read(contents: string | Buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-read-bundle-'))
    try {
      const file = path.join(dir, 'worker.bundle')
      fs.writeFileSync(file, contents)
      return await readBundle(file)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const [format, wrap] of [
    ['a raw bundle', (data: string) => data],
    ['a CommonJS-wrapped bundle', (data: string) => `module.exports = ${JSON.stringify(data)}\n`],
    ['an ES module-wrapped bundle', (data: string) => `export default ${JSON.stringify(data)}\n`]
  ] as const) {
    it(`reads ${format}`, async () => {
      const bundle = await read(wrap(sampleBundle().toBuffer().toString()))
      assert.equal(bundle.id, 'sample')
      assert.equal(bundle.main, '/index.js')
      assert.deepEqual(bundle.resolutions, { '/index.js': { '#package': '/package.json' } })
    })
  }

  it('rejects a file that is not a bundle', async () => {
    await assert.rejects(() => read('const x = 1'))
  })
})

describe('buildNestedPathIndex', () => {
  const ROOT = '/proj'

  function candidates(index: Map<string, Set<string>>, pkg: string): string[] {
    return [...(index.get(pkg) ?? [])].sort()
  }

  it('maps a single top-level package to the top-level package.json', () => {
    const index = buildNestedPathIndex({ '/node_modules/foo/index.js': {} }, ROOT)
    assert.deepEqual(candidates(index, 'foo'), [
      path.join(ROOT, 'node_modules', 'foo', 'package.json')
    ])
  })

  it('maps a single nested package to the nested package.json', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/parent/node_modules/foo/index.js': {} },
      ROOT
    )
    assert.deepEqual(candidates(index, 'foo'), [
      path.join(ROOT, 'node_modules', 'parent', 'node_modules', 'foo', 'package.json')
    ])
    assert.deepEqual(candidates(index, 'parent'), [
      path.join(ROOT, 'node_modules', 'parent', 'package.json')
    ])
  })

  it('keeps top-level and deeply-nested instances of the same package distinct in a single key', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/foo/node_modules/bar/node_modules/foo/index.js': {} },
      ROOT
    )
    assert.deepEqual(candidates(index, 'foo'), [
      path.join(
        ROOT,
        'node_modules',
        'foo',
        'node_modules',
        'bar',
        'node_modules',
        'foo',
        'package.json'
      ),
      path.join(ROOT, 'node_modules', 'foo', 'package.json')
    ])
    assert.deepEqual(candidates(index, 'bar'), [
      path.join(ROOT, 'node_modules', 'foo', 'node_modules', 'bar', 'package.json')
    ])
  })

  it('handles scoped packages that repeat at different depths', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/@qvac/sdk/node_modules/parent/node_modules/@qvac/sdk/index.js': {} },
      ROOT
    )
    assert.deepEqual(candidates(index, '@qvac/sdk'), [
      path.join(
        ROOT,
        'node_modules',
        '@qvac',
        'sdk',
        'node_modules',
        'parent',
        'node_modules',
        '@qvac',
        'sdk',
        'package.json'
      ),
      path.join(ROOT, 'node_modules', '@qvac', 'sdk', 'package.json')
    ])
  })

  it('aggregates instances across multiple resolution keys', () => {
    const index = buildNestedPathIndex(
      {
        '/node_modules/foo/index.js': {},
        '/node_modules/parent/node_modules/foo/index.js': {}
      },
      ROOT
    )
    assert.deepEqual(candidates(index, 'foo'), [
      path.join(ROOT, 'node_modules', 'foo', 'package.json'),
      path.join(ROOT, 'node_modules', 'parent', 'node_modules', 'foo', 'package.json')
    ])
  })
})
