import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPackedString,
  extractBarePackHeader,
  extractPackageNamesFromResolutions
} from '../src/bundle-sdk/manifest.js'

describe('extractPackageNamesFromResolutions', () => {
  it('captures both parent and nested packages', () => {
    const names = extractPackageNamesFromResolutions({
      '/node_modules/@qvac/sdk/node_modules/bare-abort/binding.js': {}
    })
    assert.ok(names.has('@qvac/sdk'))
    assert.ok(names.has('bare-abort'))
    assert.equal(names.size, 2)
  })

  it('captures scoped nested packages', () => {
    const names = extractPackageNamesFromResolutions({
      '/node_modules/@qvac/sdk/node_modules/@qvac/llm-llamacpp/index.js': {}
    })
    assert.deepEqual([...names].sort(), ['@qvac/llm-llamacpp', '@qvac/sdk'])
  })

  it('captures single-level packages', () => {
    const names = extractPackageNamesFromResolutions({
      '/node_modules/mqtt/dist/mqtt.js': {}
    })
    assert.deepEqual([...names], ['mqtt'])
  })

  it('captures three-level nesting', () => {
    const names = extractPackageNamesFromResolutions({
      '/node_modules/@qvac/sdk/node_modules/bare-fs/node_modules/bare-stream/index.js': {}
    })
    assert.deepEqual([...names].sort(), ['@qvac/sdk', 'bare-fs', 'bare-stream'])
  })

  it('ignores paths without node_modules', () => {
    const names = extractPackageNamesFromResolutions({
      '/src/utils/helper.js': {}
    })
    assert.equal(names.size, 0)
  })

  it('deduplicates across multiple resolution keys', () => {
    const names = extractPackageNamesFromResolutions({
      '/node_modules/@qvac/sdk/node_modules/bare-abort/binding.js': {},
      '/node_modules/@qvac/sdk/node_modules/bare-abort/index.js': {},
      '/node_modules/@qvac/sdk/node_modules/bare-os/binding.js': {},
      '/node_modules/@qvac/sdk/dist/constants/audio.js': {},
      '/node_modules/mqtt/dist/mqtt.js': {}
    })
    assert.deepEqual(
      [...names].sort(),
      ['@qvac/sdk', 'bare-abort', 'bare-os', 'mqtt']
    )
  })

  it('old regex (without /g) would miss nested packages', () => {
    const oldRegex = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//
    const key = '/node_modules/@qvac/sdk/node_modules/bare-abort/binding.js'

    const oldMatch = key.match(oldRegex)
    assert.equal(oldMatch?.[1], '@qvac/sdk')

    const names = extractPackageNamesFromResolutions({ [key]: {} })
    assert.ok(names.has('bare-abort'), 'new implementation must capture nested package')
  })
})

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
