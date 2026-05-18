/**
 * Unit tests for the shared helpers consumed by the two release
 * orchestrators (`release-version-minor.ts` and `release-version-patch.ts`).
 *
 * Coverage matrix:
 *   - parseVersion: strict semver parser, accepts `v` prefix.
 *   - sameMinor: tuple comparison.
 *   - readLatestFromVersionsTs: regex-based reader, missing file → null.
 *   - resolveArchivedSibling: picks highest patch per minor, returns
 *     null when nothing matches, ignores other minors.
 */
import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  writeFileSync as _w, // alias to silence "unused" if needed
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseVersion,
  sameMinor,
  readLatestFromVersionsTs,
  resolveArchivedSibling,
} from '../scripts/lib/release-shared'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'qvac-release-shared-'))
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('parses plain semver', () => {
    expect(parseVersion('0.10.2')).toEqual({ major: 0, minor: 10, patch: 2 })
  })

  it('accepts a leading "v"', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('throws on prerelease/build metadata', () => {
    expect(() => parseVersion('1.0.0-beta.1')).toThrow(/Invalid version/)
    expect(() => parseVersion('1.0.0+sha')).toThrow(/Invalid version/)
  })

  it('throws on missing patch component', () => {
    expect(() => parseVersion('1.0')).toThrow(/Invalid version/)
  })

  it('throws on empty string', () => {
    expect(() => parseVersion('')).toThrow(/Invalid version/)
  })
})

// ---------------------------------------------------------------------------
// sameMinor
// ---------------------------------------------------------------------------

describe('sameMinor', () => {
  it('returns true for matching major.minor (any patch)', () => {
    expect(
      sameMinor(
        { major: 0, minor: 10, patch: 2 },
        { major: 0, minor: 10, patch: 0 },
      ),
    ).toBe(true)
  })

  it('returns false when minor differs', () => {
    expect(
      sameMinor(
        { major: 0, minor: 10, patch: 0 },
        { major: 0, minor: 11, patch: 0 },
      ),
    ).toBe(false)
  })

  it('returns false when major differs', () => {
    expect(
      sameMinor(
        { major: 1, minor: 0, patch: 0 },
        { major: 0, minor: 0, patch: 0 },
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readLatestFromVersionsTs
// ---------------------------------------------------------------------------

describe('readLatestFromVersionsTs', () => {
  it('returns the first `latest: vX.Y.Z` literal it sees', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'versions.ts')
    try {
      writeFileSync(
        filePath,
        [
          `export const API_SECTION = {`,
          `  basePath: '/reference/api',`,
          `  latest: 'v0.10.2',`,
          `  versions: [],`,
          `}`,
        ].join('\n'),
      )
      expect(readLatestFromVersionsTs(filePath)).toBe('v0.10.2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the file does not exist', () => {
    expect(readLatestFromVersionsTs('/no/such/file.ts')).toBeNull()
  })

  it('returns null when no `latest: vX.Y.Z` literal is present', () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'versions.ts')
    try {
      writeFileSync(filePath, `export const FOO = 'bar';`)
      expect(readLatestFromVersionsTs(filePath)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// resolveArchivedSibling
// ---------------------------------------------------------------------------

describe('resolveArchivedSibling', () => {
  it('returns the highest patch for the requested minor', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.8.0.mdx'), '')
      writeFileSync(path.join(dir, 'v0.8.1.mdx'), '')
      writeFileSync(path.join(dir, 'v0.8.3.mdx'), '')
      writeFileSync(path.join(dir, 'v0.8.2.mdx'), '')
      const sibling = await resolveArchivedSibling(dir, 0, 8)
      expect(sibling).toBe('v0.8.3.mdx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores siblings from other minors', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.7.5.mdx'), '')
      writeFileSync(path.join(dir, 'v0.9.0.mdx'), '')
      writeFileSync(path.join(dir, 'v1.0.0.mdx'), '')
      const sibling = await resolveArchivedSibling(dir, 0, 8)
      expect(sibling).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the directory does not exist', async () => {
    const sibling = await resolveArchivedSibling('/no/such/dir', 0, 8)
    expect(sibling).toBeNull()
  })

  it('returns null when the directory has no vX.Y.*.mdx files', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'index.mdx'), '')
      writeFileSync(path.join(dir, 'README.md'), '')
      const sibling = await resolveArchivedSibling(dir, 0, 8)
      expect(sibling).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not match malformed names like v0.8.x.mdx or v0.8.mdx', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.8.x.mdx'), '')
      writeFileSync(path.join(dir, 'v0.8.mdx'), '')
      writeFileSync(path.join(dir, 'v0.8.0-rc.1.mdx'), '')
      const sibling = await resolveArchivedSibling(dir, 0, 8)
      expect(sibling).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
