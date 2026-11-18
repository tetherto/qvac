/**
 * The gate that keeps the version manifest and the content folders in
 * agreement.
 *
 * Two halves. The first exercises the rules against synthetic listings, so
 * every way a cut can go wrong is shown failing, with the message naming the
 * software and the version at fault — the check is only useful if its output
 * points at the edit that was missed. The second runs it against the real
 * content tree, which is what fails the build when someone renames a folder
 * without touching the manifest, or the other way round.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import {
  checkVersionStructure,
  type DirectoryListing,
} from '@/lib/version-structure'
import { DOCUMENTED_SOFTWARE, type DocumentedSoftware } from '@/lib/versions'

const contentRoot = path.resolve(__dirname, '..', 'content', 'docs')

const sdk: DocumentedSoftware = {
  package: '@qvac/sdk',
  kind: 'product',
  path: '/sdk',
  versions: [
    { version: 'v0.17', folder: '(v0.17)' },
    { version: 'v0.16', folder: 'v0.16' },
  ],
}

const platformPackage: DocumentedSoftware = {
  package: '@qvac/translation-nmtcpp',
  kind: 'platform',
  path: '/ecosystem/packages/translation-nmtcpp',
  versions: [
    { version: 'v1.4', folder: '(v1.4)' },
    { version: 'v1.3', folder: 'v1.3' },
  ],
}

function listing(
  directories: string[],
  files: string[] = [],
  symlinks: string[] = [],
): DirectoryListing {
  return { directories, files, symlinks }
}

function check(
  software: DocumentedSoftware,
  entry: DirectoryListing | null,
): string[] {
  return checkVersionStructure(new Map([[software.path, entry]]), [software])
}

describe('version structure check', () => {
  it('accepts a collection cut into its declared lines', () => {
    expect(check(sdk, listing(['(v0.17)', 'v0.16']))).toEqual([])
  })

  it('accepts a package inside Ecosystem cut into its declared lines', () => {
    expect(check(platformPackage, listing(['(v1.4)', 'v1.3']))).toEqual([])
  })

  it('names a declared line whose folder was never created', () => {
    const problems = check(sdk, listing(['(v0.17)']))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.16')
    expect(problems[0]).toContain('does not exist')
  })

  it('names a line folder the manifest does not declare', () => {
    const problems = check(sdk, listing(['(v0.17)', 'v0.16', 'v0.15']))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.15')
    expect(problems[0]).toContain('no manifest entry declares it')
  })

  it('catches the rename half of a cut, where the folder moved and the entry did not', () => {
    const problems = check(sdk, listing(['(v0.18)', 'v0.17']))
    expect(problems.some((problem) => problem.includes('(v0.18)'))).toBe(true)
    expect(problems.some((problem) => problem.includes('v0.16'))).toBe(true)
  })

  it('rejects a collection with no current line', () => {
    const problems = check(sdk, listing(['v0.17', 'v0.16']))
    expect(
      problems.some((problem) => problem.includes('exactly one current line')),
    ).toBe(true)
  })

  it('rejects a collection with two current lines', () => {
    const problems = check(
      { ...sdk, versions: [...sdk.versions, { version: 'v0.16', folder: '(v0.16)' }] },
      listing(['(v0.17)', '(v0.16)', 'v0.16']),
    )
    expect(
      problems.some(
        (problem) =>
          problem.includes('exactly one current line') && problem.includes('found 2'),
      ),
    ).toBe(true)
  })

  it('accepts a third line, because a cut retires nothing', () => {
    expect(
      check(
        { ...sdk, versions: [...sdk.versions, { version: 'v0.15', folder: 'v0.15' }] },
        listing(['(v0.17)', 'v0.16', 'v0.15']),
      ),
    ).toEqual([])
  })

  it('rejects a patch-shaped version folder', () => {
    const problems = check(platformPackage, listing(['(v1.4)', 'v1.3', 'v1.4.1']))
    expect(problems.some((problem) => problem.includes('v1.4.1'))).toBe(true)
    expect(problems.some((problem) => problem.includes('carries a patch'))).toBe(
      true,
    )
  })

  it('rejects a package with no current line, like a collection', () => {
    const problems = check(
      { ...platformPackage, versions: [{ version: 'v1.4', folder: 'v1.4' }] },
      listing(['v1.4']),
    )
    expect(problems.some((problem) => problem.includes('exactly one current line'))).toBe(true)
  })

  it('rejects a page left directly under a versioned collection', () => {
    const problems = check(sdk, listing(['(v0.17)', 'v0.16'], ['quickstart.mdx']))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('quickstart.mdx')
  })

  it('rejects a directory under a versioned collection that is not a line', () => {
    const problems = check(sdk, listing(['(v0.17)', 'v0.16', 'ai-capabilities']))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('ai-capabilities')
  })

  it('rejects a symlinked entry, which the local preview uses and a commit must not', () => {
    // Fumadocs follows the link and builds the development line behind it;
    // every other rule here reads `isDirectory()`, which a link answers
    // `false`, so the line would publish with nothing reporting it.
    const problems = check(sdk, listing(['(v0.17)', 'v0.16'], [], ['v0.18']))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.18')
    expect(problems[0]).toContain('symbolic link')
  })

  it('reports a documented software with no content folder at all', () => {
    const problems = check(sdk, null)
    expect(problems).toEqual(['/sdk: documented but has no content folder'])
  })
})

describe('the manifest against the content tree', () => {
  it('declares exactly the version folders that exist', () => {
    const listings = new Map<string, DirectoryListing | null>()

    for (const software of DOCUMENTED_SOFTWARE) {
      const directory = path.join(contentRoot, software.path.replace(/^\//, ''))
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        listings.set(software.path, null)
        continue
      }
      listings.set(software.path, {
        // A `preview` the materializer wrote for `--include-dev` ignores
        // itself in git and is not a line, so it is left out; a symlinked
        // preview is still reported below.
        directories: entries
          .filter((entry) => entry.isDirectory())
          .filter(
            (entry) =>
              !(entry.name === 'preview' && existsSync(path.join(directory, entry.name, '.materialized'))),
          )
          .map((entry) => entry.name),
        files: entries
          .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
          .map((entry) => entry.name),
        symlinks: entries
          .filter((entry) => entry.isSymbolicLink())
          .map((entry) => entry.name),
      })
    }

    expect(checkVersionStructure(listings)).toEqual([])
  })
})
