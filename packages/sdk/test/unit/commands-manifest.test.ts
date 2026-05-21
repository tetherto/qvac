import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  buildNestedPathIndex,
  extractPackedString,
  extractBarePackHeader
} from "@/commands/bundle/manifest";

describe('extractPackedString', () => {
  it('extracts double-quoted string', () => {
    assert.equal(
      extractPackedString('module.exports = "hello world"'),
      'hello world'
    )
  })

  it('extracts single-quoted string', () => {
    assert.equal(
      extractPackedString("module.exports = 'hello world'"),
      'hello world'
    )
  })

  it('handles escape sequences', () => {
    assert.equal(
      extractPackedString('module.exports = "line1\\nline2\\ttab"'),
      'line1\nline2\ttab'
    )
  })

  it('throws on missing module.exports', () => {
    assert.throws(() => extractPackedString('const x = 1'), /module\.exports/)
  })

  it('throws on non-string export', () => {
    assert.throws(() => extractPackedString('module.exports = 42'), /not a string/)
  })
})

describe('extractBarePackHeader', () => {
  it('extracts JSON header from packed string', () => {
    const header = extractBarePackHeader(
      'some-id\n{"id":"abc","resolutions":{"key":"val"}}\nrest'
    )
    assert.equal(header.id, 'abc')
    assert.deepEqual(header.resolutions, { key: 'val' })
  })

  it('handles nested JSON in header', () => {
    const header = extractBarePackHeader(
      'id\n{"id":"x","resolutions":{"/node_modules/foo/index.js":{"a":1}}}\ndata'
    )
    assert.equal(header.id, 'x')
    assert.ok(header.resolutions)
    assert.ok('/node_modules/foo/index.js' in (header.resolutions as Record<string, unknown>))
  })

  it('throws on missing first newline', () => {
    assert.throws(
      () => extractBarePackHeader('no newline here'),
      /missing first newline/
    )
  })

  it('throws on missing JSON', () => {
    assert.throws(
      () => extractBarePackHeader('id\nno json here'),
      /could not find header JSON/
    )
  })
})

describe('buildNestedPathIndex', () => {
  const ROOT = '/proj'

  function candidates (index: Map<string, Set<string>>, pkg: string): string[] {
    return [...(index.get(pkg) ?? [])].sort()
  }

  it('maps a single top-level package to the top-level package.json', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/foo/index.js': {} },
      ROOT
    )
    assert.deepEqual(
      candidates(index, 'foo'),
      [path.join(ROOT, 'node_modules', 'foo', 'package.json')]
    )
  })

  it('maps a single nested package to the nested package.json', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/parent/node_modules/foo/index.js': {} },
      ROOT
    )
    assert.deepEqual(
      candidates(index, 'foo'),
      [path.join(ROOT, 'node_modules', 'parent', 'node_modules', 'foo', 'package.json')]
    )
    assert.deepEqual(
      candidates(index, 'parent'),
      [path.join(ROOT, 'node_modules', 'parent', 'package.json')]
    )
  })

  it('keeps top-level and deeply-nested instances of the same package distinct in a single key', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/foo/node_modules/bar/node_modules/foo/index.js': {} },
      ROOT
    )
    assert.deepEqual(candidates(index, 'foo'), [
      path.join(ROOT, 'node_modules', 'foo', 'node_modules', 'bar', 'node_modules', 'foo', 'package.json'),
      path.join(ROOT, 'node_modules', 'foo', 'package.json')
    ])
    assert.deepEqual(
      candidates(index, 'bar'),
      [path.join(ROOT, 'node_modules', 'foo', 'node_modules', 'bar', 'package.json')]
    )
  })

  it('handles scoped packages that repeat at different depths', () => {
    const index = buildNestedPathIndex(
      { '/node_modules/@qvac/sdk/node_modules/parent/node_modules/@qvac/sdk/index.js': {} },
      ROOT
    )
    assert.deepEqual(candidates(index, '@qvac/sdk'), [
      path.join(ROOT, 'node_modules', '@qvac', 'sdk', 'node_modules', 'parent', 'node_modules', '@qvac', 'sdk', 'package.json'),
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
