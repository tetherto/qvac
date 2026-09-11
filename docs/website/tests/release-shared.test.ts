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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseVersion,
  readFrontmatterField,
  rewriteFrontmatterDescriptionLine,
  sameMinor,
  readLatestFromVersionsTs,
  resolveArchivedSibling,
  resolveSeriesSibling,
  seriesName,
  seriesFileName,
  writeLatestSeriesAliasRedirects,
  writeShim,
  REDIRECTS_FILE,
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

describe('resolveArchivedSibling (legacy, deprecated)', () => {
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

  it('does not match series names like v0.8.x.mdx or v0.8.mdx (legacy lookup is full-semver-only)', async () => {
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

// ---------------------------------------------------------------------------
// seriesName / seriesFileName — series-based naming helpers
// ---------------------------------------------------------------------------

describe('seriesName', () => {
  it('formats series as vX.Y.x (literal "x")', () => {
    expect(seriesName({ major: 0, minor: 11 })).toBe('v0.11.x')
    expect(seriesName({ major: 1, minor: 2 })).toBe('v1.2.x')
  })

  it('does not depend on the patch number (works with full SemVer too)', () => {
    expect(seriesName({ major: 0, minor: 11, patch: 3 } as never)).toBe('v0.11.x')
  })
})

describe('seriesFileName', () => {
  it('returns vX.Y.x.mdx', () => {
    expect(seriesFileName(0, 11)).toBe('v0.11.x.mdx')
    expect(seriesFileName(2, 0)).toBe('v2.0.x.mdx')
  })
})

// ---------------------------------------------------------------------------
// resolveSeriesSibling — series-based lookup with legacy fallback
// ---------------------------------------------------------------------------

describe('resolveSeriesSibling', () => {
  it('returns the series file name when v<X.Y>.x.mdx exists', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.11.x.mdx'), '')
      const sibling = await resolveSeriesSibling(dir, 0, 11)
      expect(sibling).toBe('v0.11.x.mdx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the highest full-semver patch when series file is missing (migration shim)', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.9.0.mdx'), '')
      writeFileSync(path.join(dir, 'v0.9.1.mdx'), '')
      const sibling = await resolveSeriesSibling(dir, 0, 9)
      expect(sibling).toBe('v0.9.1.mdx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the series file over the legacy full-semver siblings when both exist', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.9.0.mdx'), '')
      writeFileSync(path.join(dir, 'v0.9.x.mdx'), '')
      const sibling = await resolveSeriesSibling(dir, 0, 9)
      expect(sibling).toBe('v0.9.x.mdx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when nothing matches', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'v0.7.5.mdx'), '')
      const sibling = await resolveSeriesSibling(dir, 0, 9)
      expect(sibling).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the directory does not exist', async () => {
    expect(await resolveSeriesSibling('/no/such/dir', 0, 9)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// writeShim — atomic shim template writer for section index.mdx
// ---------------------------------------------------------------------------

describe('writeShim', () => {
  it('writes a minimal shim with frontmatter + <include> pointing at the given series file', async () => {
    const dir = makeTempDir()
    try {
      await writeShim(
        dir,
        'v0.18.x.mdx',
        'SDK Release Notes — v0.18.x (latest)',
        'Release notes for QVAC SDK v0.18.0.',
      )
      const content = readFileSync(path.join(dir, 'index.mdx'), 'utf-8')
      expect(content).toBe(
        '---\n' +
          'title: SDK Release Notes — v0.18.x (latest)\n' +
          'description: Release notes for QVAC SDK v0.18.0.\n' +
          '---\n' +
          '\n' +
          '<include>./v0.18.x.mdx</include>\n',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('overwrites an existing index.mdx (used by minor rotation)', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(path.join(dir, 'index.mdx'), 'stale content\n')
      await writeShim(dir, 'v0.19.x.mdx', 'title-x', 'desc-x')
      const content = readFileSync(path.join(dir, 'index.mdx'), 'utf-8')
      expect(content).toContain('<include>./v0.19.x.mdx</include>')
      expect(content).not.toContain('stale content')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// readFrontmatterField / rewriteFrontmatterDescriptionLine
// ---------------------------------------------------------------------------

describe('readFrontmatterField', () => {
  it('returns the trimmed value of a scalar field', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'sample.mdx')
      writeFileSync(
        file,
        [
          '---',
          'title: Some Title',
          'description: Lists all releases from v0.18.0 to v0.18.2.',
          '---',
          '',
          'body',
        ].join('\n'),
      )
      expect(await readFrontmatterField(file, 'title')).toBe('Some Title')
      expect(await readFrontmatterField(file, 'description')).toBe(
        'Lists all releases from v0.18.0 to v0.18.2.',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the field is absent', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'sample.mdx')
      writeFileSync(file, ['---', 'title: T', '---', '', 'body'].join('\n'))
      expect(await readFrontmatterField(file, 'description')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rewriteFrontmatterDescriptionLine', () => {
  it('rewrites an existing description line, preserves title + body', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'sample.mdx')
      writeFileSync(
        file,
        [
          '---',
          'title: T',
          'description: OLD',
          '---',
          '',
          '## Heading',
          'body text',
        ].join('\n'),
      )
      await rewriteFrontmatterDescriptionLine(file, 'NEW')
      const updated = readFileSync(file, 'utf-8')
      expect(updated).toContain('description: NEW')
      expect(updated).not.toContain('description: OLD')
      expect(updated).toContain('title: T')
      expect(updated).toContain('## Heading')
      expect(updated).toContain('body text')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('injects a description line right after title: when absent', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, 'sample.mdx')
      writeFileSync(file, ['---', 'title: T', '---', '', 'body'].join('\n'))
      await rewriteFrontmatterDescriptionLine(file, 'NEW')
      const updated = readFileSync(file, 'utf-8')
      expect(updated).toMatch(/title: T\ndescription: NEW\n---/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// writeLatestSeriesAliasRedirects — managed block replacement in _redirects
// ---------------------------------------------------------------------------

describe('writeLatestSeriesAliasRedirects', () => {
  const BEGIN = '# ==== BEGIN latest-series alias (managed) ===='
  const END = '# ==== END latest-series alias (managed) ===='

  it('replaces the body between BEGIN/END markers, preserves surrounding content', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, '_redirects')
      writeFileSync(
        file,
        [
          '# top of file (preserved)',
          BEGIN,
          '/reference/api/v0.17.x/             /reference/api/               301',
          '/reference/api/v0.17.x              /reference/api/               301',
          '/reference/release-notes/v0.17.x/   /reference/release-notes/     301',
          '/reference/release-notes/v0.17.x    /reference/release-notes/     301',
          END,
          '# bottom of file (preserved)',
          '',
        ].join('\n'),
      )
      await writeLatestSeriesAliasRedirects('v0.18.x', file)
      const updated = readFileSync(file, 'utf-8')
      expect(updated).toContain('# top of file (preserved)')
      expect(updated).toContain('# bottom of file (preserved)')
      expect(updated).toContain('/reference/api/v0.18.x/             /reference/api/')
      expect(updated).toContain('/reference/release-notes/v0.18.x    /reference/release-notes/')
      // Outgoing series must be fully gone from the managed block.
      expect(updated).not.toContain('v0.17.x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws with a clear error when the markers are missing', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, '_redirects')
      writeFileSync(file, '# no markers here\n')
      await expect(
        writeLatestSeriesAliasRedirects('v0.18.x', file),
      ).rejects.toThrow(/Managed latest-series alias block not found/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('produces stable output across two consecutive rotations to the same series (idempotent)', async () => {
    const dir = makeTempDir()
    try {
      const file = path.join(dir, '_redirects')
      writeFileSync(file, [BEGIN, 'placeholder', END, ''].join('\n'))
      await writeLatestSeriesAliasRedirects('v0.20.x', file)
      const first = readFileSync(file, 'utf-8')
      await writeLatestSeriesAliasRedirects('v0.20.x', file)
      const second = readFileSync(file, 'utf-8')
      expect(second).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
