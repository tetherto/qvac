import { describe, expect, it } from 'vitest'
import { parseVersionsFile } from '../src/lib/versions-file'
import { declaredSoftware, toDocumentedSoftware } from '../src/lib/versions'

/** The versions files are validated before anything reads them. */

const valid = {
  package: '@qvac/sdk',
  kind: 'product',
  path: '/sdk',
  paths: ['packages/sdk/docs/users'],
  lines: [
    { version: 'v0.24', ref: 'release-sdk-0.24.1', sha: 'abc1234' },
    { version: 'v0.23', inPlace: true },
  ],
}

const malformed = (patch: Record<string, unknown>) => () =>
  parseVersionsFile('sdk.json', { ...valid, ...patch })

describe('a versions file', () => {
  it('accepts pinned and in-place lines, newest first', () => {
    expect(parseVersionsFile('sdk.json', valid).lines).toHaveLength(2)
  })

  it('rejects a patch-shaped line and names the file', () => {
    expect(malformed({ lines: [{ version: 'v0.24.1', inPlace: true }] })).toThrow(
      /versions\/sdk\.json is malformed[\s\S]*never a patch/,
    )
  })

  it('rejects lines out of order', () => {
    expect(
      malformed({ lines: [{ version: 'v0.23', inPlace: true }, { version: 'v0.24', inPlace: true }] }),
    ).toThrow(/newest first/)
  })

  it('rejects a duplicate line', () => {
    expect(
      malformed({ lines: [{ version: 'v0.24', inPlace: true }, { version: 'v0.24', inPlace: true }] }),
    ).toThrow(/declared twice/)
  })

  it('rejects a line that is both published and retired', () => {
    expect(malformed({ retired: ['v0.23'] })).toThrow(/both published and retired/)
  })

  it('rejects a pinned line without a commit', () => {
    expect(malformed({ lines: [{ version: 'v0.24', ref: 'release-sdk-0.24.1' }] })).toThrow(/malformed/)
  })

  it('rejects an unknown field', () => {
    expect(malformed({ owner: 'docs' })).toThrow(/malformed/)
  })
})

describe('the manifest derived from it', () => {
  it('makes the first line of a collection current', () => {
    const software = toDocumentedSoftware(parseVersionsFile('sdk.json', valid))
    expect(software.versions.map((entry) => entry.folder)).toEqual(['(v0.24)', 'v0.23'])
  })

  it('makes no line of a package current', () => {
    const software = toDocumentedSoftware(
      parseVersionsFile('demo.json', { ...valid, kind: 'platform', path: '/ecosystem/packages/demo' }),
    )
    expect(software.versions.map((entry) => entry.folder)).toEqual(['v0.24', 'v0.23'])
  })

  it('parses every file shipped under versions/', () => {
    expect(declaredSoftware().map(({ file }) => file).sort()).toEqual(['cli.json', 'sdk.json'])
  })
})
