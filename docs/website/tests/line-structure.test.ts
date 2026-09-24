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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  checkIndexVersions,
  checkVersionStructure,
  type DirectoryListing,
} from '@/lib/version-structure'
import { DOCUMENTED_SOFTWARE, type DocumentedSoftware } from '@/lib/versions'

const contentRoot = path.resolve(__dirname, '..', 'content', 'docs')

const sdk: DocumentedSoftware = {
  package: '@qvac/sdk',
  kind: 'collection',
  path: '/sdk',
  versions: [
    { version: 'v0.17', folder: '(v0.17)' },
    { version: 'v0.16', folder: 'v0.16' },
  ],
}

const cliPackage: DocumentedSoftware = {
  package: '@qvac/cli',
  kind: 'package',
  path: '/ecosystem/inventory/cli',
  versions: [
    { version: 'v0.9', folder: 'v0.9' },
    { version: 'v0.8', folder: 'v0.8' },
  ],
}

function listing(
  directories: string[],
  files: string[] = [],
): DirectoryListing {
  return { directories, files }
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

  it('accepts a package whose versions are all explicit', () => {
    expect(check(cliPackage, listing(['v0.9', 'v0.8']))).toEqual([])
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

  it('accepts a package carrying more than two versions, which is a catalogue', () => {
    expect(
      check(
        {
          ...cliPackage,
          versions: [...cliPackage.versions, { version: 'v0.7', folder: 'v0.7' }],
        },
        listing(['v0.9', 'v0.8', 'v0.7']),
      ),
    ).toEqual([])
  })

  it('rejects a patch-shaped version folder', () => {
    const problems = check(cliPackage, listing(['v0.9', 'v0.8', 'v0.9.1']))
    expect(problems.some((problem) => problem.includes('v0.9.1'))).toBe(true)
    expect(problems.some((problem) => problem.includes('carries a patch'))).toBe(
      true,
    )
  })

  it('rejects a folder group in the inventory, where the version-less path is the index', () => {
    const problems = check(
      { ...cliPackage, versions: [{ version: 'v0.9', folder: '(v0.9)' }] },
      listing(['(v0.9)']),
    )
    expect(
      problems.some((problem) => problem.includes('an inventory package may not use')),
    ).toBe(true)
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

  it('reports a documented software with no content folder at all', () => {
    const problems = check(sdk, null)
    expect(problems).toEqual(['/sdk: documented but has no content folder'])
  })
})

describe('package index against the manifest', () => {
  const index = (versions: string[]) =>
    new Map([
      [
        cliPackage.path,
        versions
          .map((version) => `- [${version}](${cliPackage.path}/${version}/)`)
          .join('\n'),
      ],
    ])

  it('accepts an index linking exactly the declared versions', () => {
    expect(checkIndexVersions(index(['v0.9', 'v0.8']), [cliPackage])).toEqual([])
  })

  it('accepts the slash-less form of the same link', () => {
    const text = new Map([
      [cliPackage.path, `[v0.9](${cliPackage.path}/v0.9) [v0.8](${cliPackage.path}/v0.8)`],
    ])
    expect(checkIndexVersions(text, [cliPackage])).toEqual([])
  })

  it('names a declared version the index forgot', () => {
    const problems = checkIndexVersions(index(['v0.9']), [cliPackage])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.8')
    expect(problems[0]).toContain('does not link it')
  })

  it('names a version the index links and the manifest does not declare', () => {
    const problems = checkIndexVersions(index(['v0.9', 'v0.8', 'v0.7']), [cliPackage])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('v0.7')
    expect(problems[0]).toContain('no manifest entry declares')
  })

  it('reports a package with no index at all', () => {
    const problems = checkIndexVersions(new Map([[cliPackage.path, null]]), [
      cliPackage,
    ])
    expect(problems).toEqual([
      `${cliPackage.path}: has no index page, so its versions cannot be reached`,
    ])
  })

  it('skips a collection, which is entered through the switcher', () => {
    expect(checkIndexVersions(new Map(), [sdk])).toEqual([])
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
        directories: entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
        files: entries
          .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
          .map((entry) => entry.name),
      })
    }

    expect(checkVersionStructure(listings)).toEqual([])
  })

  it('links from every package index exactly the versions declared', () => {
    const indexes = new Map<string, string | null>()

    for (const software of DOCUMENTED_SOFTWARE) {
      if (software.kind !== 'package') continue
      const directory = path.join(contentRoot, software.path.replace(/^\//, ''))
      const found = ['index.mdx', 'index.md']
        .map((name) => path.join(directory, name))
        .find((file) => existsSync(file))
      indexes.set(software.path, found ? readFileSync(found, 'utf8') : null)
    }

    expect(checkIndexVersions(indexes)).toEqual([])
  })
})
